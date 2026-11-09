"""Local-only fixture. Never use these adapters or certificates in the app."""
import json
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

root = Path(sys.argv[1])
# A child exit must not end the fixture's lifetime. Handle SIGCHLD explicitly
# so a single signal.pause() would reproduce the regression on every platform.
signal.signal(signal.SIGCHLD, lambda *_: None)
counts = {'origin': 0, 'direct': 0, 'udp': 0, 'browser_opened': 0}

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
    def log_message(self, *_): pass
    def do_GET(self):
        counts['direct'] += 1
        self.send_response(200)
        self.end_headers()

tripwire = LocalHTTP(('127.0.0.1', 0), Tripwire)
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
        body = json.dumps(dict(counts, browser_running=bool(browser_process and browser_process.poll() is None), guard=guard.status(), activity=guard.activity())).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
control = LocalHTTP(('127.0.0.1', 0), Control)
for server in (origin, plain_origin, tripwire, tripwire6, gate, dashboard, chrome_events, control):
    threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({'control': control.server_port, 'gate': gate.server_address[1],
                  'tripwire': tripwire.server_port, 'tripwire6': tripwire6.server_port,
                  'udp': udp.getsockname()[1], 'dashboard': dashboard.origin + '/#' + dashboard.session_credential,
                  'plain_origin':plain_origin.server_port, 'extension':str(extension_path),
                  'extension_id':extension_id(extension_path),
                  'native_manifest':str(root / 'native-manifests/org.ghostroute.guard.events.json'),
                  'arguments': arguments(root / 'browser', gate.server_address[1])[2:]}), flush=True)
threading.Event().wait()
