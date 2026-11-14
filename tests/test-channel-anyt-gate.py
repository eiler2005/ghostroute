#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gate', ROOT/'modules/ghostroute-health-monitor/router/channel-anyt-gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def test_deployment_entrypoints_include_protected_gate(self):
        self.assertIn('bin/channel-anyt-check', (ROOT/'deploy.sh').read_text())
        self.assertIn('bin/channel-anyt-check', (ROOT/'ansible/tasks/deploy-gate.yml').read_text())
        playbook=(ROOT/'ansible/playbooks/31-channel-anytls-lab.yml').read_text()
        self.assertLess(playbook.index('--verify-approved'), playbook.index('channel_anytls_mutation_started: true'))
        self.assertEqual(playbook.count('bin/channel-anyt-check'), 2)

    def exercise(self, failure=None):
        with tempfile.TemporaryDirectory() as tmp:
            base=Path(tmp)
            (base/'settings.json').write_text(json.dumps({'port':12031,'server_name':'home.example.invalid',
                'users':[{'name':'lab-probe','password':'fixture-secret'}]}))
            status=dict.fromkeys(('boot_persistent','policy_running','watch_running','source_current'), True)
            status['contained']=False
            def output(argv, **kwargs):
                if 'status' in argv:
                    return json.dumps({**status, 'watch_running':failure!='watch'})
                if argv[0]=='cru': return '' if failure=='cron' else '#ChannelAnyT#'
                return '-A GR_ATLS_IN -j ACCEPT\n-A GR_ATLS_IN -i lo -j ACCEPT\n-A GR_ATLS_IN -j DROP\n'
            def path(value):
                if str(value)=='/opt/etc/ghostroute-anytls': return base
                if str(value).startswith('/jffs/scripts/'):
                    hook=base/'hook';hook.write_text('channel-anytls.py');return hook
                return Path(value)
            def run(argv, **kwargs):
                if (failure=='firewall' and argv[0]=='iptables') or (failure=='https' and argv[0]=='/opt/bin/curl'):
                    raise subprocess.CalledProcessError(1, argv)
                return MagicMock(returncode=0)
            proc=MagicMock();proc.poll.return_value=None
            with patch.object(gate,'Path',side_effect=path), patch.object(gate.subprocess,'check_output',side_effect=output), \
                 patch.object(gate.subprocess,'run',side_effect=run), patch.object(gate.subprocess,'Popen',return_value=proc), \
                 patch.object(gate.socket,'create_connection',return_value=MagicMock()), patch('builtins.print'):
                if failure:
                    with self.assertRaises((ValueError,subprocess.CalledProcessError)): gate.run()
                else: gate.run()
            if failure in (None,'https'):
                proc.terminate.assert_called_once()
                proc.wait.assert_called_once()
    def test_authenticated_success_and_cleanup(self): self.exercise()
    def test_failures_block_and_probe_is_cleaned(self):
        for failure in ('watch','cron','firewall','https'):
            with self.subTest(failure=failure): self.exercise(failure)


if __name__=='__main__': unittest.main()
