import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
import channel_d_spool as spool
import isolated_channel_store as store


class SpoolTests(unittest.TestCase):
    def test_repeat_rotation_partial_line_and_private_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            profiles = root / 'profiles.json'
            profiles.write_text(json.dumps({'private-user': {'client_key': 'D-01', 'client_label': 'Client'}}))
            record = {'method': 'CONNECT', 'status': 200, 'proto': 'HTTP/2.0', 'user_id': 'private-user', 'ts': 1767225660.0, 'duration': 2, 'bytes_read': 100, 'size': 200}
            line = json.dumps(record) + '\n'
            current = root / 'channel-d-access.log'
            current.write_text(line + '{"partial":')
            db = sqlite3.connect(':memory:'); store.initialize(db)
            spool.collect(db, root, profiles, '2026-01-01T00:02:00Z')
            spool.collect(db, root, profiles, '2026-01-01T00:03:00Z')
            self.assertEqual(db.execute('select count(*) from intervals').fetchone()[0], 1)
            self.assertNotIn('private-user', db.execute('select payload from intervals').fetchone()[0])
            with current.open('a') as stream: stream.write('true}\n')
            current.rename(root / 'channel-d-access-rotation.log')
            current.write_text(line)
            spool.collect(db, root, profiles, '2026-01-01T00:04:00Z')
            self.assertEqual(db.execute('select count(*) from intervals').fetchone()[0], 2)
            self.assertNotIn('private-user', str(db.execute('select * from gaps').fetchall()))


if __name__ == '__main__':
    unittest.main()
