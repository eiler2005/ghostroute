import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'lib'))
spec = importlib.util.spec_from_file_location('snapshot', root / 'router/isolated-channel-snapshot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotTests(unittest.TestCase):
    def test_collect_requires_enabled_profiles_and_same_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'policy.json'
            path.write_text(json.dumps({'experimental': {'v2ray_api': {'listen': '127.0.0.1:12099', 'stats': {'enabled': True, 'users': ['fixture']}}}}))
            response = type('Response', (), {'stdout': b'{"stat":{}}'})()
            with patch.object(module, 'process_instance', side_effect=['same', 'same']), patch.object(module.subprocess, 'run', return_value=response):
                self.assertEqual(module.collect('anyT', '/fixture', str(path), ['fixture'])['instance_id'], 'same')
            with patch.object(module, 'process_instance', side_effect=['one', 'two']), patch.object(module.subprocess, 'run', return_value=response):
                with self.assertRaises(RuntimeError):
                    module.collect('anyT', '/fixture', str(path), ['fixture'])
            with self.assertRaises(RuntimeError):
                module.collect('anyT', '/fixture', str(path), ['missing'])

    def test_export_writes_only_events(self):
        with tempfile.TemporaryDirectory() as temporary:
            db = sqlite3.connect(':memory:')
            db.execute('create table intervals (sample_id text, ts text, payload text)')
            db.execute('create table gaps (channel text, ts text, reason text)')
            db.execute('insert into intervals values (?, ?, ?)', ('id', 'time', '{"sample_id":"id"}'))
            module.export(db, Path(temporary))
            self.assertEqual((Path(temporary) / 'isolated-channel-deltas.jsonl').read_text(), '{"sample_id":"id"}\n')


if __name__ == '__main__':
    unittest.main()
