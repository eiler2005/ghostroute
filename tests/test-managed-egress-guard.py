#!/usr/bin/env python3
"""Exercise the real managed guard and REDIRECT fragments with a stateful firewall."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2"
MOCK_IPTABLES = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['RULE_STATE'])
s = json.loads(p.read_text()) if p.exists() else {'filter': {'FORWARD': [['-j', 'ACCEPT']]}, 'nat': {'PREROUTING': []}}
a = sys.argv[1:]
table = 'filter'
if a[:2] == ['-t', 'nat']:
    table, a = 'nat', a[2:]
op, chain, *rule = a
chains = s[table]
if op == '-S':
    if chain == 'FORWARD': print('-P FORWARD ACCEPT')
    for item in chains.get(chain, []): print('-A', chain, *item)
    sys.exit(0)
if op == '-N':
    if chain in chains: sys.exit(1)
    chains[chain] = []
elif op == '-C':
    sys.exit(0 if rule in chains.get(chain, []) else 1)
elif op == '-A':
    if table == 'nat' and os.environ.get('FAIL_STATIC_REDIRECT') == '1' and 'VPN_STATIC_NETS' in rule:
        sys.exit(1)
    chains[chain].append(rule)
elif op == '-I':
    index = int(rule.pop(0)) - 1
    chains[chain].insert(index, rule)
elif op == '-D':
    if len(rule) == 1 and rule[0].isdigit():
        del chains[chain][int(rule[0]) - 1]
    else:
        chains[chain].remove(rule)
else:
    raise AssertionError(a)
p.write_text(json.dumps(s))
'''
MOCK_IPSET = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ['SET_STATE'])
s = json.loads(p.read_text()) if p.exists() else {}
op, *args = sys.argv[1:]
name = args[0]
if op == 'create':
    s.setdefault(name, [])
elif op == 'flush':
    s[name] = []
elif op == 'add':
    if args[1] != args[1].strip():
        sys.exit(1)
    if os.environ.get('FAIL_STATIC_ADD') == '1' and args[1] == '203.0.113.20/32':
        sys.exit(1)
    s[name].append(args[1])
elif op == 'swap':
    s[name], s[args[1]] = s[args[1]], s[name]
elif op == 'destroy':
    del s[name]
else:
    raise AssertionError(sys.argv[1:])
p.write_text(json.dumps(s))
'''


class ManagedEgressGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        for name, content in (("iptables", MOCK_IPTABLES), ("ipset", MOCK_IPSET)):
            script = self.path / name
            script.write_text(content)
            script.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.path}:{os.environ['PATH']}",
                        RULE_STATE=str(self.path / "rules.json"), SET_STATE=str(self.path / "sets.json"),
                        IPSET="STEALTH_DOMAINS", STATIC_IPSET="VPN_STATIC_NETS",
                        GUARD_CHAIN="GR_A_EGRESS_GUARD", REDIRECT_PORT="12001")
        template = TEMPLATE.read_text()
        guard_start = template.index("ensure_egress_guard() {")
        guard_end = template.index("\n}\n", guard_start) + 2
        redirect_start = template.index("iptables -t nat -C PREROUTING -i br0 -p tcp")
        redirect_end = template.index("\n\n# Keep plain LAN DNS", redirect_start)
        self.script = self.path / "setup.sh"
        self.script.write_text("set -e\n" + template[guard_start:guard_end] +
                               "\nensure_egress_guard\n" + template[redirect_start:redirect_end] + "\n")
        subprocess.run(["sh", "-n", str(self.script)], check=True)

    def apply(self, **changes):
        env = self.env | {k: str(v) for k, v in changes.items()}
        return subprocess.run(["sh", str(self.script)], env=env, capture_output=True, text=True)

    def rules(self):
        return json.loads((self.path / "rules.json").read_text())

    def test_guard_precedes_broad_accept_and_reapply_is_idempotent(self):
        self.assertEqual(self.apply().returncode, 0)
        first = self.rules()
        self.assertEqual(first["filter"]["FORWARD"][0], ["-i", "br0", "-j", "GR_A_EGRESS_GUARD"])
        self.assertEqual(len(first["filter"]["GR_A_EGRESS_GUARD"]), 4)
        self.assertEqual(len(first["nat"]["PREROUTING"]), 2)
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(self.rules(), first)

    def test_guard_moves_ahead_of_new_accept_without_opening_nat(self):
        self.assertEqual(self.apply().returncode, 0)
        state = self.rules()
        state["filter"]["FORWARD"].insert(0, ["-j", "ACCEPT"])
        Path(self.env["RULE_STATE"]).write_text(json.dumps(state))
        self.assertEqual(self.apply().returncode, 0)
        current = self.rules()
        self.assertEqual(current["filter"]["FORWARD"][0], ["-i", "br0", "-j", "GR_A_EGRESS_GUARD"])
        self.assertEqual(current["filter"]["FORWARD"].count(["-i", "br0", "-j", "GR_A_EGRESS_GUARD"]), 1)
        self.assertEqual(current["nat"], state["nat"])

    def test_failed_second_redirect_keeps_guard_and_first_redirect(self):
        self.assertNotEqual(self.apply(FAIL_STATIC_REDIRECT=1).returncode, 0)
        state = self.rules()
        self.assertEqual(state["filter"]["FORWARD"][0], ["-i", "br0", "-j", "GR_A_EGRESS_GUARD"])
        self.assertEqual(len(state["filter"]["GR_A_EGRESS_GUARD"]), 4)
        self.assertEqual(len(state["nat"]["PREROUTING"]), 1)
        self.assertEqual(self.apply().returncode, 0)
        self.assertEqual(len(self.rules()["nat"]["PREROUTING"]), 2)

    def test_static_catalog_failure_keeps_old_live_set(self):
        hook = (ROOT / "modules/routing-core/router/firewall-start").read_text()
        start = hook.index("if [ ! -f \"$STATIC_NETWORKS_FILE\" ]; then")
        end = hook.index("\n# Keep per-device LAN byte", start)
        script = self.path / "refresh.sh"
        script.write_text("STATIC_NEXT=GR_A_STATIC_NEXT\n" + hook[start:end] + "\n")
        subprocess.run(["sh", "-n", str(script)], check=True)
        catalog = self.path / "catalog"
        catalog.write_text("203.0.113.10/32   \n203.0.113.20/32\t\n")
        self.env["STATIC_NETWORKS_FILE"] = str(catalog)
        Path(self.env["SET_STATE"]).write_text(json.dumps({"VPN_STATIC_NETS": ["198.51.100.1/32"]}))
        failed = subprocess.run(["sh", str(script)], env=self.env | {"FAIL_STATIC_ADD": "1"}, capture_output=True)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(json.loads(Path(self.env["SET_STATE"]).read_text())["VPN_STATIC_NETS"], ["198.51.100.1/32"])
        subprocess.run(["sh", str(script)], env=self.env, check=True, capture_output=True)
        self.assertEqual(json.loads(Path(self.env["SET_STATE"]).read_text())["VPN_STATIC_NETS"],
                         ["203.0.113.10/32", "203.0.113.20/32"])


if __name__ == "__main__":
    unittest.main()
