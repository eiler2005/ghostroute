#!/usr/bin/env python3
"""Machine markers must survive Ansible's short Vault-value redaction."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'modules/ghostroute-health-monitor/bin/live-check'


class VpsOutputTests(unittest.TestCase):
    def probe(self, edge='OK', profile='present'):
        source = SOURCE.read_text()
        functions = source[source.index('append_vps_router_check() {'):source.index('\nrouter_ssh "GHOSTROUTE_LIVE_FILTER=')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ansible/secrets').mkdir(parents=True)
            (root / 'ansible/secrets/stealth.yml').touch()
            binary = root / 'ansible-stub'
            binary.mkdir()
            stub = binary / 'ansible'
            stub.write_text(r'''#!/usr/bin/env python3
import os,re,sys
command=sys.argv[-1]
values={'profile':os.environ['TEST_PROFILE'],'key':'present','tcp':'OK','tcp443':os.environ['TEST_EDGE'],'dns53':'OK','tool':'ss'}
print('fixture | CHANGED | rc=0 >>')
for name,variable in re.findall(r'echo ([A-Za-z0-9_]+)=\$([a-z0-9]+)', command):
    # Model sensitive short scalar values that also occur inside old marker keys.
    print((name+'='+values[variable]).replace('FI','$REDACTED$').replace('443','$REDACTED$').replace('router','$REDACTED$'))
''')
            stub.chmod(0o700)
            env = dict(os.environ, PATH=str(binary)+':'+os.environ['PATH'], TEST_PROFILE=profile, TEST_EDGE=edge)
            harness = 'set -eu\nCHANNEL=all\nDEPLOY_GATE=1\nPROJECT_ROOT="'+str(root)+'"\n'
            harness += 'append_local_check() { printf "%s|%s\\n" "$1" "$2"; }\n'
            return subprocess.check_output(['bash'], input=harness+functions+'\nappend_vps_router_check\nappend_vps_edge_check\n', text=True, env=env)

    def test_short_secret_redaction_does_not_hide_healthy_markers(self):
        result = self.probe()
        self.assertIn('console_vps_router_profile|OK', result)
        self.assertIn('vps_edge_tcp443_listener|OK', result)

    def test_missing_listener_still_warns(self):
        self.assertIn('vps_edge_tcp443_listener|WARN', self.probe(edge='FAIL'))

    def test_missing_profile_still_warns(self):
        self.assertIn('console_vps_router_profile|WARN', self.probe(profile='missing'))


if __name__ == '__main__':
    unittest.main()
