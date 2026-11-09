"""Loopback control API. All reads and mutations require a per-run token."""
from __future__ import annotations

import argparse
import fcntl
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import socketserver
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .browser import Browser
from .chrome_events import ChromeEvents
from .policy import GuardError, browser_url, load_private, private_dir, validate_config, write_private
from .service import Gate, Guard

class Dashboard(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # HTTPServer otherwise calls getfqdn() for this literal loopback bind.
        # A dashboard must not wait for or disclose anything to system DNS.
        socketserver.TCPServer.server_bind(self)
        self.server_name = 'localhost'
        self.server_port = self.server_address[1]

    def __init__(self, guard, browser, state):
        self.guard, self.browser, self.state = guard, browser, state
        self.session_credential = secrets.token_urlsafe(32)
        self.actions = threading.Lock()
        super().__init__(('127.0.0.1', 0), Handler)
        self.origin = f'http://127.0.0.1:{self.server_port}'

    def handle_error(self, request, client_address):
        pass

    def snapshot(self):
        data = self.guard.status()
        pid = getattr(self.browser, 'running_pid', None)
        data['browser_pid'] = pid if type(pid) is int and pid > 1 else None
        return data


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send(self, code, data, content_type='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
        self.end_headers()
        self.wfile.write(data)

    def valid_host(self):
        return self.headers.get('Host') == self.server.origin.removeprefix('http://')

    def authorized(self):
        credential = self.headers.get('Authorization', '')
        return (self.valid_host() and hmac.compare_digest(credential, 'Bearer ' + self.server.session_credential)
                and self.headers.get('Origin', self.server.origin) == self.server.origin)

    def do_GET(self):
        if not self.valid_host():
            return self.send(403, b'{}')
        if self.path in ('/api/status', '/api/activity'):
            if not self.authorized():
                return self.send(403, b'{}')
            data = self.server.snapshot() if self.path == '/api/status' else self.server.guard.activity()
            return self.send(200, json.dumps(data).encode())
        return self.send(404, b'{}')

    def do_POST(self):
        if not self.authorized() or self.headers.get('Content-Type') != 'application/json':
            return self.send(403, b'{}')
        if not self.server.actions.acquire(blocking=False):
            return self.send(409, b'{"error":"Action in progress"}')
        browser_recorded = False
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 131072 or self.headers.get('Transfer-Encoding'):
                raise GuardError('Некорректный запрос')
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise GuardError('Некорректный запрос')
            guard = self.server.guard
            if self.path == '/api/activate' and set(payload) == {'route'}:
                # Qualification runs independently, so Lock can always cancel it.
                reservation = guard.begin_activation(payload['route'])
                threading.Thread(target=guard.finish_activation, args=reservation, daemon=True).start()
            elif self.path == '/api/lock' and not payload:
                guard.lock()
            elif self.path == '/api/activity/clear' and not payload:
                guard.clear_activity()
            elif self.path == '/api/extension-folder' and not payload:
                folder = self.server.state / 'Chrome Blocker'
                if sys.platform != 'darwin' or not folder.is_dir():
                    raise GuardError('Папка расширения недоступна')
                subprocess.run(['open', str(folder)], check=True, timeout=5,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            elif self.path == '/api/open' and set(payload) == {'url'}:
                url = browser_url(payload['url'])
                host = urlsplit(url).hostname
                browser_recorded = True
                guard.browser_requested(host)
                try:
                    self.server.browser.open(url)
                except Exception:
                    guard.browser_result(host, False)
                    raise
                guard.browser_result(host, True)
            elif self.path == '/api/profile' and set(payload) == {'profile'}:
                config = validate_config(payload['profile'])
                guard.lock('Профиль обновлён; требуется проверка маршрута', 'profile_updated')
                write_private(self.server.state / 'profile.json', json.dumps(config).encode())
                guard.config = config
            else:
                return self.send(404, b'{}')
            self.send(200, json.dumps(self.server.snapshot()).encode())
        except GuardError as error:
            if self.path == '/api/open' and not browser_recorded:
                self.server.guard.reject('invalid_request')
            self.send(400, json.dumps({'error': str(error)}).encode())
        except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError):
            self.send(400, json.dumps({'error': 'Действие не выполнено. Проверьте профиль, маршрут и HTTPS-адрес.'}).encode())
        finally:
            self.server.actions.release()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, default=Path.home() / 'Library/Application Support/GhostRoute Guard')
    parser.add_argument('--parent-pid', type=int)
    args = parser.parse_args()
    private_dir(args.state)
    # One gate owns the persistent browser profile and its fixed loopback port.
    lock_file = open(args.state / 'app.lock', 'a')
    os.chmod(args.state / 'app.lock', 0o600)
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print(json.dumps({'error': 'already_running'}), flush=True)
        raise SystemExit(1)
    profile = args.state / 'profile.json'
    config, issue = None, None
    if profile.exists():
        try:
            config = load_private(profile)
        except (GuardError, OSError):
            issue = 'Приватный профиль не прошёл проверку; доступ закрыт'
    guard = Guard(config)
    if issue:
        guard.message = issue
    port_path = args.state / 'gate-port'
    try:
        port = int(port_path.read_text()) if port_path.exists() else 0
        if port and not 1024 <= port <= 65535:
            raise ValueError()
        gate = Gate(guard, port)
    except (ValueError, OSError):
        print(json.dumps({'error': 'port_unavailable'}), flush=True)
        raise SystemExit(1) from None
    write_private(port_path, str(gate.server_address[1]).encode())
    browser = Browser(args.state, gate.server_address[1])
    dashboard = Dashboard(guard, browser, args.state)
    try:
        chrome_events = ChromeEvents(guard, args.state)
    except (GuardError, OSError):
        print(json.dumps({'error': 'chrome_events_unavailable'}), flush=True)
        raise SystemExit(1) from None
    stop = threading.Event()

    def monitor():
        while not stop.wait(1):
            if args.parent_pid is not None and os.getppid() != args.parent_pid:
                stop.set()
                return

    def health():
        while not stop.wait(15):
            guard.recheck()

    for target in (gate.serve_forever, dashboard.serve_forever, chrome_events.serve_forever, monitor, health):
        threading.Thread(target=target, daemon=True).start()
    for signum in (signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, lambda *_: stop.set())
    print(json.dumps({'url': dashboard.origin + '/#' + dashboard.session_credential}), flush=True)
    try:
        stop.wait()
    finally:
        guard.lock()
        browser.close()
        gate.shutdown()
        dashboard.shutdown()
        chrome_events.shutdown()
        gate.server_close()
        dashboard.server_close()
        chrome_events.server_close()
        lock_file.close()


if __name__ == '__main__':
    main()
