#!/usr/bin/env python3
"""AnyTLS lab policy parity, credential preservation and lifecycle containment."""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import socket
import subprocess
import tempfile
import unittest
import zipfile
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
        self.assertEqual(decide(self.cfg, 'telegram.example.invalid', port=443, network='udp'), 'reject')
        self.assertEqual(decide(self.cfg, 'telegram.example.invalid', port=3478, network='udp'), 'reality-out')
        self.assertEqual(decide(self.cfg, '', port=123, network='udp', managed=False), 'direct-out')

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


class SecondClientTests(unittest.TestCase):
    def test_approved_bundle_verification_and_export_refusal_are_read_only(self):
        import hashlib
        def render_qr(argv, **kwargs): Path(argv[2]).write_bytes(b'fixture-png')
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles.subprocess, 'run', side_effect=render_qr):
            out = Path(temp) / 'bundle'
            profiles.generate(OPTIONS, out)
            profiles.add_second(out)
            s = profiles.export_eight(out)
            files = [p for p in (out/'clients').iterdir() if p.suffix in ('.png', '.uri', '.conf')]
            files += [out/name for name in ('AnyTLS-Lab.uri','AnyTLS-Lab.png','AnyTLS-Lab-02.uri','AnyTLS-Lab-02.png')]
            manifest = {'schema_version':1,
                'settings_sha256':hashlib.sha256(json.dumps(s,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
                'artifact_sha256':{str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
            approval = out/'production-approval.private.json'
            approval.write_text(json.dumps(manifest))
            profiles.verify_approval(out)
            before = {p:p.read_bytes() for p in out.rglob('*') if p.is_file()}
            with self.assertRaises(ValueError): profiles.export_eight(out)
            self.assertEqual(before, {p:p.read_bytes() for p in before})
            for p in files + [out/'settings.json']:
                original=p.read_bytes()
                p.write_bytes(original+b'changed')
                with self.subTest(file=p.name), self.assertRaises((ValueError, json.JSONDecodeError)):
                    profiles.verify_approval(out)
                p.write_bytes(original)
            captured=out/'captured.json';captured.write_text(json.dumps({**s,'port':s['port']+1}))
            with self.assertRaises(ValueError): profiles.verify_approval(out,captured)
            manifest['artifact_sha256'].pop(next(iter(manifest['artifact_sha256'])))
            approval.write_text(json.dumps(manifest))
            with self.assertRaises(ValueError): profiles.verify_approval(out)
            approval.unlink()
            with self.assertRaises(FileNotFoundError): profiles.verify_approval(out)

    def test_eight_exports_preserve_two_existing_identities_and_exclude_probe_from_zip(self):
        def render_qr(argv, **kwargs):
            Path(argv[2]).write_bytes(b'\x89PNG\r\n\x1a\n')
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles.subprocess, 'run', side_effect=render_qr):
            out=Path(temp)/'bundle'
            profiles.generate(OPTIONS,out)
            previous=profiles.add_second(out)
            original={name:(out/name).read_bytes() for name in ('AnyTLS-Lab.uri','AnyTLS-Lab.png','AnyTLS-Lab-02.uri','AnyTLS-Lab-02.png')}
            current=profiles.export_eight(out)
            self.assertEqual(current['users'][:3],previous['users'])
            self.assertEqual(len(current['users']),9)
            self.assertEqual(len({u['password'] for u in current['users']}),9)
            for name,data in original.items():self.assertEqual((out/name).read_bytes(),data)
            self.assertEqual(len(list((out/'clients').glob('*.png'))),8)
            probe=next(u['password'] for u in current['users'] if u['name']=='lab-probe')
            with zipfile.ZipFile(out/'Channel-anyT-8-profiles.private.zip') as archive:
                self.assertEqual(len([n for n in archive.namelist() if n.endswith('.png')]),8)
                self.assertFalse(any('settings' in n for n in archive.namelist()))
                for name in archive.namelist():self.assertNotIn(probe.encode(),archive.read(name))
            self.assertEqual(profiles.export_eight(out),current)
            self.assertEqual(json.loads((out/'settings.json').read_text()),current)

    def test_all_eight_issued_payloads_survive_reexport_and_policy_projection(self):
        def render_qr(argv, **kwargs):Path(argv[2]).write_bytes(b'\x89PNG'+kwargs['input'])
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles.subprocess,'run',side_effect=render_qr):
            out=Path(temp)/'bundle';profiles.generate(OPTIONS,out)
            approved=profiles.export_eight(out)
            saved={p.name:p.read_bytes() for p in (out/'clients').iterdir() if p.suffix in ('.png','.uri')}
            self.assertEqual(len(saved),16)
            projected=policy.project(fixtures['render'](),approved)
            self.assertEqual(projected['inbounds'][0]['users'],approved['users'])
            profiles.export_eight(out)
            self.assertEqual(saved,{name:(out/'clients'/name).read_bytes() for name in saved})

    def test_production_update_refuses_rekey_or_removal_of_each_issued_slot(self):
        approved=copy.deepcopy(settings())
        approved['users'] += [{'name':'lab-client-'+str(i).zfill(2),'password':('fixture-slot-'+str(i)+'-')*4} for i in range(2,9)]
        profiles.compatible_update(approved,copy.deepcopy(approved))
        for name in [u['name'] for u in approved['users'] if u['name']!='lab-probe']:
            for action in ('remove','rekey'):
                proposed=copy.deepcopy(approved)
                if action=='remove':proposed['users']=[u for u in proposed['users'] if u['name']!=name]
                else:next(u for u in proposed['users'] if u['name']==name)['password']='changed-production-secret-'*4
                with self.subTest(slot=name,action=action),self.assertRaises(ValueError):
                    profiles.compatible_update(approved,proposed)
        for field,value in [('host','other.example.invalid'),('port',OPTIONS['port']+1),('server_name','other.example.invalid')]:
            proposed=copy.deepcopy(approved);proposed[field]=value
            with self.subTest(field=field),self.assertRaises(ValueError):profiles.compatible_update(approved,proposed)

    def test_issued_uri_wire_format_is_a_fixed_compatibility_contract(self):
        s=settings();s['users'][0]['password']='fixture-approved-password-00000000'
        self.assertEqual(profiles.uri(s,'lab-client','Channel anyT 01'),
                         'anytls://fixture-approved-password-00000000@home.example.invalid:12031/'
                         '?sni=home.example.invalid&insecure=0#Channel%20anyT%2001')

    def test_existing_client_rotation_or_transport_change_is_refused(self):
        for field in ('users','port'):
            proposed=copy.deepcopy(settings())
            if field=='users':proposed['users'][0]['password']='a-different-secret-'*4
            else:proposed['port']+=1
            with self.assertRaises(ValueError):profiles.compatible_update(settings(),proposed)

    def test_failed_batch_does_not_publish_new_identities(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp);original=json.dumps(settings()).encode()
            (out/'settings.json').write_bytes(original)
            with patch.object(profiles.subprocess,'run',side_effect=RuntimeError('QR failure')):
                with self.assertRaises(RuntimeError):profiles.export_eight(out)
            self.assertEqual((out/'settings.json').read_bytes(),original)
            self.assertFalse((out/'clients').exists())

    def test_second_qr_preserves_first_identity_and_existing_files(self):
        def render_qr(argv, **kwargs):
            Path(argv[2]).write_bytes(b'\x89PNG\r\n\x1a\n')
        with tempfile.TemporaryDirectory() as temp, patch.object(profiles.subprocess, 'run', side_effect=render_qr):
            out=Path(temp)/'bundle'
            first=profiles.generate(OPTIONS,out)
            saved={p.name:p.read_bytes() for p in out.iterdir()}
            second=profiles.add_second(out)
            for name in ('AnyTLS-Lab.png','AnyTLS-Lab.uri','index.html'):
                self.assertEqual((out/name).read_bytes(),saved[name])
            self.assertEqual(second['users'][:2],first['users'])
            self.assertEqual(len({u['password'] for u in second['users']}),3)
            imported=urlsplit((out/'AnyTLS-Lab-02.uri').read_text().strip())
            self.assertEqual(unquote(imported.username),second['users'][2]['password'])
            self.assertEqual(unquote(imported.fragment),'GhostRoute AnyTLS Lab 02')
            self.assertEqual(parse_qs(imported.query)['insecure'],['0'])
            projected=policy.project(fixtures['render'](),second)
            self.assertEqual(projected['inbounds'][0]['users'],second['users'])
            with self.assertRaises(ValueError):
                profiles.add_second(out)
            self.assertEqual(json.loads((out/'settings.json').read_text()),second)

    def test_failed_second_qr_does_not_register_or_change_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            out=Path(temp)
            original=json.dumps(settings()).encode()
            (out/'settings.json').write_bytes(original)
            with patch.object(profiles.subprocess,'run',side_effect=RuntimeError('QR failure')):
                with self.assertRaises(RuntimeError):
                    profiles.add_second(out)
            self.assertEqual((out/'settings.json').read_bytes(),original)
            self.assertFalse((out/'AnyTLS-Lab-02.uri').exists())


class LifecycleTests(unittest.TestCase):
    def test_port_check_rejects_active_listener(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            listener.bind(('0.0.0.0',0));listener.listen()
            with self.assertRaises(OSError):
                runtime.check_port(listener.getsockname()[1])

    def test_port_check_allows_restart_after_accepted_connection_closes(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            listener.bind(('0.0.0.0',0));listener.listen()
            port=listener.getsockname()[1]
            with socket.create_connection(('127.0.0.1',port),timeout=2) as client:
                accepted,_=listener.accept()
                accepted.close()
                self.assertEqual(client.recv(1),b'')
        runtime.check_port(port)

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
                patch.object(runtime, 'BASE', Path(temp)), patch.object(runtime, 'input_signature', return_value='fixture'), \
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
                patch.object(runtime, 'input_signature', return_value='changed'), \
                patch.object(runtime, 'terminate') as terminate, patch.object(runtime.signal, 'signal'):
            (Path(temp) / 'source').write_bytes(b'changed')
            (Path(temp) / 'inputs.sha256').write_text('original')
            runtime.watch()
            terminate.assert_called_once_with('policy')
            self.assertTrue((Path(temp) / 'contained.txt').exists())

    def test_log_budget_contains_the_lab(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime, 'RUN', Path(temp)), \
                patch.object(runtime, 'BASE', Path(temp)), patch.object(runtime, 'SOURCE', Path(temp) / 'source'), \
                patch.object(runtime, 'owned_pid', return_value=123), patch.object(runtime.time, 'sleep'), \
                patch.object(runtime, 'input_signature', return_value='original'), \
                patch.object(runtime, 'terminate') as terminate, patch.object(runtime.signal, 'signal'):
            (Path(temp) / 'source').write_bytes(b'original')
            (Path(temp) / 'inputs.sha256').write_text('original')
            with (Path(temp) / 'policy.log').open('wb') as log:
                log.truncate(4*1024*1024+1)
            runtime.watch()
            terminate.assert_called_once_with('policy')
            self.assertEqual((Path(temp) / 'contained.txt').read_text(),'Lab log budget exceeded')


class RecoveryTests(unittest.TestCase):
    def test_firewall_repair_only_creates_its_scoped_resources(self):
        calls=[]
        def call(*args,**kwargs):
            calls.append(args)
            return subprocess.CompletedProcess(args,1 if args[1] in ('-S','-C') else 0,'','')
        with patch.object(runtime,'call',side_effect=call):runtime.repair_firewall(settings())
        for args in calls:
            self.assertEqual(args[0],'iptables')
            self.assertNotIn('FORWARD',args)
            self.assertNotIn('OUTPUT',args)
            self.assertNotIn('PREROUTING',args)
        self.assertIn(('iptables','-I','INPUT','1','-p','tcp','--dport',str(settings()['port']),'-j',runtime.CHAIN),calls)

    def test_firewall_repair_refuses_unknown_existing_chain(self):
        with patch.object(runtime,'call',return_value=subprocess.CompletedProcess([],0,'-A '+runtime.CHAIN+' -j RETURN\n','')) as call:
            with self.assertRaises(ValueError):runtime.repair_firewall(settings())
            self.assertEqual(call.call_count,1)

    def test_disabled_channel_never_starts(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime,'BASE',Path(temp)), patch.object(runtime,'start') as start:
            self.assertEqual(runtime.reconcile(),{'enabled':False})
            start.assert_not_called()

    def test_boot_with_no_volatile_state_projects_before_starting(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime,'BASE',Path(temp)), patch.object(runtime,'RUN',Path(temp)), \
                patch.object(runtime,'stop') as stop, patch.object(runtime,'refresh_policy') as refresh, patch.object(runtime,'start') as start:
            (Path(temp)/'enabled').write_text('enabled')
            (Path(temp)/'settings.json').write_text(json.dumps(settings()))
            order=[]
            stop.side_effect=lambda:order.append('stop')
            refresh.side_effect=lambda:order.append('project')
            start.side_effect=lambda:order.append('start')
            self.assertTrue(runtime.reconcile()['restarted'])
            self.assertEqual(order,['stop','project','start'])

    def test_firewall_repair_preserves_healthy_processes(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime,'BASE',Path(temp)), \
                patch.object(runtime,'input_signature',return_value='current'), patch.object(runtime,'owned_pid',return_value=123), \
                patch.object(runtime,'ready',return_value=True), patch.object(runtime,'repair_firewall') as repair, patch.object(runtime,'stop') as stop:
            (Path(temp)/'enabled').write_text('enabled')
            (Path(temp)/'settings.json').write_text(json.dumps(settings()))
            (Path(temp)/'inputs.sha256').write_text('current')
            self.assertFalse(runtime.reconcile()['restarted'])
            repair.assert_called_once()
            stop.assert_not_called()

    def test_invalid_inputs_contain_existing_service(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime,'BASE',Path(temp)), \
                patch.object(runtime,'input_signature',side_effect=ValueError('unsupported policy')), patch.object(runtime,'stop') as stop, \
                patch.object(runtime,'start') as start:
            (Path(temp)/'enabled').write_text('enabled')
            (Path(temp)/'settings.json').write_text(json.dumps(settings()))
            (Path(temp)/'inputs.sha256').write_text('old')
            with self.assertRaises(ValueError):runtime.reconcile()
            stop.assert_called_once()
            start.assert_not_called()

    def test_rule_and_certificate_changes_are_fingerprinted_but_identical_rewrites_are_not(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(runtime,'BASE',Path(temp)), patch.object(runtime,'SOURCE',Path(temp)/'source.json'):
            root=Path(temp);s=settings()
            for key in ('certificate_path','key_path'):
                s[key]=str(root/key);(root/key).write_text('initial')
            (root/'settings.json').write_text(json.dumps(s))
            (root/'rules.srs').write_bytes(b'initial rules')
            (root/'source.json').write_text(json.dumps({'route':{'rule_set':[{'type':'local','path':str(root/'rules.srs')}]}}))
            first=runtime.input_signature()
            (root/'rules.srs').write_bytes(b'initial rules')
            self.assertEqual(runtime.input_signature(),first)
            (root/'rules.srs').write_bytes(b'changed rules')
            second=runtime.input_signature()
            self.assertNotEqual(first,second)
            (root/'certificate_path').write_text('renewed cert')
            self.assertNotEqual(runtime.input_signature(),second)


if __name__ == '__main__':
    unittest.main()
