import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('channel_d_log', Path(__file__).resolve().parents[1] / 'lib/channel_d_log.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ChannelDLogTests(unittest.TestCase):
    def setUp(self):
        self.profiles = module.validate_profiles({'private-user': {'client_key': 'D-01', 'client_label': 'Example profile'}})
        self.row = {'method': 'CONNECT', 'status': 200, 'proto': 'HTTP/2.0', 'user_id': 'private-user', 'ts': 1767225660.0, 'duration': 60, 'bytes_read': 200, 'size': 400}

    def test_directional_record_omits_private_username(self):
        row, gap = module.parse_record(json.dumps(self.row).encode(), self.profiles, 'file', 100)
        self.assertIsNone(gap)
        self.assertEqual((row['client_key'], row['bytes_up'], row['bytes_down']), ('D-01', 200, 400))
        self.assertNotIn('private-user', json.dumps(row))
        self.assertEqual(len(row['sample_id']), 64)

    def test_unmapped_or_hijacked_requests_are_not_counted(self):
        row = dict(self.row, proto='HTTP/1.1')
        self.assertEqual(module.parse_record(json.dumps(row).encode(), self.profiles, 'file', 1), (None, 'unsupported_protocol'))
        row = dict(self.row, user_id='other')
        self.assertEqual(module.parse_record(json.dumps(row).encode(), self.profiles, 'file', 1), (None, 'unmapped_profile'))
        row = dict(self.row, method='GET')
        self.assertEqual(module.parse_record(json.dumps(row).encode(), self.profiles, 'file', 1), (None, None))
        with self.assertRaises(ValueError):
            module.parse_record(json.dumps(dict(self.row, bytes_read=-1)).encode(), self.profiles, 'file', 1)

    def test_duplicate_slots_rejected(self):
        with self.assertRaises(ValueError):
            module.validate_profiles({'one': {'client_key': 'D-01', 'client_label': 'A'}, 'two': {'client_key': 'D-01', 'client_label': 'B'}})


if __name__ == '__main__':
    unittest.main()
