#!/usr/bin/env python3
"""AnyTLS lab policy parity, credential preservation and lifecycle containment."""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit, parse_qs, unquote

ROOT = Path(__file__).resolve().parents[1]
helpers = runpy.run_path(str(ROOT / 'tests/test-channel-amn.py'))
load, decide, fixtures = helpers['load'], helpers['decide'], helpers['fixtures']
policy = load('atls_policy', 'modules/routing-core/router/channel-anytls-policy.py')
runtime = load('atls_runtime', 'modules/routing-core/router/channel-anytls.py')
profiles = load('atls_profiles', 'modules/routing-core/bin/channel-anytls-profile')
OPTIONS = {'host': 'home.example.invalid', 'server_name': 'home.example.invalid', 'port': 12031,
           'certificate_path': '/opt/etc/example/cert.pem', 'key_path': '/opt/etc/example/key.pem'}


def settings():
    return dict(OPTIONS, users=[{'name': 'lab-client', 'password': 'fixture-client-' * 4},
                               {'name': 'lab-probe', 'password': 'fixture-probe-' * 4}])


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.source = fixtures['render']()
        self.cfg = policy.project(self.source, settings())

    def test_sensitive_managed_and_ordinary_follow_reference(self):
        for host in ('claude.ai', 'api.anthropic.com', 'chatgpt.com', 'api.openai.com',
                     'gemini.google.com', 'youtube.com', 'evilclaude.ai', 'claude.ai.attacker.invalid',
                     'unmanaged.example.invalid'):
            self.assertEqual(decide(self.cfg, host, managed=not host.startswith('unmanaged.')),
                             fixtures['route'](self.source, policy.REFERENCE, host), host)

    def test_private_ipv6_udp_denied_dns_forced_to_home(self):
        for address in ('127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '2001:db8::1'):
            self.assertEqual(decide(self.cfg, '', address=address, managed=False), 'reject')
        for network in ('tcp', 'udp'):
            self.assertEqual(decide(self.cfg, '', address='10.0.0.1', port=53, network=network), 'direct-out')
        self.assertEqual(self.cfg['route']['rules'][0]['override_address'], '127.0.0.1')
        for port in (443, 123, 5222):
            self.assertEqual(decide(self.cfg, 'telegram.example.invalid', port=port, network='udp'), 'reject')

    def test_projection_never_changes_production_or_copies_its_listeners(self):
        before = copy.deepcopy(self.source)
        cfg = policy.project(self.source, settings())
        self.assertEqual(before, self.source)
        self.assertEqual([i['type'] for i in cfg['inbounds']], ['anytls'])
        self.assertEqual(cfg['dns'], before['dns'])
        self.assertNotIn('experimental', cfg)
        for outbound in cfg['outbounds']:
            self.assertEqual(outbound, next(o for o in before['outbounds'] if o['tag'] == outbound['tag']))

    def test_unknown_policy_and_egress_dependencies_are_rejected(self):
        for change in ('unscoped', 'dns', 'user', 'selector', 'detour', 'terminal'):
            source = copy.deepcopy(self.source)
            if change == 'unscoped':
                source['route']['rules'].insert(0, {'outbound': 'direct-out'})
            elif change == 'dns':
                source['route']['rules'] = [r for r in source['route']['rules'] if r.get('port') != 53]
            elif change == 'user':
                next(r for r in source['route']['rules'] if policy.REFERENCE in r.get('inbound', []))['auth_user'] = 'other'
            elif change == 'terminal':
                source['route']['rules'].append({'inbound': policy.REFERENCE, 'outbound': 'reality-out'})
            else:
                source['outbounds'][0]['type' if change == 'selector' else 'detour'] = 'selector' if change == 'selector' else 'other'
            with self.subTest(change=change), self.assertRaises(ValueError):
                policy.project(source, settings())

    def test_private_bundle_has_distinct_credentials_verified_tls_and_refuses_overwrite(self):
        def render_qr(argv, **kwargs):
            Path(argv[2]).write_bytes(b'\x89PNG\r\n\x1a\n')
            self.assertTrue(kwargs['input'].startswith(b'anytls://'))
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles.subprocess, 'run', side_effect=render_qr):
            out = Path(temp) / 'bundle'
            s = profiles.generate(OPTIONS, out)
            uri = (out / 'AnyTLS-Lab.uri').read_text().strip()
            parsed = urlsplit(uri)
            self.assertEqual(unquote(parsed.username), s['users'][0]['password'])
            self.assertEqual(parse_qs(parsed.query)['insecure'], ['0'])
            self.assertNotEqual(s['users'][0]['password'], s['users'][1]['password'])
            self.assertNotIn(s['users'][1]['password'], (out / 'index.html').read_text())
            self.assertEqual((out / 'settings.json').stat().st_mode & 0o777, 0o600)
            self.assertTrue((out / 'AnyTLS-Lab.png').read_bytes().startswith(b'\x89PNG'))
            with self.assertRaises(ValueError):
                profiles.generate(OPTIONS, out)
            self.assertEqual(json.loads((out / 'settings.json').read_text()), s)


class LifecycleTests(unittest.TestCase):
    def test_stale_source_is_rejected_before_any_router_command(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime, 'RUN', Path(temp)), \
                patch.object(runtime, 'BASE', Path(temp)), patch.object(runtime, 'SOURCE', Path(temp) / 'source'), \
                patch.object(runtime, 'owned_pid', return_value=None), patch.object(runtime, 'call') as call:
            s=settings()
            (Path(temp) / 'source').write_bytes(b'changed')
            (Path(temp) / 'settings.json').write_text(json.dumps(s))
            (Path(temp) / 'policy.json').write_text(json.dumps(policy.project(fixtures['render'](),s)))
            (Path(temp) / 'policy.source.sha256').write_text(hashlib.sha256(b'original').hexdigest())
            with self.assertRaises(ValueError):
                runtime.preflight()
            call.assert_not_called()

    def test_start_failure_rolls_back_only_the_owned_ingress(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime, 'RUN', Path(temp)), \
                patch.object(runtime, 'preflight', return_value=settings()), \
                patch.object(runtime, 'call', side_effect=lambda *a, **k: calls.append(a) or subprocess.CompletedProcess(a, 0, '', '')), \
                patch.object(runtime, 'spawn', side_effect=RuntimeError('fixture startup failure')), \
                patch.object(runtime, 'terminate') as terminate:
            with self.assertRaises(RuntimeError):
                runtime.start()
            self.assertFalse((Path(temp) / 'owned.json').exists())
            self.assertEqual({c.args[0] for c in terminate.call_args_list}, {'watch', 'policy'})
        for call in calls:
            self.assertEqual(call[0], 'iptables')
            self.assertNotIn('FORWARD', call)
            self.assertNotIn('OUTPUT', call)
            self.assertNotIn('PREROUTING', call)
            if call[1] in ('-F', '-X'):
                self.assertEqual(call[2], runtime.CHAIN)

    def test_stale_pid_is_never_signalled(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime, 'RUN', Path(temp)), \
                patch.object(runtime, 'owned_pid', return_value=None), patch.object(runtime.os, 'kill') as kill:
            (Path(temp) / 'policy.pid').write_text('1')
            runtime.terminate('policy')
            kill.assert_not_called()

    def test_policy_change_contains_the_lab_without_restart(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime, 'RUN', Path(temp)), \
                patch.object(runtime, 'BASE', Path(temp)), patch.object(runtime, 'SOURCE', Path(temp) / 'source'), \
                patch.object(runtime, 'owned_pid', return_value=123), patch.object(runtime.time, 'sleep'), \
                patch.object(runtime, 'terminate') as terminate, patch.object(runtime.signal, 'signal'):
            (Path(temp) / 'source').write_bytes(b'changed')
            (Path(temp) / 'policy.source.sha256').write_text(hashlib.sha256(b'original').hexdigest())
            runtime.watch()
            terminate.assert_called_once_with('policy')
            self.assertTrue((Path(temp) / 'contained.txt').exists())

    def test_log_budget_contains_the_lab(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime, 'RUN', Path(temp)), \
                patch.object(runtime, 'BASE', Path(temp)), patch.object(runtime, 'SOURCE', Path(temp) / 'source'), \
                patch.object(runtime, 'owned_pid', return_value=123), patch.object(runtime.time, 'sleep'), \
                patch.object(runtime, 'terminate') as terminate, patch.object(runtime.signal, 'signal'):
            (Path(temp) / 'source').write_bytes(b'original')
            (Path(temp) / 'policy.source.sha256').write_text(hashlib.sha256(b'original').hexdigest())
            with (Path(temp) / 'policy.log').open('wb') as log:
                log.truncate(4*1024*1024+1)
            runtime.watch()
            terminate.assert_called_once_with('policy')
            self.assertEqual((Path(temp) / 'contained.txt').read_text(),'Lab log budget exceeded')


if __name__ == '__main__':
    unittest.main()
