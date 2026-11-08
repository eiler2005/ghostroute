#!/usr/bin/env python3
"""Exercise the actual C LAN setup with a stateful iptables test double."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / 'ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2'
MOCK = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['RULE_STATE'])
s = json.loads(p.read_text()) if p.exists() else {'PREROUTING': []}
a = sys.argv[1:]
assert a[:2] == ['-t', 'nat'], a
op, chain = a[2:4]
rule = a[4:]
if op == '-N':
    if chain in s: sys.exit(1)
    s[chain] = []
elif op == '-F': s[chain] = []
elif op == '-D':
    if rule not in s.get(chain, []): sys.exit(1)
    s[chain].remove(rule)
elif op == '-A': s[chain].append(rule)
elif op == '-I':
    assert rule.pop(0) == '1'
    s[chain].insert(0, rule)
else: raise AssertionError(a)
p.write_text(json.dumps(s))
'''


class ChannelCLanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        for name, content in [('iptables', MOCK), ('nvram', '#!/bin/sh\nprintf "%s\\n" "$TEST_WAN"\n')]:
            script = self.path / name
            script.write_text(content)
            script.chmod(0o755)
        template = TEMPLATE.read_text()
        start = template.index('sync_channel_c_lan_redirects() {')
        end = template.index('\n}', start) + 2
        self.script = self.path / 'setup.sh'
        self.script.write_text(template[start:end] + '\nsync_channel_c_lan_redirects\n')
        subprocess.run(['sh', '-n', str(self.script)], check=True)
        self.env = dict(os.environ, PATH=str(self.path) + ':' + os.environ['PATH'],
                        RULE_STATE=str(self.path / 'rules.json'), TEST_WAN='198.51.100.10',
                        CHANNEL_C_HOME_ENABLED='1', CHANNEL_C_HOME_PUBLIC_PORT='443', CHANNEL_C_HOME_PORT='1443',
                        CHANNEL_C_SHADOWROCKET_ENABLED='1', CHANNEL_C_SHADOWROCKET_PUBLIC_PORT='4443',
                        CHANNEL_C_SHADOWROCKET_PORT='1444')

    def apply(self, **changes):
        self.env.update(changes)
        subprocess.run(['sh', str(self.script)], env=self.env, check=True, capture_output=True)
        return json.loads((self.path / 'rules.json').read_text())

    def destination(self, interface, address, port, protocol='tcp'):
        state = json.loads((self.path / 'rules.json').read_text())
        if interface != 'br0' or ['-i', 'br0', '-j', 'GR_C_LAN'] not in state['PREROUTING']:
            return port
        for rule in state['GR_C_LAN']:
            if rule[rule.index('-d') + 1] == address and rule[rule.index('-p') + 1] == protocol and int(rule[rule.index('--dport') + 1]) == port:
                return int(rule[rule.index('--to-ports') + 1])
        return port

    def test_home_public_endpoint_and_isolation(self):
        state = self.apply()
        self.assertEqual(set(state), {'PREROUTING', 'GR_C_LAN'})
        self.assertEqual(self.destination('br0', '198.51.100.10', 4443), 1444)
        self.assertEqual(self.destination('br0', '198.51.100.10', 443), 1443)
        for iface, addr, port, proto in [
            ('wan0', '198.51.100.10', 4443, 'tcp'),
            ('br1', '198.51.100.10', 4443, 'tcp'),
            ('br0', '203.0.113.20', 443, 'tcp'),
            ('br0', '192.168.1.1', 443, 'tcp'),
            ('br0', '198.51.100.10', 8443, 'tcp'),
            ('br0', '198.51.100.10', 4443, 'udp'),
        ]:
            self.assertEqual(self.destination(iface, addr, port, proto), port)

    def test_repeat_wan_change_and_disable(self):
        first = self.apply()
        self.assertEqual(self.apply(), first)
        self.apply(TEST_WAN='198.51.100.11')
        self.assertEqual(self.destination('br0', '198.51.100.10', 4443), 4443)
        self.assertEqual(self.destination('br0', '198.51.100.11', 4443), 1444)
        self.apply(CHANNEL_C_SHADOWROCKET_ENABLED='0')
        self.assertEqual(self.destination('br0', '198.51.100.11', 4443), 4443)
        state = self.apply(CHANNEL_C_HOME_ENABLED='0')
        self.assertEqual(state, {'PREROUTING': [], 'GR_C_LAN': []})

    def test_missing_wan_and_equal_ports(self):
        self.apply()
        self.assertEqual(self.apply(TEST_WAN='0.0.0.0'), {'PREROUTING': [], 'GR_C_LAN': []})
        self.assertEqual(self.apply(TEST_WAN=''), {'PREROUTING': [], 'GR_C_LAN': []})
        state = self.apply(TEST_WAN='198.51.100.10', CHANNEL_C_HOME_PORT='443', CHANNEL_C_SHADOWROCKET_PORT='4443')
        self.assertEqual(state['GR_C_LAN'], [])

    def test_other_routing_rules_preserved_and_hook_precedes_them(self):
        unrelated = [['-i', 'br0', '-j', 'OTHER_MANAGED_RULE'], ['-i', 'wan0', '-j', 'OTHER_CHANNEL']]
        (self.path / 'rules.json').write_text(json.dumps({'PREROUTING': unrelated}))
        state = self.apply()
        self.assertEqual(state['PREROUTING'][1:], unrelated)
        self.assertEqual(self.apply(), state)


if __name__ == '__main__':
    unittest.main()
