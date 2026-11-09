"""CONNECT gate and explicit locked → qualifying → active state machine."""
from __future__ import annotations

import socket
import socketserver
import threading
import time

from .policy import GuardError, authority, matches
from .relay import relay
from .transport import make_adapter, qualify, read_headers


def close(connection):
    try:
        connection.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    connection.close()


class Guard:
    def __init__(self, config=None, factory=make_adapter, checker=qualify):
        self.config = config
        self.factory, self.checker = factory, checker
        self.mutex = threading.RLock()
        self.generation = 0
        self.mode, self.message = 'locked', 'Выберите и проверьте маршрут'
        self.route = self.adapter = None
        self.verified_at = 0
        self.connections = set()
        self.allowed = self.blocked = 0

    def status(self):
        with self.mutex:
            return {'state': self.mode, 'message': self.message,
                    'route': self.route['id'] if self.route else None,
                    'routes': [{'id': r['id'], 'kind': r['kind'],
                                'domains': len(r['allowed_domains'])} for r in (self.config or {}).get('routes', [])],
                    'sensitive_domains': len((self.config or {}).get('sensitive_domains', [])),
                    'connections': len(self.connections) // 2,
                    'allowed': self.allowed, 'blocked': self.blocked}

    def lock(self, message='Доступ закрыт'):
        with self.mutex:
            self.generation += 1
            self.mode, self.message = 'locked', message
            self.route = self.adapter = None
            for connection in list(self.connections):
                close(connection)
            self.connections.clear()

    def begin_activation(self, route_id):
        with self.mutex:
            self.lock('Проверяем маршрут')
            route = next((r for r in (self.config or {}).get('routes', []) if r['id'] == route_id), None)
            if not route:
                raise GuardError('Маршрут не настроен')
            generation = self.generation
            self.mode = 'qualifying'
            return generation, route

    def activate(self, route_id):
        self.finish_activation(*self.begin_activation(route_id))

    def finish_activation(self, generation, route):
        try:
            adapter = self.factory(route)
            self.checker(adapter, route)
        except Exception as error:
            with self.mutex:
                if generation == self.generation:
                    self.lock(str(error) if isinstance(error, GuardError) else 'Проверка маршрута не завершилась')
            return
        with self.mutex:
            if generation != self.generation:
                return
            self.route, self.adapter = route, adapter
            self.mode, self.message = 'active', 'Маршрут проверен; доступ через шлюз открыт'
            self.verified_at = time.monotonic()

    def recheck(self):
        with self.mutex:
            if self.mode != 'active':
                return
            generation, adapter, route = self.generation, self.adapter, self.route
        try:
            self.checker(adapter, route)
        except Exception:
            with self.mutex:
                if generation == self.generation:
                    self.lock('Проверка маршрута потеряна; доступ закрыт')
            return
        with self.mutex:
            if generation == self.generation:
                self.verified_at = time.monotonic()

    def tunnel(self, client, host, port):
        upstream = None
        with self.mutex:
            if self.mode == 'active' and time.monotonic() - self.verified_at > 45:
                self.lock('Проверка устарела; подтвердите маршрут снова')
            if self.mode != 'active':
                self.blocked += 1
                raise GuardError('Доступ закрыт')
            generation, adapter, route = self.generation, self.adapter, self.route
            if route['allowed_domains'] and not matches(host, route['allowed_domains']):
                self.blocked += 1
                raise GuardError('Назначение отсутствует в разрешённом каталоге')
            self.connections.add(client)
        try:
            # VPN indices can be recycled. Requalify each new CONNECT, then
            # the adapter checks and binds every individual destination socket.
            if route['kind'] == 'bound_vpn':
                self.checker(adapter, route)
            upstream = adapter.connect(host, port)
            with self.mutex:
                if generation != self.generation or self.mode != 'active':
                    raise GuardError('Маршрут закрыт во время соединения')
                self.connections.add(upstream)
                self.allowed += 1
            client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            relay(client, upstream)
        except Exception:
            with self.mutex:
                self.blocked += 1
            raise
        finally:
            with self.mutex:
                self.connections.discard(client)
                if upstream:
                    self.connections.discard(upstream)
            if upstream:
                close(upstream)


class Gate(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, guard, port=0):
        self.guard = guard
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(('127.0.0.1', port), Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # Never log destinations or upstream exceptions.


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(8)
        try:
            header = read_headers(self.request)
            parts = header.split(b'\r\n', 1)[0].decode('ascii').split(' ')
            if len(parts) != 3 or parts[0] != 'CONNECT' or parts[2] != 'HTTP/1.1':
                raise GuardError('Разрешён только CONNECT')
            host, port = authority(parts[1])
            self.server.guard.tunnel(self.request, host, port)
        except Exception:
            try:
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            except OSError:
                pass
