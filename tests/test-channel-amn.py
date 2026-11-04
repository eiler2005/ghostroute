#!/usr/bin/env python3
"""Offline Amn policy equivalence, containment, and credential isolation checks."""
import copy
import importlib.util
import ipaddress
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    from importlib.machinery import SourceFileLoader
    spec = importlib.util.spec_from_loader(name, SourceFileLoader(name, str(ROOT / path)))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


policy = load('amn_policy', 'modules/routing-core/router/channel-amn-policy.py')
runtime = load('amn_runtime', 'modules/routing-core/router/channel-amn.py')
profiles = load('amn_profiles', 'modules/routing-core/bin/channel-amn-profile')
fixtures = runpy.run_path(str(ROOT / 'tests/test-sensitive-sites.py'))


def fixture_bundle(out):
    options = {'endpoint': 'home.example.invalid', 'port': 12021, 'subnet': '10.203.44.0/24', 'table': 20310, 'priority': 20310}
    profiles.create(options, out)
    return json.loads((out / 'settings.json').read_text())


def fake_qr(payload, path):
    path.write_bytes(b'\x89PNG\r\n\x1a\n')


def ipc_state(settings):
    lines = ['private_key=' + runtime.keyhex(settings['private_key']), 'listen_port=' + str(settings['port'])]
    lines += [k + '=' + str(v) for k, v in settings['obfuscation'].items()]
    for peer in settings['peers']:
        lines += ['public_key=' + runtime.keyhex(peer['public_key']), 'preshared_key=' + runtime.keyhex(peer['preshared_key']), 'allowed_ip=' + peer['address'] + '/32']
    return '\n'.join(lines) + '\nerrno=0\n\n'


def decide(config, host, port=443, network='tcp', address='198.51.100.20', managed=True):
    """Evaluate the fixture's match fields; route-options represent DNS rewriting."""
    for rule in config['route']['rules']:
        if 'network' in rule and network != rule['network']:
            continue
        if 'port' in rule:
            ports = rule['port'] if isinstance(rule['port'], list) else [rule['port']]
            if port not in ports:
                continue
        if 'domain' in rule and host not in rule['domain']:
            continue
        if 'domain_suffix' in rule and not any(host == d or host.endswith('.' + d) for d in rule['domain_suffix']):
            continue
        if 'rule_set' in rule and not managed:
            continue
        if 'ip_cidr' in rule and not any(ipaddress.ip_address(address) in ipaddress.ip_network(n) for n in rule['ip_cidr']):
            continue
        if rule.get('action') == 'reject':
            return 'reject'
        if 'outbound' in rule:
            return rule['outbound']
    return config['route']['final']


class AmnTests(unittest.TestCase):
    def setUp(self):
        self.source = fixtures['render']()
        self.config = policy.project(self.source, {'policy_address': '10.203.44.253/30', 'mtu': 1280})

    def test_selected_client_policy_equivalence(self):
        for host in ('claude.ai', 'api.anthropic.com', 'chatgpt.com', 'api.openai.com', 'gemini.google.com', 'notebooklm.google.com', 'youtube.com', 'evilclaude.ai', 'claude.ai.attacker.invalid', 'unmanaged.example.invalid'):
            self.assertEqual(decide(self.config, host, managed=not host.startswith('unmanaged.')),
                             fixtures['route'](self.source, 'channel-b-relay-socks', host), host)
        self.assertEqual(decide(self.config, '', address='198.51.100.91', port=80), 'reality-out')

    def test_private_targets_and_ipv6_are_contained_but_dns_reaches_router(self):
        for address in ('10.0.0.1', '192.168.1.1', '169.254.169.254', '127.0.0.1', '2606:4700:4700::1111'):
            self.assertEqual(decide(self.config, '', address=address, managed=False), 'reject')
        for transport in ('tcp', 'udp'):
            self.assertEqual(decide(self.config, '', port=53, network=transport, address='10.203.44.53'), 'direct-out')
        self.assertEqual(self.config['route']['rules'][0]['override_address'], '127.0.0.1')

    def test_quic_containment_is_lab_local(self):
        self.assertEqual(decide(self.config, 'claude.ai', network='udp'), 'reject')
        self.assertEqual(decide(self.config, 'claude.ai'), 'sensitive-out')
        self.assertEqual(decide(self.config, '', port=123, network='udp', managed=False), 'direct-out')
        self.assertFalse(any(r.get('action') == 'reject' for r in self.source['route']['rules']))

    def test_no_mutation_or_production_listeners(self):
        original = copy.deepcopy(self.source)
        policy.project(self.source, {'policy_address': '10.203.44.253/30', 'mtu': 1280})
        self.assertEqual(self.source, original)
        self.assertEqual(len(self.config['inbounds']), 1)
        tun = self.config['inbounds'][0]
        self.assertEqual(tun['tag'], 'channel-amn-tun')
        self.assertFalse(tun['auto_route'])
        self.assertFalse(tun['auto_redirect'])
        self.assertEqual(tun['stack'], 'gvisor')
        self.assertNotIn('experimental', self.config)
        self.assertEqual(self.config['dns'], self.source['dns'])
        for rule in self.config['route']['rules']:
            if 'inbound' in rule:
                self.assertEqual(rule['inbound'], 'channel-amn-tun')

    def test_sensitive_stays_pinned_when_general_backend_changes(self):
        source = fixtures['render'](router_managed_egress_mode='primary_vps', vps_ssh_host='primary.example.invalid')
        config = policy.project(source, {'policy_address': '10.203.44.253/30', 'mtu': 1280})
        self.assertEqual(decide(config, 'claude.ai'), 'sensitive-out')
        sensitive = next(o for o in config['outbounds'] if o['tag'] == 'sensitive-out')
        self.assertEqual(sensitive['server'], 'sensitive.example.invalid')
        self.assertNotIn('detour', sensitive)

    def test_unsupported_source_policy_fails_closed(self):
        for change in ('dns', 'unscoped', 'selector'):
            source = copy.deepcopy(self.source)
            if change == 'dns':
                source['route']['rules'] = [r for r in source['route']['rules'] if r.get('port') != 53]
            elif change == 'unscoped':
                source['route']['rules'].insert(0, {'outbound': 'direct-out'})
            else:
                source['outbounds'][0]['type'] = 'selector'
            with self.assertRaises(ValueError):
                policy.project(source, {'policy_address': '10.203.44.253/30', 'mtu': 1280})

    def test_policy_tun_reserves_its_private_link_prefix(self):
        with self.assertRaises(ValueError):
            policy.project(self.source, {'policy_address': '10.203.44.254/32', 'mtu': 1280})

    def test_firewall_guards_scope_to_new_interfaces_and_port(self):
        calls = []
        with patch.object(runtime, 'ipt', side_effect=lambda *a, **kw: calls.append(a)):
            runtime.guards({'subnet': '10.203.44.0/24', 'port': 12021})
        for command in calls:
            if command[1] == '-I':
                self.assertTrue('gr-amn' in command or 'gr-amn-tun' in command or '--dport' in command)
            self.assertNotIn('OUTPUT', command)
            self.assertNotIn('PREROUTING', command)
            self.assertNotIn('-F', command)
        self.assertIn(('ip6tables', '-A', 'GR_AMN_FWD', '-j', 'DROP'), calls)

    def test_merlin_firewall_cli_does_not_require_modern_wait_option(self):
        with patch.object(runtime, 'call') as call:
            runtime.ipt('iptables', '-S')
            call.assert_called_once_with('iptables', '-S', check=True)

    def test_lab_binary_name_is_outside_production_killall_ownership(self):
        source = (ROOT / 'modules/routing-core/router/channel-amn.py').read_text()
        self.assertIn("spawn('policy', [str(BASE / 'sing-box-amn')", source)
        self.assertNotIn("spawn('policy', ['/opt/bin/sing-box'", source)

    def test_start_failure_rolls_back_owned_lab(self):
        with tempfile.TemporaryDirectory() as temp:
            run = Path(temp)
            with patch.object(runtime, 'RUN', run), patch.object(runtime, 'preflight'), patch.object(runtime, 'guards', side_effect=RuntimeError('fixture')), patch.object(runtime, 'stop') as stop:
                with self.assertRaises(RuntimeError):
                    runtime.start({'port': 12021})
                stop.assert_called_once_with({'port': 12021})

    def test_profiles_use_distinct_keys_and_refuse_rotation(self):
        options = {'endpoint': 'home.example.invalid', 'port': 12021, 'subnet': '10.203.44.0/24', 'table': 20310, 'priority': 20310}
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            profiles.create(options, out)
            settings = json.loads((out / 'settings.json').read_text())
            a = json.loads((out / 'iphone.private.json').read_text())
            b = json.loads((out / 'probe.private.json').read_text())
            self.assertNotEqual(a['private_key'], b['private_key'])
            self.assertNotEqual(a['preshared_key'], b['preshared_key'])
            self.assertNotEqual(a['private_key'], settings['private_key'])
            self.assertIn('AllowedIPs = 0.0.0.0/0, ::/0', (out / 'Amn-iphone.conf').read_text())
            before = (out / 'settings.json').read_bytes()
            with self.assertRaises(ValueError):
                profiles.create(options, out)
            self.assertEqual(before, (out / 'settings.json').read_bytes())

    def test_eight_named_profiles_are_unique_and_preserve_bootstrap(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            before = fixture_bundle(out)
            old_client = (out / 'iphone.private.json').read_bytes()
            old_import = (out / 'Amn-iphone.conf').read_bytes()
            with patch.object(profiles, 'encode_qr', side_effect=fake_qr) as encode:
                manifest = profiles.export_eight(out)
            after = json.loads((out / 'settings.json').read_text())
            self.assertEqual([p['name'] for p in manifest], [f'Channel Amn {i:02d}' for i in range(1, 9)])
            self.assertEqual(after['peers'][:2], before['peers'])
            self.assertEqual(after['private_key'], before['private_key'])
            self.assertEqual((out / 'iphone.private.json').read_bytes(), old_client)
            self.assertEqual((out / 'Amn-iphone.conf').read_bytes(), old_import)
            runtime.validate_settings(after)
            self.assertEqual(len(after['peers']), 9)
            self.assertEqual(len({p['public_key'] for p in after['peers']}), 9)
            self.assertEqual(encode.call_count, 8)
            for call in encode.call_args_list:
                payload, png = call.args
                self.assertEqual(payload, (out / 'clients' / (png.stem + '.conf')).read_text())
            with zipfile.ZipFile(out / 'Channel-Amn-8-profiles.private.zip') as bundle:
                self.assertEqual(len(bundle.namelist()), 17)
                self.assertFalse(any('private.json' in name or 'probe' in name or 'settings' in name for name in bundle.namelist()))
                self.assertFalse(any(before['private_key'].encode() in bundle.read(name) for name in bundle.namelist()))

    def test_batch_regeneration_reuses_all_credentials(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles, 'encode_qr', side_effect=fake_qr):
            out = Path(temp)
            fixture_bundle(out)
            profiles.export_eight(out)
            paths = [out / 'settings.json'] + list((out / 'clients').glob('*.private.json')) + list((out / 'clients').glob('*.conf'))
            before = {p: p.read_bytes() for p in paths}
            profiles.export_eight(out)
            self.assertEqual(before, {p: p.read_bytes() for p in paths})

    def test_qr_failure_does_not_publish_partially_generated_batch(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            fixture_bundle(out)
            before = (out / 'settings.json').read_bytes()
            with patch.object(profiles, 'encode_qr', side_effect=RuntimeError('fixture')):
                with self.assertRaises(RuntimeError):
                    profiles.export_eight(out)
            self.assertEqual(before, (out / 'settings.json').read_bytes())
            self.assertFalse((out / 'clients').exists())

    def test_missing_slot_credentials_are_not_silently_rotated(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles, 'encode_qr', side_effect=fake_qr):
            out = Path(temp)
            fixture_bundle(out)
            profiles.export_eight(out)
            (out / 'clients/Channel-Amn-04.private.json').unlink()
            before = (out / 'settings.json').read_bytes()
            with self.assertRaises(ValueError):
                profiles.export_eight(out)
            self.assertEqual(before, (out / 'settings.json').read_bytes())

    def test_reserved_and_duplicate_peer_addresses_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            source = fixture_bundle(Path(temp))
            for address in ('10.203.44.53', '10.203.44.253', '10.203.44.1', '192.0.2.10', source['peers'][0]['address']):
                candidate = copy.deepcopy(source)
                candidate['peers'][1]['address'] = address
                with self.assertRaises((AssertionError, ValueError)):
                    runtime.validate_settings(candidate)

    def test_live_peer_sync_only_adds_seven_new_keys(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles, 'encode_qr', side_effect=fake_qr):
            out = Path(temp)
            before = fixture_bundle(out)
            profiles.export_eight(out)
            after = json.loads((out / 'settings.json').read_text())
            run = out / 'runtime'
            run.mkdir()
            (run / 'owned.json').write_text(json.dumps(before))
            with patch.object(runtime, 'RUN', run), patch.object(runtime, 'BASE', out), patch.object(runtime, 'owned_pid', return_value=1), patch.object(runtime, 'uapi', side_effect=[ipc_state(before), 'errno=0\n\n', ipc_state(after)]) as rpc, patch.object(runtime, 'call') as call:
                result = runtime.sync_peers(after)
            self.assertEqual(result, {'added_peers': 7, 'configured_peers': 9})
            payload = rpc.call_args_list[1].args[0]
            self.assertNotIn('private_key' + '=', payload)
            self.assertNotIn('listen_port=', payload)
            self.assertNotIn('replace_peers=', payload)
            self.assertNotIn('remove=true', payload)
            for peer in before['peers']:
                self.assertNotIn(runtime.keyhex(peer['public_key']), payload)
            call.assert_not_called()
            self.assertEqual(json.loads((run / 'owned.json').read_text()), after)

    def test_repeated_live_sync_sends_no_mutating_control_request(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles, 'encode_qr', side_effect=fake_qr):
            out = Path(temp)
            fixture_bundle(out)
            profiles.export_eight(out)
            settings = json.loads((out / 'settings.json').read_text())
            (out / 'owned.json').write_text(json.dumps(settings))
            with patch.object(runtime, 'RUN', out), patch.object(runtime, 'owned_pid', return_value=1), patch.object(runtime, 'uapi', return_value=ipc_state(settings)) as rpc:
                result = runtime.sync_peers(settings)
            self.assertEqual(result, {'added_peers': 0, 'configured_peers': 9})
            self.assertTrue(all(c.args == ('get=1\n\n',) for c in rpc.call_args_list))

    def test_live_peer_sync_rejects_identity_and_existing_peer_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            out = Path(temp)
            before = fixture_bundle(out)
            (out / 'owned.json').write_text(json.dumps(before))
            candidates = []
            for field in ('port', 'mtu'):
                changed = copy.deepcopy(before)
                changed[field] += 1
                candidates.append(changed)
            changed = copy.deepcopy(before)
            changed['peers'] = changed['peers'][1:]
            candidates.append(changed)
            changed = copy.deepcopy(before)
            changed['peers'][0]['address'] = '10.203.44.10'
            candidates.append(changed)
            for changed in candidates:
                with patch.object(runtime, 'RUN', out), patch.object(runtime, 'owned_pid', return_value=1), patch.object(runtime, 'uapi') as rpc:
                    with self.assertRaises(ValueError):
                        runtime.sync_peers(changed)
                    rpc.assert_not_called()

    def test_failed_live_addition_removes_only_new_keys_and_restores_settings(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles, 'encode_qr', side_effect=fake_qr):
            out = Path(temp)
            before = fixture_bundle(out)
            profiles.export_eight(out)
            after = json.loads((out / 'settings.json').read_text())
            run = out / 'runtime'
            run.mkdir()
            (run / 'owned.json').write_text(json.dumps(before))
            with patch.object(runtime, 'RUN', run), patch.object(runtime, 'BASE', out), patch.object(runtime, 'owned_pid', return_value=1), patch.object(runtime, 'uapi', side_effect=[ipc_state(before), 'errno=0\n\n', ipc_state(before), 'errno=0\n\n']) as rpc:
                with self.assertRaises(ValueError):
                    runtime.sync_peers(after)
            rollback = rpc.call_args_list[-1].args[0]
            self.assertIn('remove=true', rollback)
            for peer in before['peers']:
                self.assertNotIn(runtime.keyhex(peer['public_key']), rollback)
            self.assertEqual(json.loads((out / 'settings.json').read_text()), before)
            self.assertEqual(json.loads((run / 'owned.json').read_text()), before)

    def test_secret_scan_keeps_public_endpoints_protected(self):
        scan = runpy.run_path(str(ROOT / 'modules/secrets-management/bin/secret-scan'))
        for address in ('100.64.0.0', '224.0.0.0', '240.0.0.0'):
            self.assertFalse(scan['is_public_ip'](address))
        shared = ipaddress.ip_network('100.64.0.0/10')
        self.assertTrue(scan['is_public_ip'](str(shared.network_address - 1)))
        self.assertTrue(scan['is_public_ip'](str(shared.broadcast_address + 1)))

    def test_lab_gate_keeps_routing_failures_blocking(self):
        import yaml
        gate = yaml.safe_load((ROOT / 'ansible/tasks/channel-amn-health-gate.yml').read_text())[0]
        expression = gate['failed_when']
        from jinja2 import Environment
        env = Environment()
        env.filters['from_json'] = json.loads
        evaluate = env.compile_expression(expression)
        for status, identity, blocked in [('OK', 'active_managed_egress', False),
                                           ('WARN', 'console_vps_router_tcp', False),
                                           ('WARN', 'active_managed_egress', True),
                                           ('CRIT', 'active_managed_egress', True)]:
            result = {'rc': 1 if status == 'WARN' else 2 if status == 'CRIT' else 0,
                      'stdout': json.dumps({'checks': [{'id': identity, 'status': status}]})}
            self.assertEqual(evaluate(channel_amn_health_gate=result), blocked)


if __name__ == '__main__':
    unittest.main()
