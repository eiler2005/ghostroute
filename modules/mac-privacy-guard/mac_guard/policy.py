"""Small, strict configuration boundary. Real profiles never belong in Git."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import stat
import tempfile
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit


class GuardError(Exception):
    """Safe operator-facing error; never include upstream exceptions or secrets."""


def hostname(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 253:
        raise GuardError("Некорректное имя назначения")
    if any(c in value for c in "\r\n\t /\\@%#?:[]"):
        raise GuardError("Некорректное имя назначения")
    try:
        result = value.rstrip(".").encode("idna").decode("ascii").lower()
    except UnicodeError:
        raise GuardError("Некорректное имя назначения") from None
    if not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", x) for x in result.split(".")):
        raise GuardError("Некорректное имя назначения")
    return result


def public_host(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        host = hostname(value)
        if "." not in host or host.endswith((".localhost", ".local", ".internal", ".home", ".arpa")):
            raise GuardError("Локальные назначения закрыты")
        # Browser parsers accept unusual IPv4 spellings. Never forward those.
        if re.fullmatch(r"[0-9.]+", host) or any(part.startswith("0x") for part in host.split(".")):
            raise GuardError("Неоднозначный IP-адрес закрыт")
        return host
    if not address.is_global or address.is_multicast:
        raise GuardError("Локальные назначения закрыты")
    return str(address)


def authority(value: str) -> tuple[str, int]:
    if not isinstance(value, str) or any(c.isspace() for c in value) or any(c in value for c in "/\\@#%?"):
        raise GuardError("Некорректное назначение CONNECT")
    try:
        parsed = urlsplit("//" + value)
        host, port = parsed.hostname, parsed.port
    except ValueError:
        raise GuardError("Некорректное назначение CONNECT") from None
    if not host or port != 443:
        raise GuardError("Разрешён только HTTPS")
    return public_host(host), port


def browser_url(value: str) -> str:
    if not isinstance(value, str) or any(ord(c) < 32 for c in value):
        raise GuardError("Некорректный адрес сайта")
    value = value.strip()
    if "://" not in value:
        value = "https://" + value
    try:
        parsed = urlsplit(value)
        if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise ValueError()
        host = public_host(parsed.hostname or "")
    except (ValueError, GuardError):
        raise GuardError("Введите HTTPS-адрес публичного сайта без логина в URL") from None
    if len(value) > 8192 or any(ord(c) < 32 for c in value) or "\\" in value:
        raise GuardError("Некорректный адрес сайта")
    netloc = f'[{host}]' if ':' in host else host
    return urlunsplit(('https', netloc, quote(parsed.path, safe='/%:@!$&\'()*+,;=-._~'),
                       quote(parsed.query, safe='/?%:@!$&\'()*+,;=-._~'), quote(parsed.fragment, safe='/%-._~')))


def domains_from_text(text: str) -> list[str]:
    values = []
    for line in text.splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            values.append(hostname(line.removeprefix("*.")))
    return sorted(set(values))


def matches(host: str, domains: list[str]) -> bool:
    return any(host == domain or host.endswith("." + domain) for domain in domains)


def private_dir(path: Path) -> None:
    if path.is_symlink():
        raise GuardError("Каталог состояния не должен быть символической ссылкой")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.stat().st_uid != os.getuid():
        raise GuardError("Неверный владелец каталога состояния")
    path.chmod(0o700)


def write_private(path: Path, data: bytes) -> None:
    private_dir(path.parent)
    if path.is_symlink():
        raise GuardError("Файл состояния не должен быть символической ссылкой")
    fd, temporary = tempfile.mkstemp(prefix=".guard-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_private(path: Path) -> dict:
    if path.is_symlink():
        raise GuardError("Профиль не должен быть символической ссылкой")
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise GuardError("Приватному профилю нужны права 600 и текущий владелец")
    if info.st_size > 131072:
        raise GuardError("Профиль слишком большой")
    try:
        return validate_config(json.loads(path.read_text()))
    except (ValueError, TypeError, KeyError):
        raise GuardError("Не удалось прочитать профиль") from None


def validate_config(data: dict) -> dict:
    if not isinstance(data, dict) or set(data) != {"schema_version", "routes", "sensitive_domains"} or data["schema_version"] != 1:
        raise GuardError("Неподдерживаемый формат профиля")
    domains = data["sensitive_domains"]
    if not isinstance(domains, list) or not domains or len(domains) > 2000:
        raise GuardError("Нужен непустой каталог чувствительных доменов")
    domains = sorted(set(hostname(x) for x in domains))
    routes = data["routes"]
    if not isinstance(routes, list) or not 1 <= len(routes) <= 8:
        raise GuardError("Укажите от одного до восьми маршрутов")
    normalized, ids = [], set()
    for original in routes:
        if not isinstance(original, dict):
            raise GuardError("Некорректный маршрут")
        route = dict(original)
        kind = route.get("kind")
        common = {"id", "kind", "allowed_domains", "probe_url", "probe_format", "approved_exit_ips"}
        extra = {"host", "port", "server_name", "username", "password", "certificate_sha256"} if kind == "https_proxy" else {"interface"}
        if kind not in ("https_proxy", "bound_vpn") or set(route) - common - extra:
            raise GuardError("Неподдерживаемый тип или поле маршрута")
        route_id = route.get("id", "")
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", route_id) or route_id in ids:
            raise GuardError("Идентификаторы маршрутов должны быть уникальными")
        ids.add(route_id)
        allowed = route.get("allowed_domains", [])
        if not isinstance(allowed, list) or len(allowed) > 20000:
            raise GuardError("Некорректный каталог разрешений")
        route["allowed_domains"] = sorted(set(hostname(x) for x in allowed))
        if kind == "https_proxy" and not allowed:
            raise GuardError("Для HTTPS-прокси нужен явный каталог назначений")
        route["probe_url"] = browser_url(route.get("probe_url", "https://api.ipify.org/"))
        route['probe_format'] = route.get('probe_format', 'plain_ip')
        if route['probe_format'] not in ('plain_ip', 'cloudflare_trace'):
            raise GuardError('Неподдерживаемый формат проверки выхода')
        approved = route.get("approved_exit_ips", [])
        if not isinstance(approved, list) or not 1 <= len(approved) <= 32:
            raise GuardError("Укажите проверенные IP выхода; автоматического доверия нет")
        try:
            route["approved_exit_ips"] = sorted(set(str(ipaddress.ip_address(x)) for x in approved))
        except ValueError:
            raise GuardError("Некорректный проверенный IP выхода") from None
        if not all(ipaddress.ip_address(x).is_global for x in route["approved_exit_ips"]):
            raise GuardError("Проверенный IP выхода должен быть публичным")
        if kind == "https_proxy":
            host = route.get("host", "")
            try:
                route["host"] = str(ipaddress.ip_address(host))
            except ValueError:
                route["host"] = hostname(host)
            route["server_name"] = hostname(route.get("server_name", host))
            if type(route.get("port")) is not int or not 1 <= route["port"] <= 65535:
                raise GuardError("Некорректный порт прокси")
            for key in ("username", "password"):
                value = route.get(key)
                if not isinstance(value, str) or not value or len(value) > 1024 or any(ord(c) < 32 for c in value):
                    raise GuardError("Нужны корректные учётные данные прокси")
            if ":" in route["username"]:
                raise GuardError("Двоеточие в имени пользователя не поддерживается")
            pin = route.get("certificate_sha256", "")
            if pin and not re.fullmatch(r"[a-fA-F0-9]{64}", pin):
                raise GuardError("Некорректный доверенный отпечаток сертификата")
        elif not re.fullmatch(r"utun[0-9]{1,4}", route.get("interface", "")):
            raise GuardError("Выберите конкретный VPN-интерфейс utun")
        normalized.append(route)
    return {"schema_version": 1, "sensitive_domains": domains, "routes": normalized}


def catalog_digest(domains: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(domains)).encode()).hexdigest()
