import hashlib
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'modules/ghostroute-console/router/merge-readonly-policy.py'
spec = importlib.util.spec_from_file_location('merge_policy', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PolicyMergeTests(unittest.TestCase):
    def policy(self, body, command):
        digest = hashlib.sha256(body.encode()).hexdigest()
        return {'schema_version': 1, 'scripts': {digest: {'body': body, 'source': 'fixture', 'parameters': {}}},
                'commands': {command: command}}

    def test_additive_merge_keeps_previous_and_new_fixed_reports(self):
        result = module.merge(self.policy('old', 'old-command'), self.policy('new', 'new-command'))
        self.assertEqual(len(result['scripts']), 2)
        self.assertEqual(set(result['commands']), {'old-command', 'new-command'})

    def test_rejects_corruption_and_script_metadata_conflict(self):
        old = self.policy('body', 'cmd')
        new = self.policy('body', 'cmd')
        next(iter(new['scripts'].values()))['parameters'] = {'x': '.*'}
        with self.assertRaises(ValueError): module.merge(old, new)
        bad = self.policy('body', 'cmd')
        next(iter(bad['scripts'].values()))['body'] = 'modified'
        with self.assertRaises(ValueError): module.merge(old, bad)
        with self.assertRaises(ValueError): module.merge(old, dict(bad, commands={'read': 'reboot'}))


if __name__ == '__main__':
    unittest.main()
