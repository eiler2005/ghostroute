"""Local-only fixture. Never use these adapters or certificates in the app."""
import json
from pathlib import Path
import signal
import socket
import ssl
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mac_guard.app import Dashboard
from mac_guard.browser import arguments
from mac_guard.service import Gate, Guard

root = Path(sys.argv[1])
counts = {'origin': 0, 'direct': 0, 'udp': 0}

class Origin(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        counts['origin'] += 1
        body = b'<!doctype html><html><h1>Protected fixture</h1></html>'
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

origin = ThreadingHTTPServer(('127.0.0.1', 0), Origin)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(root / 'cert.pem', root / 'key.pem')
origin.socket = tls.wrap_socket(origin.socket, server_side=True)

class Tripwire(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        counts['direct'] += 1
        self.send_response(200)
        self.end_headers()

tripwire = ThreadingHTTPServer(('127.0.0.1', 0), Tripwire)
class IPv6HTTP(ThreadingHTTPServer): address_family = socket.AF_INET6
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
guard = Guard(config, factory=lambda _: adapter, checker=lambda *_: None)
gate = Gate(guard)
dashboard = Dashboard(guard, None, root)

class Control(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/activate': guard.activate('fixture')
        if self.path == '/lock': guard.lock()
        if self.path == '/upstream-down': adapter.available = False; guard.lock(); guard.activate('fixture')
        if self.path == '/gate-down':
            guard.lock()
            gate.shutdown()
            gate.server_close()
        body = json.dumps(counts).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
control = ThreadingHTTPServer(('127.0.0.1', 0), Control)
for server in (origin, tripwire, tripwire6, gate, dashboard, control):
    threading.Thread(target=server.serve_forever, daemon=True).start()
print(json.dumps({'control': control.server_port, 'gate': gate.server_address[1],
                  'tripwire': tripwire.server_port, 'tripwire6': tripwire6.server_port,
                  'udp': udp.getsockname()[1], 'dashboard': dashboard.origin + '/#' + dashboard.session_credential,
                  'arguments': arguments(root / 'browser', gate.server_address[1])[2:]}), flush=True)
signal.pause()
