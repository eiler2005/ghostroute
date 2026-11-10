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
from mac_guard.browser import Browser, arguments, launch_environment
from mac_guard.install import extension, extension_id, native_host
from mac_guard.chrome_events import ChromeEvents, validate_message
from mac_guard.chrome_bridge import forward, serve
from mac_guard.service import Gate, Guard, close
from mac_guard.relay import relay


def profile():
    return {'schema_version': 1, 'sensitive_domains': ['sensitive.example.org'], 'routes': [{
        'id': 'home', 'kind': 'https_proxy', 'host': 'proxy.example.org', 'port': 443,
        'server_name': 'proxy.example.org', 'username': 'fixture-user', 'password': 'fixture-only',
        'allowed_domains': ['sensitive.example.org'], 'approved_exit_ips': ['1.1.1.1'],
        'probe_url': 'https://probe.example.org/'}]}


class PolicyTests(unittest.TestCase):
    def test_browser_launcher_drops_parent_bundle_identity_and_reports_early_exit(self):
        with patch.dict('os.environ', {'__CFBundleIdentifier':'org.ghostroute.guard'}):
            self.assertNotIn('__CFBundleIdentifier', launch_environment())
            with tempfile.TemporaryDirectory() as temporary:
                state=Path(temporary)
                chrome=state/'chrome';chrome.touch()
                process=Mock(pid=2345)
                process.poll.return_value=None
                process.wait.side_effect=subprocess.TimeoutExpired('fixture', .2)
                with patch('mac_guard.browser.CHROME', chrome), patch('mac_guard.browser.subprocess.Popen', return_value=process) as launch:
                    browser=Browser(state,23456);browser.open('https://example.org/')
                    self.assertNotIn('__CFBundleIdentifier', launch.call_args.kwargs['env'])
                    self.assertIn('--new-window', launch.call_args.args[0])
                    self.assertEqual(browser.running_pid,2345)
                    self.assertEqual(json.loads((state/'Browser/Default/Preferences').read_text())['profile']['name'],'GhostRoute Guard')
                (state/'browser-pid').unlink()
                process.wait.side_effect=None;process.wait.return_value=1
                with patch('mac_guard.browser.CHROME', chrome), patch('mac_guard.browser.subprocess.Popen', return_value=process):
                    browser=Browser(state,23456)
                    with self.assertRaises(policy.GuardError):browser.open('https://example.org/')
                    self.assertIsNone(browser.running_pid)

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
            self.assertEqual(rules[0]['condition']['requestDomains'], ['sensitive.example.org'])
            self.assertIn('main_frame', rules[0]['condition']['resourceTypes'])
            self.assertIn('xmlhttprequest', rules[0]['condition']['resourceTypes'])
            manifest = json.loads((Path(temporary) / 'manifest.json').read_text())
            self.assertEqual(set(manifest['permissions']), {'declarativeNetRequest', 'declarativeNetRequestFeedback', 'nativeMessaging', 'proxy', 'privacy'})
            self.assertNotIn('host_permissions', manifest)
            self.assertNotIn('content_scripts', manifest)


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

    def test_journal_live_bytes_lock_and_clear(self):
        self.guard.activate('home')
        client, headers = self.request()
        self.assertIn(b'200', headers)
        data = b'not-a-url-or-credential' * 4096
        client.sendall(data)
        received = bytearray()
        while len(received) < len(data):
            received.extend(client.recv(len(data) - len(received)))
        deadline = time.monotonic() + 2
        while self.guard.status()['bytes_received'] < len(data) and time.monotonic() < deadline:
            time.sleep(.01)
        before = self.guard.status()
        self.assertEqual(before['connections'], 1)
        self.assertEqual(before['bytes_sent'], len(data))
        self.assertEqual(before['bytes_received'], len(data))
        event = next(e for e in self.guard.activity()['events'] if e['kind'] == 'allowed')
        self.assertEqual(event['state'], 'open')
        self.assertNotIn('not-a-url', json.dumps(self.guard.activity()))
        self.guard.lock()
        client.close()
        time.sleep(.03)
        self.assertEqual(self.guard.status()['errors'], 0, 'Intentional Lock counted as a network error')
        event = next(e for e in self.guard.activity()['events'] if e['kind'] == 'allowed')
        self.assertEqual(event['state'], 'closed')
        self.assertEqual(event['close_reason'], 'manual_lock')
        self.assertIsInstance(event['duration_ms'], int)
        self.guard.clear_activity()
        self.assertEqual(self.guard.activity()['events'], [])
        self.assertEqual(self.guard.status()['bytes_sent'], before['bytes_sent'])
        self.assertEqual(self.guard.status()['allowed'], 1)

    def test_denials_errors_and_malformed_requests_are_distinct_and_redacted(self):
        client, _ = self.request()
        client.close()
        self.guard.activate('home')
        client, _ = self.request('other.example.org')
        client.close()
        self.adapter.connect.side_effect = OSError('password=fixture-secret upstream=proxy.example.org')  # FAKE exception proves redaction.
        client, _ = self.request()
        client.close()
        client = socket.create_connection(self.gate.server_address, 2)
        client.sendall(b'GET http://example.org/private?secret=hidden HTTP/1.1\r\nAuthorization: bearer hidden\r\n\r\n')  # FAKE request payload.
        self.assertIn(b'403', client.recv(512))
        client.close()
        activity = self.guard.activity()
        reasons = {e['reason'] for e in activity['events']}
        self.assertTrue({'access_closed', 'not_allowed', 'upstream_failed', 'unsupported_protocol'} <= reasons)
        self.assertEqual(self.guard.status()['blocked'], 3)
        self.assertEqual(self.guard.status()['errors'], 1)
        for value in ('fixture-secret', 'hidden', 'private?', 'proxy.example.org', 'Authorization'):
            self.assertNotIn(value, json.dumps(activity))

    def test_journal_is_bounded_and_snapshots_cannot_mutate_events(self):
        for _ in range(350):self.guard.reject('access_closed', 'example.org')
        snapshot = self.guard.activity()
        self.assertEqual(len(snapshot['events']), 300)
        self.assertEqual(self.guard.status()['blocked'], 350)
        snapshot['events'][0]['host'] = 'tampered.example.org'
        self.assertEqual(self.guard.activity()['events'][0]['host'], 'example.org')

    def test_fixed_port_rebinds_after_connections_but_not_over_live_listener(self):
        port = self.gate.server_address[1]
        with self.assertRaises(OSError):Gate(Guard(profile()), port)
        self.guard.activate('home')
        client, _ = self.request()
        self.guard.lock();client.close()
        self.gate.shutdown();self.gate.server_close()
        self.gate = Gate(Guard(profile()), port)
        threading.Thread(target=self.gate.serve_forever, daemon=True).start()
        client, headers = self.request()
        self.assertIn(b'403', headers)
        client.close()


class DashboardTests(unittest.TestCase):
    def test_second_engine_returns_typed_startup_failure_without_owner_token(self):
        with tempfile.TemporaryDirectory(prefix='guard-start-', dir='/tmp') as temporary:
            first = subprocess.Popen([sys.executable,'-B','-m','mac_guard.app','--state',temporary],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                bootstrap = json.loads(first.stdout.readline())
                second = subprocess.run([sys.executable,'-B','-m','mac_guard.app','--state',temporary],capture_output=True,timeout=5)
                self.assertNotEqual(second.returncode, 0)
                self.assertEqual(json.loads(second.stdout), {'error':'already_running'})
                self.assertNotIn(bootstrap['url'].split('#')[1].encode(), second.stdout + second.stderr)
            finally:
                first.terminate();first.communicate(timeout=8)

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
                self.assertEqual(request('GET', '/api/activity')[0], 403)
                headers = {'Authorization': 'Bearer ' + server.session_credential, 'Content-Type': 'application/json'}
                code, body = request('GET', '/api/status', **headers)
                self.assertEqual(code, 200)
                for value in ['password', 'fixture-user', 'proxy.example.org', '1.1.1.1']:
                    self.assertNotIn(value, body.decode())
                self.assertEqual(request('POST', '/api/lock', '{}', Origin='https://evil.example.org', **headers)[0], 403)
                self.assertEqual(request('POST', '/api/lock', '{}', **headers)[0], 200)
                self.assertEqual(request('POST', '/api/activity/clear', '{}', Origin='https://evil.example.org', **headers)[0], 403)
                self.assertEqual(request('POST', '/api/activity/clear', '{}', **headers)[0], 200)
                self.assertEqual(json.loads(request('GET', '/api/activity', **headers)[1])['events'], [])
                self.assertEqual(request('POST', '/api/open', '{"url":"https://example.org"}', **headers)[0], 400)
                self.assertTrue(any(e['reason']=='access_closed' for e in guard.activity()['events']))
                guard.factory = lambda _: Mock()
                guard.checker = lambda *_: None
                guard.activate('home')
                self.assertEqual(request('POST', '/api/open', '{"url":"https://other.example.org"}', **headers)[0], 400)
                self.assertEqual(request('POST', '/api/open', '{"url":"https://sensitive.example.org/path?private=value"}', **headers)[0], 200)
                self.assertTrue(any(e['reason']=='browser_opened' and e['host']=='sensitive.example.org' for e in guard.activity()['events']))
                self.assertNotIn('private=value', json.dumps(guard.activity()))
                self.assertEqual(request('GET', '/', Host='evil.example.org')[0], 403)
                self.assertEqual(request('GET', '/../../etc/passwd')[0], 404)
            finally:
                server.shutdown()
                server.server_close()


class ChromeEventTests(unittest.TestCase):
    def test_allowed_rule_match_is_metadata_not_gateway_connection(self):
        guard = Guard(profile())
        message = {'op':'allowed', 'profile':'a'*32, 'host':'sensitive.example.org',
                   'method':'GET', 'resource_type':'main_frame', 'rule_id':900001}
        guard.chrome_event(validate_message(message))
        event = guard.activity()['events'][0]
        self.assertEqual((event['kind'], event['reason'], event['source']), ('allowed', 'chrome_allowed', 'chrome'))
        self.assertEqual(guard.status()['chrome_allowed'], 1)
        self.assertEqual(guard.status()['allowed'], 0)
        self.assertEqual(guard.status()['connections'], 0)
        self.assertEqual(guard.status()['state'], 'locked')
        self.assertIsNone(event['duration_ms'])
        for change in ({'rule_id':1}, {'rule_id':True}, {'url':'https://sensitive.example.org/private'}, {'body':'private'}):
            with self.assertRaises(policy.GuardError): validate_message(dict(message, **change))
        with self.assertRaises(policy.GuardError): validate_message(dict(message, op='blocked'))
        guard.clear_activity()
        self.assertEqual(guard.status()['chrome_allowed'], 1)

    def test_native_ingress_is_metadata_only_and_cannot_unlock(self):
        with tempfile.TemporaryDirectory(prefix='guard-ipc-', dir='/tmp') as temporary:
            state = Path(temporary)
            guard = Guard(profile())
            server = ChromeEvents(guard, state)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            heartbeat = {'op':'heartbeat', 'profile':'a'*32, 'version':'0.2.0', 'rules_enabled':True}
            blocked = {'op':'blocked', 'profile':'a'*32, 'host':'sensitive.example.org', 'method':'POST', 'resource_type':'xmlhttprequest', 'rule_id':1}
            try:
                self.assertEqual((state/'chrome-events.sock').stat().st_mode & 0o777, 0o600)
                self.assertTrue(forward(state, heartbeat)['ok'])
                self.assertTrue(guard.status()['chrome_connected'])
                self.assertTrue(forward(state, blocked)['ok'])
                for change in ({'url':'https://sensitive.example.org/?secret=x'}, {'cookies':'secret'}, {'method':[]}, {'op':'activate'}, {'host':'example.org/path'}):  # FAKE metadata.
                    self.assertFalse(forward(state, dict(blocked, **change))['ok'])
                event = guard.activity()['events'][0]
                self.assertEqual(event['source'], 'chrome')
                self.assertEqual(event['method'], 'POST')
                self.assertEqual(guard.status()['blocked'], 1)
                self.assertEqual(guard.status()['state'], 'locked')
                self.assertNotIn('secret', json.dumps(guard.activity()))
                heartbeat['rules_enabled'] = False
                self.assertTrue(forward(state, heartbeat)['ok'])
                self.assertFalse(guard.status()['chrome_connected'])
            finally:
                server.shutdown();server.server_close()
            self.assertFalse(forward(state, heartbeat)['ok'])

    def test_native_frames_are_bounded_and_origin_is_fixed(self):
        import struct
        message = json.dumps({'op':'heartbeat'}).encode()
        output = io.BytesIO()
        with patch('mac_guard.chrome_bridge.forward', return_value={'ok':True}) as send:
            serve(io.BytesIO(struct.pack('=I',len(message))+message), output, Path('/fixture'))
            self.assertEqual(send.call_count, 1)
        length = struct.unpack('=I',output.getvalue()[:4])[0]
        self.assertEqual(json.loads(output.getvalue()[4:4+length]), {'ok':True})
        with patch('mac_guard.chrome_bridge.forward') as send:
            serve(io.BytesIO(struct.pack('=I',8193)),io.BytesIO(),Path('/fixture'))
            send.assert_not_called()
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            destination = state/'Chrome Blocker'
            native_host(state,destination,state/'manifests',Path(sys.executable))
            manifest = json.loads((state/'manifests/org.ghostroute.guard.events.json').read_text())
            self.assertEqual(manifest['allowed_origins'], ['chrome-extension://'+extension_id(destination)+'/'])
            host = Path(manifest['path'])
            result = subprocess.run([str(host),'chrome-extension://'+'a'*32+'/'],capture_output=True,timeout=5)
            self.assertNotEqual(result.returncode,0)
            self.assertEqual(result.stdout,b'')
            self.assertEqual(host.stat().st_mode & 0o777,0o700)


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
                    try:
                        relay(secure, upstream, idle_timeout=5)
                    finally:
                        close(upstream)
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

    def test_tls_relay_drains_large_response_before_close(self):
        adapter = transport.HTTPSProxy(self.route())
        payload = b'fixture response ' * 65536
        try:
            type(self).response = payload
            raw = adapter.connect('localhost', 443)
            try:
                stream = transport.TLSStream(raw, 'localhost', self.client_context)
                stream.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
                response = http.client.HTTPResponse(stream)
                response.begin()
                self.assertEqual(response.read(), payload)
            finally:
                raw.close()
        finally:
            type(self).response = b'1.1.1.1'


if __name__ == '__main__': unittest.main()
