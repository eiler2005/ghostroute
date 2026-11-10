"""Volatile, bounded Chrome diagnostics. Never qualifies or changes a route."""
from collections import OrderedDict, deque
import re
import secrets
import threading
import time

from .policy import GuardError, hostname

IDENTIFIER = re.compile(r'[a-f0-9]{32}')
ACTIONS = {'start', 'stop', 'clear', 'preview', 'reporting_on', 'reporting_off', 'pause_protection', 'resume_protection', 'allow_sites', 'block_sites'}


def identifier(value):
    return isinstance(value, str) and IDENTIFIER.fullmatch(value) is not None


def validate_control_message(data):
    common = {'op', 'profile'}
    op = data['op']
    fields = {
        'agent': {'ready', 'session', 'remaining', 'reporting', 'protection', 'pause_remaining'},
        'http': {'session', 'event', 'host', 'method', 'status', 'mime', 'duration_ms'},
        'preview': {'session', 'event', 'command', 'text'},
        'result': {'command', 'success'},
        'reset': {'session'},
    }
    if op not in fields or set(data) != common | fields[op]:
        raise GuardError('Некорректное сообщение агента Chrome')
    if op == 'agent':
        if any(type(data[key]) is not bool for key in ('ready', 'reporting', 'protection')):
            raise GuardError('Некорректное состояние агента')
        if type(data['remaining']) is not int or not 0 <= data['remaining'] <= 60:
            raise GuardError('Некорректный срок диагностики')
        if type(data['pause_remaining']) is not int or not 0 <= data['pause_remaining'] <= 60:
            raise GuardError('Некорректный срок паузы')
        if (data['ready'] and not identifier(data['session'])) or (not data['ready'] and (data['session'] is not None or data['remaining'] != 0)):
            raise GuardError('Нет разрешённой вкладки')
    elif op == 'http':
        if not identifier(data['session']) or not identifier(data['event']):
            raise GuardError('Некорректный сеанс диагностики')
        if data['method'] not in {'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE', 'OTHER'}:
            raise GuardError('Некорректный метод')
        if type(data['status']) is not int or not 0 <= data['status'] <= 599:
            raise GuardError('Некорректный HTTP статус')
        if type(data['duration_ms']) is not int or not 0 <= data['duration_ms'] <= 600000:
            raise GuardError('Некорректное время запроса')
        if not isinstance(data['mime'], str) or re.fullmatch(r'[A-Za-z0-9.+/-]{0,100}', data['mime']) is None:
            raise GuardError('Некорректный тип ответа')
        data = dict(data, host=hostname(data['host']))
    elif op == 'reset':
        if not identifier(data['session']):
            raise GuardError('Некорректный сеанс')
    elif op == 'preview':
        if not all(identifier(data[key]) for key in ('session', 'event', 'command')):
            raise GuardError('Некорректный ответ диагностики')
        if not isinstance(data['text'], str) or len(data['text']) > 1024 or any(ord(c) < 32 and c not in '\n\r\t' for c in data['text']):
            raise GuardError('Предпросмотр слишком большой или некорректный')
    elif not identifier(data['command']) or type(data['success']) is not bool:
        raise GuardError('Некорректное подтверждение команды')
    return data


class ChromeControl:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.mutex = threading.RLock()
        self.agents = OrderedDict()
        self.events = deque(maxlen=100)
        self.pending = {}
        self.access = {}
        self.suspended = {}
        self.preview = None
        self.notice = 'Откройте DevTools → Guard и разрешите управление этой вкладкой'

    def _clear(self, profile):
        self.events = deque((event for event in self.events if event['profile'] != profile), maxlen=100)
        if self.preview and self.preview['profile'] == profile:
            self.preview = None

    def _expire(self):
        now = self.clock()
        for profile, agent in list(self.agents.items()):
            if now - agent['seen'] > 6:
                self._clear(profile)
                self.pending.pop(profile, None)
                del self.agents[profile]
                self.suspended.pop(profile, None)
                self.access.pop(profile, None)
            elif agent['remaining'] and now >= agent['deadline']:
                agent['remaining'] = 0
                self._clear(profile)
        for profile, command in list(self.pending.items()):
            if now >= command['expires']:
                del self.pending[profile]
                self.notice = 'Chrome не подтвердил команду. Проверьте открытую панель Guard.'
        if self.preview and now >= self.preview['expires']:
            self.preview = None

    def receive(self, data):
        with self.mutex:
            self._expire()
            profile, op = data['profile'], data['op']
            if op == 'agent':
                previous = self.agents.get(profile)
                if self.suspended.get(profile) == data['session']:
                    data = dict(data, remaining=0)
                elif not data['ready']:
                    self.suspended.pop(profile, None)
                if previous and (previous['session'] != data['session'] or not data['remaining']):
                    self._clear(profile)
                self.agents[profile] = dict(data, seen=self.clock(), deadline=self.clock() + data['remaining'])
                self.agents.move_to_end(profile)
                while len(self.agents) > 8:
                    retired, _ = self.agents.popitem(last=False)
                    self._clear(retired); self.pending.pop(retired, None)
                    self.suspended.pop(retired, None)
                    self.access.pop(retired, None)
                return
            agent = self.agents.get(profile)
            if op == 'result':
                command = self.pending.get(profile)
                if command and command['id'] == data['command']:
                    if command['action'] == 'clear': self._clear(profile)
                    self.notice = 'Chrome подтвердил команду' if data['success'] else 'Chrome отклонил команду. Подготовьте вкладку заново.'
                    del self.pending[profile]
                return
            if not agent or not agent['ready'] or not agent['remaining'] or agent['session'] != data['session']:
                raise GuardError('Диагностический сеанс закрыт')
            if op == 'reset':
                self._clear(profile)
            elif op == 'http':
                if self.pending.get(profile, {}).get('action') == 'clear': return
                if not any(event['profile'] == profile and event['event'] == data['event'] for event in self.events):
                    self.events.append(dict(data, time=time.time()))
            elif op == 'preview':
                command = self.pending.get(profile)
                if not command or command['action'] != 'preview' or command['id'] != data['command'] or command['event'] != data['event']:
                    raise GuardError('Предпросмотр не был запрошен')
                if not any(event['profile'] == profile and event['event'] == data['event'] for event in self.events):
                    raise GuardError('Ответ уже удалён')
                self.preview = dict(data, expires=self.clock() + 15)

    def command(self, profile, action, event=None):
        with self.mutex:
            self._expire()
            if not identifier(profile) or action not in ACTIONS or (event is not None and not identifier(event)) or (action == 'preview') != (event is not None):
                raise GuardError('Некорректная команда Chrome')
            agent = self.agents.get(profile)
            if not agent or (action not in {'reporting_on', 'reporting_off', 'pause_protection', 'resume_protection', 'allow_sites', 'block_sites'} and not agent['ready']):
                raise GuardError('Сначала разрешите управление во вкладке DevTools → Guard')
            if action in {'allow_sites', 'block_sites', 'pause_protection', 'resume_protection'}:
                self.access[profile] = action == 'allow_sites'
            if action == 'preview' and (not agent['remaining'] or not any(e['profile'] == profile and e['event'] == event for e in self.events)):
                raise GuardError('Ответ больше недоступен')
            if action in {'stop', 'clear'}:
                self._clear(profile)
            if action == 'stop':
                self.suspended[profile] = agent['session']
                agent['remaining'] = 0
            elif action == 'start':
                self.suspended.pop(profile, None)
            self.preview = None
            self.pending[profile] = {'id': secrets.token_hex(16), 'action': action,
                                     'session': agent['session'], 'event': event,
                                     'expires': self.clock() + 5}
            self.notice = 'Команда ожидает подтверждения Chrome'

    def reply(self, profile):
        with self.mutex:
            self._expire()
            command = self.pending.get(profile)
            return {'ok': True, 'access': 'allow' if self.access.get(profile, False) else 'block',
                    **({'command': {key: command[key] for key in ('id', 'action', 'session', 'event')}} if command else {})}

    def snapshot(self):
        with self.mutex:
            self._expire()
            return {'agents': [dict(id=key, ready=value['ready'], reporting=value['reporting'], protection=value['protection'],
                                    desired_allowed=self.access.get(key, False),
                                    pause_remaining=value['pause_remaining'],
                                    remaining=max(0, round(value['deadline'] - self.clock())) if value['remaining'] else 0,
                                    pending=key in self.pending) for key, value in self.agents.items()],
                    'events': [dict(event) for event in reversed(self.events)],
                    'preview': {key: self.preview[key] for key in ('profile', 'event', 'text')} if self.preview else None,
                    'notice': self.notice}
