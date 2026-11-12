"""Local-only fixture. Never use these adapters or certificates in the app."""
import json
import base64
from pathlib import Path
import signal
import socket
import socketserver
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mac_guard.app import Dashboard
from mac_guard.browser import Browser, arguments
from mac_guard.chrome_events import ChromeEvents
from mac_guard.install import extension, extension_id, native_host
from mac_guard.policy import browser_url, private_dir
from mac_guard.service import Gate, Guard
from mac_guard.relay import relay

root = Path(sys.argv[1])
# A child exit must not end the fixture's lifetime. Handle SIGCHLD explicitly
# so a single signal.pause() would reproduce the regression on every platform.
signal.signal(signal.SIGCHLD, lambda *_: None)
counts = {'origin': 0, 'direct': 0, 'udp': 0, 'browser_opened': 0}
counts['outside_catalog_rtc'] = 0
counts['sensitive_conflict'] = 0
counts['conflict_targets'] = []
counts['external_http'] = counts['external_tls'] = 0
strict_system = {'direct':True}

class LocalHTTP(ThreadingHTTPServer):
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = 'localhost', self.server_address[1]

class Origin(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        counts['origin'] += 1
        body = b'<!doctype html><html><h1>Protected fixture</h1></html>'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

origin = LocalHTTP(('127.0.0.1', 0), Origin)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(root / 'cert.pem', root / 'key.pem')
origin.socket = tls.wrap_socket(origin.socket, server_side=True)
plain_origin = LocalHTTP(('127.0.0.1', 0), Origin)

class Tripwire(BaseHTTPRequestHandler):
    def setup(self):
        counts['direct'] += 1
        super().setup()
    def log_message(self, *_): pass
    def do_GET(self):
        self.send_response(200)
        self.end_headers()

tripwire = LocalHTTP(('127.0.0.1', 0), Tripwire)
tls_tripwire = LocalHTTP(('127.0.0.1', 0), Tripwire)
tls_tripwire.socket = tls.wrap_socket(tls_tripwire.socket, server_side=True)
class RTCBoundary(socketserver.BaseRequestHandler):
    def handle(self): counts['outside_catalog_rtc'] += 1
rtc_boundary=socketserver.ThreadingTCPServer(('127.0.0.1',0),RTCBoundary)
class ConflictProxy(BaseHTTPRequestHandler):
    def log_message(self, *_):pass
    def sensitive(self):
        host=self.path.split(':')[0]
        return host=='fixture.example.org' or host.endswith('.fixture.example.org')
    def authenticated(self):
        if self.headers.get('Proxy-Authorization')=='Basic '+base64.b64encode(b'fixture:fixture').decode():return True
        self.send_response(407);self.send_header('Proxy-Authenticate','Basic realm="fixture"');self.send_header('Content-Length','0');self.end_headers()
        return False
    def do_CONNECT(self):
        if self.sensitive():
            counts['sensitive_conflict']+=1
            counts['conflict_targets'].append(self.path)
            self.send_response(502);self.end_headers();return
        if self.path.split(':')[0] in ('bypassfixture.example.org','failfixture.example.org'):
            counts['external_denied']=counts.get('external_denied',0)+1
            self.send_response(503);self.send_header('Content-Length','0');self.end_headers();return
        if not self.authenticated():return
        counts['external_tls']+=1
        with socket.create_connection(origin.server_address,2) as upstream:
            self.send_response(200);self.end_headers();self.wfile.flush()
            relay(self.connection,upstream)
    def do_GET(self):
        if not self.authenticated():return
        counts['external_http']+=1
        body=b'<h1>External proxy fixture</h1>'
        self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
conflict_proxy=LocalHTTP(('127.0.0.1',0),ConflictProxy)
class IPv6HTTP(LocalHTTP): address_family = socket.AF_INET6
tripwire6 = IPv6HTTP(('::1', 0), Tripwire)
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(('127.0.0.1', 0))
def receive_udp():
    while True:
        udp.recvfrom(8192)
        counts['udp'] += 1
threading.Thread(target=receive_udp, daemon=True).start()

class Adapter:
    available = True
    def connect(self, host, port):
        if not self.available: raise OSError('Fixture upstream down')
        return socket.create_connection(origin.server_address, 2)
adapter = Adapter()
config = {'sensitive_domains': ['fixture.example.org'], 'routes': [{'id': 'fixture', 'kind': 'https_proxy', 'allowed_domains': ['fixture.example.org']}]}
config['routes'][0]['probe_url']='https://fixture.example.org/canary'
qualification = threading.Event()
qualification.set()
def checker(*_):
    if not qualification.wait(5):raise OSError('Fixture qualification timed out')
guard = Guard(config, factory=lambda _: adapter, checker=checker)
gate = Gate(guard)
class FixtureBrowser(Browser):
    def open(self, url):
        browser_url(url)
        # Exercise the actual application launcher. These two flags are confined
        # to this isolated fixture and never appear in production arguments.
        with patch.dict('os.environ', {'__CFBundleIdentifier':'org.ghostroute.guard'}), patch('mac_guard.browser.arguments', side_effect=lambda profile, port: arguments(profile, port) + ['--headless=new', '--ignore-certificate-errors']):
            super().open(url)
        counts['browser_opened'] += 1
private_dir(root / 'owned-browser-state')
owned_browser = FixtureBrowser(root / 'owned-browser-state', gate.server_address[1])
dashboard = Dashboard(guard, owned_browser, root)
chrome_events = ChromeEvents(guard, root)
extension_path = root / 'extension'
extension(extension_path, ['fixture.example.org'])
native_host(root, extension_path, root / 'native-manifests', Path(sys.executable))

class Control(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/strict-enable' and not guard.strict:
            from mac_guard.strict import StrictCoordinator
            def strict_check(*_):
                if not qualification.wait(5) or not adapter.available:raise OSError('Fixture route unavailable')
            guard.strict=StrictCoordinator(guard, factory=lambda _:adapter, checker=strict_check, system_check=lambda:strict_system['direct'])
            guard.chrome.strict=guard.strict
            guard.strict.tick()
            def strict_health():
                while True:
                    threading.Event().wait(.1)
                    guard.strict.tick()
            threading.Thread(target=strict_health, daemon=True).start()
        if self.path == '/strict-system-proxy-on': strict_system['direct']=False;guard.strict.system_at=0;guard.strict.tick()
        if self.path == '/strict-system-proxy-off': strict_system['direct']=True;guard.strict.system_at=0;guard.strict.tick()
        if self.path == '/strict-route-down':
            adapter.available=False
            for session in guard.strict.sessions.values(): session.guard.lock(reason='check_failed')
        if self.path == '/strict-route-up':
            adapter.available=True
            for session in guard.strict.sessions.values(): session.attempt=0
        if self.path == '/strict-gate-down':
            for session in list(guard.strict.sessions.values()):
                session.gate.shutdown();session.gate.server_close()
        if self.path == '/activate': guard.activate('fixture')
        if self.path == '/lock': guard.lock()
        if self.path == '/restore': adapter.available = True; qualification.set(); guard.lock()
        if self.path == '/delay': qualification.clear()
        if self.path == '/release': qualification.set()
        if self.path == '/close-browser': threading.Thread(target=owned_browser.close, daemon=True).start()
        if self.path == '/chrome-offline': chrome_events.shutdown(); chrome_events.server_close()
        if self.path == '/upstream-down': adapter.available = False; guard.lock(); guard.activate('fixture')
        if self.path == '/gate-down':
            guard.lock()
            gate.shutdown()
            gate.server_close()
        browser_process = owned_browser.process
        body = json.dumps(dict(counts, gate_busy=32-gate.slots._value, browser_running=bool(browser_process and browser_process.poll() is None), guard=guard.status(), activity=guard.activity())).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
control = LocalHTTP(('127.0.0.1', 0), Control)
for server in (origin, plain_origin, tripwire, tls_tripwire, rtc_boundary, conflict_proxy, tripwire6, gate, dashboard, chrome_events, control):
    threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({'control': control.server_port, 'gate': gate.server_address[1],
                  'tripwire': tripwire.server_port, 'tripwire6': tripwire6.server_port,
                  'tls_tripwire':tls_tripwire.server_port,
                  'rtc_boundary':rtc_boundary.server_address[1],
                  'conflict_proxy':conflict_proxy.server_port,
                  'udp': udp.getsockname()[1], 'dashboard': dashboard.origin + '/#' + dashboard.session_credential,
                  'plain_origin':plain_origin.server_port, 'tls_origin':origin.server_port, 'extension':str(extension_path),
                  'extension_id':extension_id(extension_path),
                  'native_manifest':str(root / 'native-manifests/org.ghostroute.guard.events.json'),
                  'arguments': arguments(root / 'browser', gate.server_address[1])[2:]}), flush=True)
threading.Event().wait()
