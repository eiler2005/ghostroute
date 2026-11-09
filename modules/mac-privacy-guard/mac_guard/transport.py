"""There is deliberately no unbound DIRECT adapter or environment-proxy fallback."""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import ipaddress
import json
import socket
import ssl
import sys
import time
from urllib.parse import urlencode, urlsplit

from .policy import GuardError, public_host

TIMEOUT = 8
MAX_BODY = 65536


def read_headers(connection: socket.socket) -> bytes:
    # Reading one byte avoids discarding the first bytes of a tunnel stream.
    data = bytearray()
    deadline = time.monotonic() + TIMEOUT
    while not data.endswith(b"\r\n\r\n"):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise GuardError("Прокси не завершил ответ вовремя")
        connection.settimeout(remaining)
        part = connection.recv(1)
        if not part or len(data) >= 16384:
            raise GuardError("Некорректный ответ защищённого прокси")
        data.extend(part)
    return bytes(data)


class HTTPSProxy:
    def __init__(self, config: dict):
        self.config = config
        self.context = ssl.create_default_context()
        if config.get("certificate_sha256"):
            # An independently supplied exact pin is the trust anchor, not TOFU.
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE

    def connect(self, host: str, port: int) -> socket.socket:
        raw = None
        try:
            raw = socket.create_connection((self.config["host"], self.config["port"]), TIMEOUT)
            raw = self.context.wrap_socket(raw, server_hostname=self.config["server_name"])
            pin = self.config.get("certificate_sha256")
            if pin and not hmac.compare_digest(hashlib.sha256(raw.getpeercert(binary_form=True)).hexdigest(), pin.lower()):
                raise GuardError("Сертификат прокси не совпал с доверенным отпечатком")
            credential = base64.b64encode((self.config["username"] + ":" + self.config["password"]).encode()).decode()
            target = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
            request = f"CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: Basic {credential}\r\n\r\n"
            raw.sendall(request.encode("ascii"))
            header = read_headers(raw)
            parts = header.split(b"\r\n", 1)[0].split()
            if len(parts) < 2 or parts[0] not in (b"HTTP/1.1", b"HTTP/1.0") or parts[1] != b"200":
                raise GuardError("Защищённый прокси отказал в соединении")
            return raw
        except (OSError, ValueError, ssl.SSLError):
            if raw:
                raw.close()
            raise GuardError("Защищённый прокси недоступен или не прошёл TLS-проверку") from None
        except Exception:
            if raw:
                raw.close()
            raise


class BoundVPN:
    """Every DNS and destination socket is kernel-bound to one qualified utun."""

    def __init__(self, config: dict):
        if sys.platform != "darwin":
            raise GuardError("Привязка к VPN-интерфейсу поддерживается только на macOS")
        self.config = config
        try:
            self.index = socket.if_nametoindex(config["interface"])
        except OSError:
            raise GuardError("Выбранный VPN-интерфейс отсутствует") from None
        self.context = ssl.create_default_context()

    def _socket(self, address: str, port: int) -> socket.socket:
        connection = None
        try:
            if socket.if_nametoindex(self.config["interface"]) != self.index:
                raise GuardError("VPN-интерфейс изменился; требуется новая проверка")
            ip = ipaddress.ip_address(address)
            connection = socket.socket(socket.AF_INET6 if ip.version == 6 else socket.AF_INET, socket.SOCK_STREAM)
            connection.settimeout(TIMEOUT)
            # Apple SDK netinet/in.h and netinet6/in6.h. No unbound retry.
            level, option = (socket.IPPROTO_IPV6, 125) if ip.version == 6 else (socket.IPPROTO_IP, 25)
            connection.setsockopt(level, option, self.index)
            connection.connect((address, port))
            return connection
        except (OSError, ValueError):
            if connection:
                connection.close()
            raise GuardError("Соединение через выбранный VPN заблокировано") from None
        except Exception:
            if connection:
                connection.close()
            raise

    def _resolve(self, host: str) -> list[str]:
        try:
            return [str(ipaddress.ip_address(host))]
        except ValueError:
            pass
        # A public resolver bootstrap IP, not a deployment endpoint. DNS remains
        # inside the selected tunnel; never invoke getaddrinfo for the target.
        raw = self._socket("1.1.1.1", 443)
        try:
            with self.context.wrap_socket(raw, server_hostname="cloudflare-dns.com") as secure:
                path = "/dns-query?" + urlencode({"name": host, "type": "A"})
                secure.sendall((f"GET {path} HTTP/1.1\r\nHost: cloudflare-dns.com\r\nAccept: application/dns-json\r\nConnection: close\r\n\r\n").encode("ascii"))
                response = http.client.HTTPResponse(secure)
                response.begin()
                body = response.read(MAX_BODY + 1)
                if response.status != 200 or len(body) > MAX_BODY:
                    raise GuardError("Не удалось получить DNS через VPN")
                data = json.loads(body)
                if data.get("Status") != 0:
                    raise GuardError("DNS через VPN не разрешил назначение")
                addresses = [public_host(row["data"]) for row in data.get("Answer", []) if row.get("type") == 1]
                if not addresses or len(addresses) > 16 or not all(ipaddress.ip_address(x).version == 4 for x in addresses):
                    raise GuardError("Некорректный DNS-ответ через VPN")
                return addresses
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            raise GuardError("Не удалось проверить DNS через VPN") from None
        finally:
            raw.close()

    def connect(self, host: str, port: int) -> socket.socket:
        public_host(host)
        addresses = self._resolve(host)
        # A failure stays closed. Do not retry through system DNS or main route.
        return self._socket(addresses[0], port)


def make_adapter(config: dict):
    return HTTPSProxy(config) if config["kind"] == "https_proxy" else BoundVPN(config)


def qualify(adapter, route: dict) -> None:
    """An authenticated, complete HTTPS response must match the approved exit."""
    parsed = urlsplit(route["probe_url"])
    raw = None
    try:
        raw = adapter.connect(parsed.hostname, 443)
        # HTTPS over an HTTPS CONNECT socket needs TLS-in-TLS. http.client and
        # SSLSocket.wrap_socket would bypass the outer TLS; use MemoryBIO below.
        stream = TLSStream(raw, parsed.hostname)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        stream.sendall((f"GET {path} HTTP/1.1\r\nHost: {parsed.hostname}\r\nConnection: close\r\n\r\n").encode("ascii"))
        response = http.client.HTTPResponse(stream)
        response.begin()
        body = response.read(MAX_BODY + 1)
        if response.status != 200 or len(body) > MAX_BODY:
            raise GuardError("Проверка выхода не завершилась успешно")
        value = body.decode('ascii').strip()
        if route.get('probe_format') == 'cloudflare_trace':
            values = [line[3:] for line in value.splitlines() if line.startswith('ip=')]
            if len(values) != 1:
                raise GuardError('Проверка не вернула единственный IP выхода')
            value = values[0]
        observed = str(ipaddress.ip_address(value))
        if observed not in route["approved_exit_ips"]:
            raise GuardError("Выход не совпал с заранее разрешённым")
    except GuardError:
        raise
    except (OSError, ValueError, ssl.SSLError, http.client.HTTPException):
        raise GuardError("Не удалось подтвердить защищённый выход") from None
    finally:
        if raw:
            raw.close()


class TLSStream:
    """Minimal blocking TLS client over any ordered socket, including TLS."""

    def __init__(self, raw, host, context=None):
        self.raw = raw
        self.deadline = time.monotonic() + 20
        self.incoming, self.outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        self.tls = (context or ssl.create_default_context()).wrap_bio(self.incoming, self.outgoing, server_hostname=host)
        self._call(self.tls.do_handshake)

    def _flush(self):
        while self.outgoing.pending:
            self.raw.sendall(self.outgoing.read())

    def _call(self, operation, *args):
        while True:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise GuardError("Проверка HTTPS превысила время ожидания")
            self.raw.settimeout(min(TIMEOUT, remaining))
            try:
                result = operation(*args)
                self._flush()
                return result
            except ssl.SSLWantWriteError:
                self._flush()
            except ssl.SSLWantReadError:
                self._flush()
                data = self.raw.recv(16384)
                if not data:
                    self.incoming.write_eof()
                else:
                    self.incoming.write(data)

    def sendall(self, data):
        while data:
            count = self._call(self.tls.write, data)
            data = data[count:]

    def recv(self, size):
        try:
            return self._call(self.tls.read, size)
        except ssl.SSLZeroReturnError:
            return b""

    def makefile(self, mode, buffering=None):
        import io
        stream = self

        class Reader(io.RawIOBase):
            def readable(self):
                return True

            def readinto(self, buffer):
                data = stream.recv(len(buffer))
                buffer[:len(data)] = data
                return len(data)

        return io.BufferedReader(Reader())
