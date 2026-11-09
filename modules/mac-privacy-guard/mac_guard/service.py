"""CONNECT gate and explicit locked → qualifying → active state machine."""
from __future__ import annotations

from collections import OrderedDict, deque
import socket
import socketserver
import threading
import time

from .policy import GuardError, authority, matches
from .relay import relay
from .chrome_control import ChromeControl
from .transport import make_adapter, qualify, read_headers

REASONS = {
    'started': 'Приложение запущено с закрытым доступом',
    'manual_lock': 'Доступ закрыт пользователем',
    'route_changed': 'Предыдущий маршрут закрыт перед новой проверкой',
    'checking': 'Проверяем доступность маршрута и разрешённый выход',
    'verified': 'Маршрут и выход проверены; доступ открыт',
    'check_failed': 'Проверка маршрута не пройдена; доступ закрыт',
    'expired': 'Проверка устарела; доступ закрыт',
    'profile_updated': 'Профиль обновлён; требуется новая проверка',
    'access_closed': 'Доступ закрыт; соединение не отправлено',
    'not_allowed': 'Домен отсутствует в разрешённом каталоге маршрута',
    'connected': 'Соединение разрешено через проверенный маршрут',
    'upstream_failed': 'Не удалось установить соединение через маршрут',
    'interrupted': 'Соединение завершилось с сетевой ошибкой',
    'cancelled': 'Доступ закрыт во время подключения',
    'completed': 'Соединение завершено',
    'invalid_request': 'Запрос отклонён: требуется корректное публичное HTTPS-назначение',
    'unsupported_protocol': 'Запрос отклонён: разрешены только HTTPS-туннели',
    'capacity': 'Достигнут лимит одновременных подключений',
    'chrome_blocked': 'Блокировщик Chrome остановил запрос к чувствительному домену',
    'browser_opened': 'Сайт передан в отдельный защищённый Chrome',
    'browser_failed': 'Защищённый Chrome не удалось открыть',
}


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
        self.errors = self.bytes_sent = self.bytes_received = 0
        self.events = deque(maxlen=300)
        self.event_sequence = 0
        self.active = {}
        self.started_at = time.time()
        self.chrome_profiles = OrderedDict()
        self.chrome_blocked = 0
        self.chrome = ChromeControl()
        self._record('system', 'started')

    def _record(self, kind, reason, host=None, route=None):
        # Caller holds mutex. Only parsed destination hosts and fixed messages;
        # never request headers, URL paths, credentials or exception strings.
        self.event_sequence += 1
        event = {'id': self.event_sequence, 'time': time.time(), 'kind': kind,
                 'source': 'guard',
                 'reason': reason, 'message': REASONS[reason], 'host': host,
                 'route': route['id'] if route else None,
                 'route_kind': route['kind'] if route else None,
                 'bytes_sent': 0, 'bytes_received': 0, 'state': None,
                 'duration_ms': None, 'close_reason': None}
        self.events.append(event)
        return event

    def activity(self):
        with self.mutex:
            return {'events': [dict(event) for event in reversed(self.events)],
                    'capacity': self.events.maxlen, 'started_at': self.started_at}

    def clear_activity(self):
        with self.mutex:
            self.events.clear()

    def browser_requested(self, host):
        with self.mutex:
            if self.mode != 'active':
                self.reject('access_closed', host)
                raise GuardError('Откройте доступ для защищённого браузера')
            if self.route['allowed_domains'] and not matches(host, self.route['allowed_domains']):
                self.reject('not_allowed', host)
                raise GuardError('Сайт отсутствует в разрешённом каталоге маршрута')

    def browser_result(self, host, success):
        with self.mutex:
            self._record('system' if success else 'error',
                         'browser_opened' if success else 'browser_failed', host, self.route)

    def chrome_event(self, data):
        # The private ingress has already validated the narrow event schema.
        with self.mutex:
            profile = data['profile']
            if data['op'] == 'heartbeat':
                self.chrome_profiles[profile] = (time.monotonic(), data['rules_enabled'])
                self.chrome_profiles.move_to_end(profile)
                while len(self.chrome_profiles) > 8:
                    self.chrome_profiles.popitem(last=False)
            else:
                self.chrome_blocked += 1
                event = self._record('blocked', 'chrome_blocked', data['host'])
                event.update(source='chrome', method=data['method'],
                             resource_type=data['resource_type'], rule_id=data['rule_id'])

    def reject(self, reason, host=None):
        with self.mutex:
            self.blocked += 1
            self._record('blocked', reason, host, self.route)

    def _transfer(self, event, direction, count):
        with self.mutex:
            key = 'bytes_' + direction
            event[key] += count
            setattr(self, key, getattr(self, key) + count)

    def _finish(self, event, reason):
        active = self.active.pop(event['id'], None)
        if active:
            event.update(state='closed', close_reason=reason,
                         duration_ms=round((time.monotonic() - active[1]) * 1000))

    def status(self):
        with self.mutex:
            return {'state': self.mode, 'message': self.message,
                    'route': self.route['id'] if self.route else None,
                    'routes': [{'id': r['id'], 'kind': r['kind'],
                                'domains': len(r['allowed_domains'])} for r in (self.config or {}).get('routes', [])],
                    'sensitive_domains': len((self.config or {}).get('sensitive_domains', [])),
                    'connections': len(self.active),
                    'allowed': self.allowed, 'blocked': self.blocked + self.chrome_blocked, 'errors': self.errors,
                    'chrome_blocked': self.chrome_blocked,
                    'chrome_connected': any(time.monotonic() - at < 45 and enabled for at, enabled in self.chrome_profiles.values()),
                    'bytes_sent': self.bytes_sent, 'bytes_received': self.bytes_received,
                    'verified_age': round(time.monotonic() - self.verified_at) if self.mode == 'active' else None}

    def lock(self, message='Доступ закрыт', reason='manual_lock'):
        with self.mutex:
            self._record('system', reason, route=self.route)
            self.generation += 1
            self.mode, self.message = 'locked', message
            self.route = self.adapter = None
            for connection in list(self.connections):
                close(connection)
            self.connections.clear()
            for event, _ in list(self.active.values()):
                self._finish(event, reason)

    def begin_activation(self, route_id):
        with self.mutex:
            self.lock('Проверяем маршрут', 'route_changed')
            route = next((r for r in (self.config or {}).get('routes', []) if r['id'] == route_id), None)
            if not route:
                raise GuardError('Маршрут не настроен')
            generation = self.generation
            self.mode = 'qualifying'
            self.route = route
            self._record('system', 'checking', route=route)
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
                    self.lock(str(error) if isinstance(error, GuardError) else 'Проверка маршрута не завершилась', 'check_failed')
            return
        with self.mutex:
            if generation != self.generation:
                return
            self.route, self.adapter = route, adapter
            self.mode, self.message = 'active', 'Маршрут проверен; доступ через шлюз открыт'
            self.verified_at = time.monotonic()
            self._record('system', 'verified', route=route)

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
                    self.lock('Проверка маршрута потеряна; доступ закрыт', 'check_failed')
            return
        with self.mutex:
            if generation == self.generation:
                self.verified_at = time.monotonic()

    def tunnel(self, client, host, port):
        upstream = event = None
        with self.mutex:
            if self.mode == 'active' and time.monotonic() - self.verified_at > 45:
                self.lock('Проверка устарела; подтвердите маршрут снова', 'expired')
            if self.mode != 'active':
                self.reject('access_closed', host)
                raise GuardError('Доступ закрыт')
            generation, adapter, route = self.generation, self.adapter, self.route
            if route['allowed_domains'] and not matches(host, route['allowed_domains']):
                self.reject('not_allowed', host)
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
                event = self._record('allowed', 'connected', host, route)
                event['state'] = 'open'
                self.active[event['id']] = (event, time.monotonic())
            client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            relay(client, upstream, on_transfer=lambda direction, count: self._transfer(event, direction, count))
        except Exception:
            with self.mutex:
                if event is not None:
                    # Lock closes tracked sockets intentionally, not a new refusal.
                    if event['state'] == 'open':
                        self.errors += 1
                        self._finish(event, 'interrupted')
                elif generation != self.generation:
                    self.reject('cancelled', host)
                else:
                    self.errors += 1
                    self._record('error', 'upstream_failed', host, route)
            if event is None:
                raise
        finally:
            with self.mutex:
                if event:
                    self._finish(event, 'completed')
                self.connections.discard(client)
                if upstream:
                    self.connections.discard(upstream)
            if upstream:
                close(upstream)


class Gate(socketserver.ThreadingTCPServer):
    daemon_threads = True
    # Rebind the same fixed proxy port after close/TIME_WAIT. SO_REUSEPORT is
    # deliberately absent: two live listeners must still be mutually exclusive.
    allow_reuse_address = True

    def __init__(self, guard, port=0):
        self.guard = guard
        self.slots = threading.BoundedSemaphore(32)
        super().__init__(('127.0.0.1', port), Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.guard.reject('capacity')
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
        pass  # Never write raw request data or upstream exceptions to console.


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(8)
        parsed = False
        reason = 'invalid_request'
        try:
            header = read_headers(self.request)
            parts = header.split(b'\r\n', 1)[0].decode('ascii').split(' ')
            if len(parts) != 3 or parts[0] != 'CONNECT' or parts[2] != 'HTTP/1.1':
                reason = 'unsupported_protocol'
                raise GuardError('Разрешён только CONNECT')
            host, port = authority(parts[1])
            parsed = True
            self.server.guard.tunnel(self.request, host, port)
        except Exception:
            if not parsed:
                self.server.guard.reject(reason)
            try:
                self.request.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            except OSError:
                pass
