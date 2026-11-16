import importlib.util
from pathlib import Path
import sqlite3
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
import isolated_channel_store as store


class StoreTests(unittest.TestCase):
    def test_atomic_baseline_intervals_and_restart_gap(self):
        db = sqlite3.connect(':memory:')
        store.initialize(db)
        before = {'channel': 'anyT', 'instance_id': 'a', 'ts': '2026-01-01T00:00:00Z', 'stats': {}}
        key = 'user>>>lab-client>>>traffic>>>uplink'
        after = dict(before, ts='2026-01-01T00:01:00Z', stats={key: 100})
        self.assertEqual(store.ingest(db, before), (0, ['initial_baseline']))
        self.assertEqual(store.ingest(db, after), (1, []))
        self.assertEqual(store.ingest(db, dict(after, instance_id='b', ts='2026-01-01T00:02:00Z')), (0, ['process_changed']))
        self.assertEqual(db.execute('select count(*) from intervals').fetchone()[0], 1)
        self.assertEqual(db.execute('select count(*) from gaps').fetchone()[0], 2)
        with self.assertRaises(ValueError):
            store.ingest(db, dict(after, ts='2026-01-01T00:03:00Z', stats={key: -1}))
        self.assertEqual(db.execute('select count(*) from intervals').fetchone()[0], 1)


if __name__ == '__main__':
    unittest.main()
