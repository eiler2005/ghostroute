import copy
import hashlib
import http.client
import json
import io
from pathlib import Path
import socket
import socketserver
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from mac_guard import policy, transport
from mac_guard.app import Dashboard
from mac_guard.browser import arguments
from mac_guard.install import extension
from mac_guard.service import Gate, Guard, close


def profile():
    return {'schema_version': 1, 'sensitive_domains': ['sensitive.example.org'], 'routes': [{
        'id': 'home', 'kind': 'https_proxy', 'host': 'proxy.example.org', 'port': 443,
        'server_name': 'proxy.example.org', 'username': 'fixture-user', 'password': 'fixture-only',
        'allowed_domains': ['sensitive.example.org'], 'approved_exit_ips': ['1.1.1.1'],
        'probe_url': 'https://probe.example.org/'}]}


class PolicyTests(unittest.TestCase):
    def test_domain_boundaries(self):
        self.assertTrue(policy.matches('a.sensitive.example.org', ['sensitive.example.org']))
        self.assertFalse(policy.matches('notsensitive.example.org', ['sensitive.example.org']))
        self.assertFalse(policy.matches('sensitive.example.org.evil.org', ['sensitive.example.org']))
        self.assertEqual(policy.hostname('EXAMPLE.ORG.'), 'example.org')
        self.assertEqual(policy.hostname('пример.рф'), 'xn--e1afmkfd.xn--p1ai')

    def test_invalid_targets(self):
        for value in ['localhost:443', '127.0.0.1:443', '[::1]:443', '192.168.1.1:443',
                      '2130706433:443', '0x7f.0.0.1:443', 'example.org:80', 'a\r\nb.org:443',
                      'x.example.org:443@evil.org:443', 'example.org:443/path']:
            with self.subTest(value=value), self.assertRaises(policy.GuardError):
                policy.authority(value)
        self.assertEqual(policy.authority('example.org:443'), ('example.org', 443))

    def test_url(self):
        for value in ['http://example.org', 'https://u:p@example.org', 'file:///etc/passwd',
                      'https://example.org:22', 'https://example.org/\r\n', 'https://localhost']:
            with self.subTest(value=value), self.assertRaises(policy.GuardError):
                policy.browser_url(value)

    def test_config_closed(self):
        self.assertEqual(policy.validate_config(profile())['routes'][0]['id'], 'home')
        for key, value in [('kind', 'direct'), ('allowed_domains', []), ('approved_exit_ips', []),
                           ('certificate_sha256', 'bad'), ('password', 'a\nb'), ('port', True)]:
            data = profile()
            data['routes'][0][key] = value
            with self.subTest(key=key), self.assertRaises(policy.GuardError):
                policy.validate_config(data)
        data = profile()
        data['routes'][0]['fallback'] = 'direct'
        with self.assertRaises(policy.GuardError): policy.validate_config(data)

    def test_private_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'state/profile.json'
            policy.write_private(path, json.dumps(profile()).encode())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777, 0o700)
            policy.load_private(path)
            path.chmod(0o644)
            with self.assertRaises(policy.GuardError): policy.load_private(path)
            path.unlink()
            path.symlink_to(Path(temporary) / 'elsewhere')
            with self.assertRaises(policy.GuardError): policy.write_private(path, b'bad')

    def test_browser_and_extension(self):
        args = arguments(Path('/fixture/profile'), 23456)
        self.assertNotIn('--no-sandbox', args)
        self.assertFalse(any('direct://' in value for value in args))
        self.assertIn('--proxy-bypass-list=<-loopback>', args)
        self.assertIn('--webrtc-ip-handling-policy=disable_non_proxied_udp', args)
        with tempfile.TemporaryDirectory() as temporary:
            extension(Path(temporary), ['sensitive.example.org'])
            rules = json.loads((Path(temporary) / 'rules.json').read_text())
            self.assertEqual(rules[0]['action'], {'type': 'block'})
            self.assertEqual(rules[0]['condition'], {'requestDomains': ['sensitive.example.org']})
            manifest = json.loads((Path(temporary) / 'manifest.json').read_text())
            self.assertEqual(manifest['permissions'], ['declarativeNetRequest'])


class StateTests(unittest.TestCase):
    def setUp(self):
        self.peers = []
        self.adapter = Mock()
        def connect(*args):
            left, right = socket.socketpair()
            self.peers.append(right)
            def echo():
                try:
                    while data := right.recv(65536): right.sendall(data)
                except OSError: pass
            threading.Thread(target=echo, daemon=True).start()
            return left
        self.adapter.connect.side_effect = connect
        self.guard = Guard(profile(), factory=lambda _: self.adapter, checker=lambda *_: None)
        self.gate = Gate(self.guard)
        threading.Thread(target=self.gate.serve_forever, daemon=True).start()

    def tearDown(self):
        self.guard.lock()
        self.gate.shutdown()
        self.gate.server_close()
        for peer in self.peers: peer.close()

    def request(self, host='sensitive.example.org'):
        connection = socket.create_connection(self.gate.server_address, 2)
        connection.sendall(f'CONNECT {host}:443 HTTP/1.1\r\nHost: {host}\r\n\r\n'.encode())
        return connection, transport.read_headers(connection)

    def test_lock_allow_and_drain(self):
        client, headers = self.request()
        self.assertIn(b'403', headers)
        client.close()
        self.guard.activate('home')
        client, headers = self.request()
        self.assertIn(b'200', headers)
        client.sendall(b'fixture')
        self.assertEqual(client.recv(7), b'fixture')
        self.guard.lock()
        self.assertEqual(client.recv(1), b'')
        client.close()
        self.assertEqual(self.guard.status()['state'], 'locked')

    def test_unknown_destination_never_reaches_adapter(self):
        self.guard.activate('home')
        client, headers = self.request('other.example.org')
        self.assertIn(b'403', headers)
        self.adapter.connect.assert_not_called()
        client.close()

    def test_failure_does_not_try_direct(self):
        self.guard.activate('home')
        self.adapter.connect.side_effect = OSError('fixture failure')
        client, headers = self.request()
        self.assertIn(b'403', headers)
        self.assertEqual(self.adapter.connect.call_count, 1)
        client.close()

    def test_cancelled_qualification_cannot_unlock(self):
        reservation = self.guard.begin_activation('home')
        self.guard.lock()
        self.guard.finish_activation(*reservation)
        self.assertEqual(self.guard.status()['state'], 'locked')

    def test_late_connect_cannot_outlive_lock(self):
        self.guard.activate('home')
        original = self.adapter.connect.side_effect
        def racing(*args):
            self.guard.lock()
            return original(*args)
        self.adapter.connect.side_effect = racing
        client, _ = self.request_after_race()
        client.close()
        self.assertFalse(self.guard.connections)

    def request_after_race(self):
        client = socket.create_connection(self.gate.server_address, 2)
        client.sendall(b'CONNECT sensitive.example.org:443 HTTP/1.1\r\n\r\n')
        self.assertNotIn(b'200', client.recv(256))
        time.sleep(.05)
        return client, None

    def test_stale_and_failed_check_lock(self):
        self.guard.activate('home')
        self.guard.verified_at -= 46
        client, headers = self.request()
        self.assertIn(b'403', headers)
        client.close()
        self.guard.activate('home')
        self.guard.checker = Mock(side_effect=policy.GuardError('test'))
        self.guard.recheck()
        self.assertEqual(self.guard.status()['state'], 'locked')


class DashboardTests(unittest.TestCase):
    def test_backend_exits_when_native_parent_is_gone(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = subprocess.run([sys.executable, '-B', '-m', 'mac_guard.app', '--state', temporary, '--parent-pid', '0'],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8)
            self.assertEqual(result.returncode, 0)

    def test_auth_origin_and_redaction(self):
        with tempfile.TemporaryDirectory() as temporary:
            guard = Guard(profile())
            with patch('socket.getfqdn', side_effect=AssertionError('Loopback bind used DNS')):
                server = Dashboard(guard, Mock(), Path(temporary))
            threading.Thread(target=server.serve_forever, daemon=True).start()
            def request(method, path, body=None, **headers):
                connection = http.client.HTTPConnection(*server.server_address, timeout=2)
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                result = response.status, response.read()
                connection.close()
                return result
            try:
                self.assertEqual(request('GET', '/api/status')[0], 403)
                headers = {'Authorization': 'Bearer ' + server.session_credential, 'Content-Type': 'application/json'}
                code, body = request('GET', '/api/status', **headers)
                self.assertEqual(code, 200)
                for value in ['password', 'fixture-user', 'proxy.example.org', '1.1.1.1']:
                    self.assertNotIn(value, body.decode())
                self.assertEqual(request('POST', '/api/lock', '{}', Origin='https://evil.example.org', **headers)[0], 403)
                self.assertEqual(request('POST', '/api/lock', '{}', **headers)[0], 200)
                self.assertEqual(request('POST', '/api/open', '{"url":"https://example.org"}', **headers)[0], 400)
                self.assertEqual(request('GET', '/', Host='evil.example.org')[0], 403)
                self.assertEqual(request('GET', '/../../etc/passwd')[0], 404)
            finally:
                server.shutdown()
                server.server_close()


class VPNTests(unittest.TestCase):
    @patch('mac_guard.transport.sys.platform', 'darwin')
    @patch('mac_guard.transport.socket.if_nametoindex', return_value=9)
    def test_dns_uses_bound_bootstrap_not_system_resolution(self, _):
        adapter = transport.BoundVPN({'interface': 'utun9'})
        body = b'{"Status":0,"Answer":[{"type":1,"data":"1.1.1.1"}]}'
        secure = Mock()
        secure.makefile.return_value = io.BytesIO(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(body)).encode() + b'\r\n\r\n' + body)
        adapter.context = Mock()
        adapter.context.wrap_socket.return_value.__enter__ = Mock(return_value=secure)
        adapter.context.wrap_socket.return_value.__exit__ = Mock(return_value=False)
        adapter._socket = Mock()
        with patch('mac_guard.transport.socket.getaddrinfo', side_effect=AssertionError('system DNS used')):
            self.assertEqual(adapter._resolve('example.org'), ['1.1.1.1'])
        adapter._socket.assert_called_once_with('1.1.1.1', 443)

    @patch('mac_guard.transport.sys.platform', 'darwin')
    @patch('mac_guard.transport.socket.if_nametoindex', return_value=9)
    def test_each_socket_is_bound_before_connect(self, index):
        adapter = transport.BoundVPN({'interface': 'utun9'})
        for address, level, option in [('1.1.1.1', socket.IPPROTO_IP, 25), ('2606:4700:4700::1111', socket.IPPROTO_IPV6, 125)]:
            with patch('mac_guard.transport.socket.socket') as factory:
                connection = factory.return_value
                adapter._socket(address, 443)
                calls = connection.method_calls
                self.assertLess(calls.index(unittest.mock.call.setsockopt(level, option, 9)), calls.index(unittest.mock.call.connect((address, 443))))
        index.return_value = 10
        with patch('mac_guard.transport.socket.socket') as factory, self.assertRaises(policy.GuardError):
            adapter._socket('1.1.1.1', 443)
        factory.assert_not_called()

    @patch('mac_guard.transport.sys.platform', 'darwin')
    @patch('mac_guard.transport.socket.if_nametoindex', return_value=9)
    def test_binding_error_never_retries_unbound(self, _):
        adapter = transport.BoundVPN({'interface': 'utun9'})
        with patch('mac_guard.transport.socket.socket') as factory:
            factory.return_value.setsockopt.side_effect = OSError('missing interface')
            with self.assertRaises(policy.GuardError): adapter._socket('1.1.1.1', 443)
            factory.return_value.connect.assert_not_called()
            factory.return_value.close.assert_called_once()
            self.assertEqual(factory.call_count, 1)


class TLSFixture(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, *args): pass


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        root = Path(cls.temporary.name)
        cert, key = root / 'cert.pem', root / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                        '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
                        '-keyout', str(key), '-out', str(cert)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        cls.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        cls.context.load_cert_chain(cert, key)
        cls.client_context = ssl.create_default_context(cafile=str(cert))
        cls.pin = hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()
        cls.requests = []
        cls.response = b'1.1.1.1'
        class Origin(socketserver.BaseRequestHandler):
            def handle(self):
                with cls.context.wrap_socket(self.request, server_side=True) as secure:
                    transport.read_headers(secure)
                    secure.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(cls.response)).encode() + b'\r\nConnection: close\r\n\r\n' + cls.response)
        cls.origin = TLSFixture(('127.0.0.1', 0), Origin)
        class Proxy(socketserver.BaseRequestHandler):
            def handle(self):
                with cls.context.wrap_socket(self.request, server_side=True) as secure:
                    header = transport.read_headers(secure)
                    cls.requests.append(header)
                    secure.sendall(b'HTTP/1.1 200 OK\r\n\r\n')
                    upstream = socket.create_connection(cls.origin.server_address)
                    def pump(source, target):
                        try:
                            while data := source.recv(16384): target.sendall(data)
                        except OSError: pass
                        finally: close(source); close(target)
                    threading.Thread(target=pump, args=(secure, upstream), daemon=True).start()
                    pump(upstream, secure)
        cls.proxy = TLSFixture(('127.0.0.1', 0), Proxy)
        for server in (cls.origin, cls.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.proxy, cls.origin): server.shutdown(); server.server_close()
        cls.temporary.cleanup()

    def route(self):
        return {**profile()['routes'][0], 'host': '127.0.0.1', 'port': self.proxy.server_address[1],
                'server_name': 'localhost', 'certificate_sha256': self.pin,
                'probe_url': 'https://localhost/'}

    def test_wrong_pin_and_untrusted_ca_send_no_credentials(self):
        for pin in ['0' * 64, '']:
            before = len(self.requests)
            adapter = transport.HTTPSProxy({**self.route(), 'certificate_sha256': pin})
            with self.assertRaises(policy.GuardError): adapter.connect('example.org', 443)
            self.assertEqual(len(self.requests), before)

    def test_complete_tls_in_tls_probe_and_wrong_exit(self):
        route = self.route()
        adapter = transport.HTTPSProxy(route)
        original = transport.TLSStream
        with patch('mac_guard.transport.TLSStream', side_effect=lambda raw, host: original(raw, host, self.client_context)):
            transport.qualify(adapter, route)
            self.assertIn(b'Proxy-Authorization: Basic ', self.requests[-1])
            with self.assertRaises(policy.GuardError):
                transport.qualify(adapter, {**route, 'approved_exit_ips': ['8.8.8.8']})

    def test_trace_probe_requires_one_approved_ip(self):
        route = {**self.route(), 'probe_format': 'cloudflare_trace'}
        adapter = transport.HTTPSProxy(route)
        original = transport.TLSStream
        try:
            with patch('mac_guard.transport.TLSStream', side_effect=lambda raw, host: original(raw, host, self.client_context)):
                type(self).response = b'fl=fixture\nip=1.1.1.1\ntls=TLSv1.3\n'
                transport.qualify(adapter, route)
                for body in (b'ip=8.8.8.8\n', b'ip=1.1.1.1\nip=8.8.8.8\n', b'no ip\n'):
                    type(self).response = body
                    with self.assertRaises(policy.GuardError): transport.qualify(adapter, route)
        finally:
            type(self).response = b'1.1.1.1'


if __name__ == '__main__': unittest.main()
