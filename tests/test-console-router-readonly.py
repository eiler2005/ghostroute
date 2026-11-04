#!/usr/bin/env python3
import hashlib
import importlib.machinery
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    loader = importlib.machinery.SourceFileLoader(name, str(ROOT/path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


gate = load('console_router_gate', 'modules/ghostroute-console/router/console-router-readonly.py')
builder = load('console_router_policy', 'modules/ghostroute-console/bin/build-router-readonly-policy')
keys = load('console_router_keys', 'modules/ghostroute-console/router/console-router-keys.py')


class ConsoleRouterBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = builder.build()

    def reject(self, command, body=b''):
        with self.assertRaises(gate.Rejected):
            gate.plan(command, body, self.policy)

    def test_administrative_commands_and_subsystems_are_rejected(self):
        for command in ('', 'sh', '/bin/sh', 'id', 'reboot', 'nvram set test=1',
                        'iptables -F', 'scp -t /jffs', 'internal-sftp', '/opt/libexec/sftp-server',
                        'true; reboot', 'true\nreboot', 'true && id', 'true | sh', 'true$(id)'):
            with self.subTest(command=command):
                self.reject(command)

    def test_approved_scripts_use_server_policy_body(self):
        for digest, entry in self.policy['scripts'].items():
            body = entry['body'].encode()
            self.assertEqual(hashlib.sha256(body).hexdigest(), digest)
            argv, selected, environment = gate.plan('sh -s', body, self.policy)
            self.assertEqual(argv, ['/bin/sh', '-s'])
            self.assertEqual(selected, body)
            self.assertEqual(environment, {})

    def test_changed_and_appended_scripts_are_rejected(self):
        body = next(iter(self.policy['scripts'].values()))['body'].encode()
        self.reject('sh -s', body+b'\nreboot\n')
        self.reject('sh -s', b'nvram set test=1\n')
        self.reject('sh -s', b'x'*(gate.MAX_SCRIPT+1))

    def test_environment_cannot_select_shell_startup_or_programs(self):
        body = next(iter(self.policy['scripts'].values()))['body'].encode()
        for name in ('PATH', 'ENV', 'BASH_ENV', 'LD_PRELOAD', 'PYTHONPATH', 'SINGBOX_LOG'):
            self.reject(f'{name}=/tmp/evil sh -s', body)

    def test_environment_is_scoped_to_the_selected_report(self):
        entry = next(value for value in self.policy['scripts'].values() if value['source'].endswith('traffic-summary'))
        self.reject('WINDOW_PREFIX=2026 sh -s', entry['body'].encode())

    def test_parameter_validation_and_duplicate_rejection(self):
        entry = next(value for value in self.policy['scripts'].values() if value['source'].endswith('live-check'))
        body = entry['body'].encode()
        _, _, values = gate.plan("GHOSTROUTE_LIVE_FILTER='all' GHOSTROUTE_LIVE_ACTIVE_PROBE='1' sh -s", body, self.policy)
        self.assertEqual(values['GHOSTROUTE_LIVE_FILTER'], 'all')
        self.reject('GHOSTROUTE_LIVE_FILTER=all GHOSTROUTE_LIVE_FILTER=all sh -s', body)
        self.reject("GHOSTROUTE_MANAGED_CHECK_DOMAIN='$(reboot)' sh -s", body)
        self.reject("GHOSTROUTE_LIVE_FILTER='all;reboot' sh -s", body)
        self.reject("GHOSTROUTE_LIVE_FILTER=all sh -s --evil", body)

    def test_all_literal_reads_are_exact_matches(self):
        for command in self.policy['commands']:
            self.assertEqual(gate.plan(command, b'reboot', self.policy)[1], b'')
            self.reject(command+'; reboot')

    def test_domain_mutations_are_not_in_the_policy(self):
        self.assertFalse(any('restart_dnsmasq' in command or '--cleanup-only' in command for command in self.policy['commands']))

    def test_live_log_read_is_bounded_and_path_scoped(self):
        command = 'LOG=/opt/var/log/sing-box.log; [ -f "$LOG" ] && tail -n \'200\' "$LOG" || true'
        self.assertEqual(gate.plan(command, b'', self.policy)[0][-2:], ['/opt/var/log/sing-box.log', '200'])
        self.reject(command.replace('200', '1001'))
        self.reject(command.replace('/opt/var/log/sing-box.log', '/jffs/keys/private'))

    def test_dns_snapshot_path_is_scoped(self):
        command = 'cat "/opt/var/log/router_configuration/dns-forensics/2026-01-01T00.tsv"'
        self.assertEqual(gate.plan(command, b'', self.policy)[0][0], '/bin/cat')
        timestamped = command.replace('2026-01-01T00.tsv', '2026-01-01T00-2026-01-01T01:00:01+0000.tsv')
        self.assertEqual(gate.plan(timestamped, b'', self.policy)[0][0], '/bin/cat')
        self.reject('cat "/jffs/keys/private.tsv"')
        self.reject('cat "/opt/var/log/router_configuration/dns-forensics/../../keys/private.tsv"')
        self.reject(command+'; id')

    def test_symlink_escape_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'data').mkdir()
            (root/'outside').write_text('secret')
            (root/'data/row.tsv').symlink_to(root/'outside')
            with self.assertRaises(gate.Rejected):
                gate.report_file(str(root/'data/row.tsv'), [str(root/'data')])

    def test_rollup_period_is_fixed(self):
        self.assertEqual(gate.plan("/jffs/scripts/traffic-rollup-export --json 'week'", b'', self.policy)[0][-1], 'week')
        self.reject("/jffs/scripts/traffic-rollup-export --json 'week;id'")

    def test_invalid_schema_is_rejected(self):
        with self.assertRaises(gate.Rejected):
            gate.plan('true', b'', dict(self.policy, schema_version=2))


class RouterKeyMigration(unittest.TestCase):
    operator = 'ssh-ed25519 b3BlcmF0b3I='
    console = 'ssh-ed25519 Y29uc29sZQ=='
    retired = 'ssh-rsa cmV0aXJlZA=='
    other = 'ssh-rsa b3RoZXI='

    def test_stage_preserves_old_and_unrelated_keys(self):
        result = keys.revise(self.retired+'\n', self.other+'>'+self.retired, self.operator, self.console)
        self.assertIn(self.retired, result)
        self.assertIn(self.other, result)
        self.assertIn(keys.FORCED+self.console, result)
        self.assertEqual(result.count(self.retired), 1)

    def test_repeated_staging_is_idempotent(self):
        first = keys.revise(self.retired, '', self.operator, self.console)
        self.assertEqual(keys.revise(first, first.replace('\n', '>'), self.operator, self.console), first)

    def test_retirement_removes_only_identified_old_key(self):
        staged = keys.revise(self.retired+'\n'+self.other, '', self.operator, self.console)
        result = keys.revise(staged, staged, self.operator, self.console, self.retired)
        self.assertNotIn(self.retired, result)
        self.assertIn(self.other, result)
        self.assertIn(self.operator, result)
        self.assertIn(keys.FORCED+self.console, result)

    def test_service_key_cannot_become_unrestricted(self):
        result = keys.revise(self.console, self.console, self.operator, self.console)
        self.assertEqual(sum(self.console in row for row in result.splitlines()), 1)
        self.assertTrue(next(row for row in result.splitlines() if self.console in row).startswith('command='))

    def test_same_or_retired_new_identity_is_rejected(self):
        for operator, console, retired in ((self.operator, self.operator, None),
                                           (self.operator, self.console, self.operator)):
            with self.assertRaises(ValueError):
                keys.revise('', '', operator, console, retired)

    def test_repeat_retirement_preserves_original_rollback_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            authorized = root/'authorized_keys'
            authorized.write_text(keys.revise('', '', self.operator, self.console))
            backup = root/'before-retirement.json'
            backup.write_text('original rollback snapshot')
            settings = root/'keys.json'
            settings.write_text(__import__('json').dumps({'operator_public_key':self.operator,'console_public_key':self.console,'retired_public_key':self.retired}))
            with patch.object(keys, 'DIRECTORY', root), patch.object(keys, 'AUTHORIZED', authorized), \
                 patch.object(keys, 'persistent_read', return_value=authorized.read_text()), \
                 patch.object(keys.subprocess, 'Popen') as spawn, \
                 patch.object(keys.sys, 'argv', ['keys.py','retire','--settings',str(settings)]):
                keys.main()
                spawn.assert_not_called()
            self.assertEqual(backup.read_text(), 'original rollback snapshot')

    def test_firmware_truncation_and_key_option_injection_are_rejected(self):
        with self.assertRaises(ValueError):
            keys.revise('#'+'x'*3500, '', self.operator, self.console)
        for value in ('command="id" '+self.console, self.console+'\n'+self.other):
            with self.assertRaises(ValueError):
                keys.revise('', '', self.operator, value)


if __name__ == '__main__':
    unittest.main()
