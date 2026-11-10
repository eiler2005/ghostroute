"""Owned ordinary-Chrome CONNECT lanes. No current-IP trust or direct fallback."""
from copy import deepcopy
import re
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

from .policy import GuardError, catalog_digest, matches
from .service import Gate, Guard


def system_proxy_direct():
    """Do not replace an OS proxy with DIRECT for non-sensitive destinations."""
    if sys.platform != 'darwin':
        return False
    try:
        result = subprocess.run(['/usr/sbin/scutil', '--proxy'], capture_output=True,
                                text=True, timeout=1, check=True)
        return not re.search(r'\b(?:HTTP|HTTPS|SOCKS|WebProxyAutoConfig|ProxyAutoDiscovery)Enable\s*:\s*1\b', result.stdout)
    except (OSError, subprocess.SubprocessError):
        return False


class StrictSession:
    def __init__(self, parent, config, route, factory, checker):
        self.guard = Guard(config, factory, checker, journal=parent, max_verified_age=10)
        self.route = route
        self.gate = Gate(self.guard)
        threading.Thread(target=self.gate.serve_forever, daemon=True).start()
        self.seen = time.monotonic()
        self.enabled = True
        self.proxy = 'waiting'
        self.digest = ''
        self.baseline = 'direct'
        self.attempt = 0
        self.checking = False
        self.reason = 'checking'
        self.published = None

    def close(self):
        self.guard.lock()
        # Stop accepting immediately; do not wait for serve_forever while
        # holding the shared journal lock.
        self.gate.server_close()
        threading.Thread(target=self.gate.shutdown, daemon=True).start()


class StrictCoordinator:
    def __init__(self, parent, *, factory=None, checker=None, system_check=system_proxy_direct):
        from .transport import make_adapter, qualify
        self.parent = parent
        self.mutex = parent.mutex
        self.factory, self.checker = factory or make_adapter, checker or qualify
        self.system_check = system_check
        self.sessions = {}
        self.direct = False
        self.system_at = 0
        self.closed = False
        self.retired_allowed = self.retired_bytes = self.retired_errors = 0
        self.config = parent.config
        self.last_tick = (time.monotonic(), time.time())

    def route_config(self):
        config = deepcopy(self.parent.config or {})
        domains = config.get('sensitive_domains', [])
        routes = [r for r in config.get('routes', []) if r['kind'] == 'https_proxy'
                  and domains and all(matches(host, r['allowed_domains']) for host in domains)
                  and matches(urlsplit(r.get('probe_url', '')).hostname or '', domains)]
        if len(routes) != 1:
            raise GuardError('Нужен один HTTPS-маршрут с полным sensitive-каталогом и проверкой его выхода')
        route = routes[0]
        route['allowed_domains'] = domains
        config['routes'] = [route]
        return config, route

    def pause(self, profile):
        with self.mutex:
            session = self.sessions.get(profile)
            if session:
                session.enabled = False
                session.reason = 'paused'
                session.guard.lock(reason='strict_paused')

    def state(self, profile, agent, enabled):
        with self.mutex:
            if self.closed:
                return self.envelope(None, False, 'unavailable')
            strict = (agent or {}).get('strict')
            if not strict:
                return self.envelope(None, False, 'upgrade_required')
            try:
                if profile not in self.sessions:
                    if len(self.sessions) >= 8:
                        return self.envelope(None, False, 'unavailable')
                    config, route = self.route_config()
                    self.sessions[profile] = StrictSession(self.parent, config, route, self.factory, self.checker)
            except (GuardError, OSError):
                return self.envelope(None, enabled, 'route_unavailable')
            session = self.sessions[profile]
            session.seen = time.monotonic()
            session.enabled = enabled
            session.proxy = strict['proxy']
            session.digest = strict['catalog_digest']
            session.baseline = strict.get('baseline', 'direct')
            self.advance(session)
            return self.envelope(session, enabled, session.reason)

    def envelope(self, session, enabled, reason):
        domains = (self.parent.config or {}).get('sensitive_domains', [])
        return {'enabled': enabled, 'ready': bool(session and session.guard.mode == 'active' and reason == 'active'),
                'port': session.gate.server_address[1] if session else 0,
                'catalog_digest': catalog_digest(domains), 'system_direct': self.direct,
                'baseline': session.baseline if session else 'direct',
                'reason': reason}

    def advance(self, session):
        now = time.monotonic()
        digest = catalog_digest((self.parent.config or {}).get('sensitive_domains', []))
        reason = ('paused' if not session.enabled else 'system_proxy' if not self.direct
                  else 'error' if session.gate.fileno() < 0
                  else 'catalog_mismatch' if session.digest != digest
                  else session.proxy if session.proxy != 'owned' else None)
        if reason:
            if session.guard.mode != 'locked':
                session.guard.lock(reason='strict_paused' if reason == 'paused' else 'strict_blocked')
            session.reason = reason
        else:
            if session.guard.mode == 'active' and now - session.guard.verified_at > 10:
                session.guard.lock(reason='expired')
            session.reason = ('active' if session.guard.mode == 'active' else
                              'route_failed' if session.attempt and not session.checking else 'checking')
            if not session.checking and now - session.attempt >= 5 and (session.guard.mode != 'active' or now - session.guard.verified_at >= 5):
                session.attempt = now
                session.checking = True
                session.reason = 'checking' if session.guard.mode != 'active' else 'active'
                if session.guard.mode == 'active':
                    action = session.guard.recheck
                else:
                    reservation = session.guard.begin_activation(session.route['id'])
                    action = lambda: session.guard.finish_activation(*reservation)
                def run():
                    try:
                        action()
                    finally:
                        with self.mutex:
                            session.checking = False
                threading.Thread(target=run, daemon=True).start()
        if session.published != session.reason:
            code = 'strict_active' if session.reason == 'active' else 'strict_paused' if session.reason == 'paused' else 'strict_checking' if session.reason == 'checking' else 'strict_blocked'
            self.parent._record('system', code)
            session.published = session.reason

    def tick(self):
        # OS state is read only; never change system routing or proxy settings.
        now, wall = time.monotonic(), time.time()
        direct = self.direct
        if now - self.system_at >= 2:
            direct = self.system_check()
            self.system_at = now
        with self.mutex:
            suspended = abs((wall - self.last_tick[1]) - (now - self.last_tick[0])) > 2 or now - self.last_tick[0] > 10
            self.last_tick = (now, wall)
            self.direct = direct
            if self.parent.config is not self.config:
                self.close_sessions()
                self.config = self.parent.config
            for profile, session in list(self.sessions.items()):
                if now - session.seen > 6:
                    self.retired_allowed += session.guard.allowed
                    self.retired_bytes += session.guard.bytes_sent + session.guard.bytes_received
                    self.retired_errors += session.guard.errors
                    session.close()
                    del self.sessions[profile]
                    continue
                if suspended:
                    session.guard.lock(reason='expired')
                self.advance(session)

    def counters(self):
        return {'strict_allowed': self.retired_allowed + sum(s.guard.allowed for s in self.sessions.values()),
                'strict_connections': sum(len(s.guard.active) for s in self.sessions.values()),
                'strict_errors': self.retired_errors + sum(s.guard.errors for s in self.sessions.values()),
                'strict_bytes': self.retired_bytes + sum(s.guard.bytes_sent + s.guard.bytes_received for s in self.sessions.values())}

    def close_sessions(self):
        with self.mutex:
            for session in self.sessions.values():
                self.retired_allowed += session.guard.allowed
                self.retired_bytes += session.guard.bytes_sent + session.guard.bytes_received
                self.retired_errors += session.guard.errors
                session.close()
            self.sessions.clear()

    def close(self):
        with self.mutex:
            self.closed = True
            self.close_sessions()
