"""Private Chrome event and diagnostics ingress; no routing authority."""
import json
import os
import re
import socketserver
import stat

from .policy import GuardError, hostname
from .chrome_control import validate_control_message

RESOURCE_TYPES = {'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
                  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket',
                  'webtransport', 'webbundle', 'other'}
METHODS = {'GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE', 'OTHER'}


def validate_message(data):
    if not isinstance(data, dict) or not isinstance(data.get('profile'), str) or not re.fullmatch('[a-f0-9]{32}', data['profile']):
        raise GuardError('Некорректное событие браузера')
    if data.get('op') == 'heartbeat':
        if set(data) != {'op', 'profile', 'version', 'rules_enabled'} or type(data['rules_enabled']) is not bool:
            raise GuardError('Некорректное состояние расширения')
        if not isinstance(data['version'], str) or not re.fullmatch(r'[0-9.]{1,20}', data['version']):
            raise GuardError('Некорректная версия расширения')
    elif data.get('op') in {'blocked', 'allowed'}:
        if set(data) != {'op', 'profile', 'host', 'method', 'resource_type', 'rule_id'}:
            raise GuardError('Дополнительные поля события запрещены')
        if not isinstance(data['method'], str) or not isinstance(data['resource_type'], str) or data['method'] not in METHODS or data['resource_type'] not in RESOURCE_TYPES:
            raise GuardError('Некорректный тип запроса')
        if type(data['rule_id']) is not int or not (data['rule_id'] == 900001 if data['op'] == 'allowed' else 1 <= data['rule_id'] <= 30000):
            raise GuardError('Некорректное правило')
        data = dict(data, host=hostname(data['host']))
    elif data.get('op') in {'agent', 'http', 'preview', 'result', 'reset'}:
        return validate_control_message(data)
    else:
        raise GuardError('Разрешены только события расширения')
    return data


class ChromeEvents(socketserver.UnixStreamServer):
    def __init__(self, guard, state):
        self.guard = guard
        self.path = state / 'chrome-events.sock'
        if self.path.exists() or self.path.is_symlink():
            info = self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                raise GuardError('Неверный объект локального журнала')
            self.path.unlink()  # App's exclusive lock already establishes ownership.
        super().__init__(str(self.path), Handler)
        os.chmod(self.path, 0o600)

    def server_close(self):
        super().server_close()
        self.path.unlink(missing_ok=True)

    def handle_error(self, *_):
        pass


class Handler(socketserver.StreamRequestHandler):
    timeout = 1

    def handle(self):
        try:
            raw = self.rfile.readline(8193)
            if len(raw) > 8192 or not raw.endswith(b'\n'):
                raise GuardError('Событие слишком большое')
            data = validate_message(json.loads(raw))
            if data['op'] in {'heartbeat', 'blocked', 'allowed'}:
                self.server.guard.chrome_event(data)
            else:
                self.server.guard.chrome.receive(data)
            response = (json.dumps(self.server.guard.chrome.reply(data['profile'])) + '\n').encode()
        except (ValueError, TypeError, KeyError, GuardError, OSError):
            response = b'{"ok":false}\n'
        try:
            self.wfile.write(response)
        except OSError:
            pass
