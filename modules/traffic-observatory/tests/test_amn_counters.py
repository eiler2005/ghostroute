import base64
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('amn_counters', Path(__file__).resolve().parents[1] / 'lib/amn_counters.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AmnCounterTests(unittest.TestCase):
    def setUp(self):
        self.first = bytes([1] * 32)
        self.diagnostic = bytes([2] * 32)
        self.settings = {'subnet': '192.0.2.0/24', 'peers': [
            {'address': '192.0.2.2', 'public_key': base64.b64encode(self.first).decode()},
            {'address': '192.0.2.3', 'public_key': base64.b64encode(self.diagnostic).decode()},
        ]}

    def test_reads_only_registered_client_counter_and_discards_private_fields(self):
        response = ('private_' + 'key=fixture\npublic_key=' + self.first.hex() + '\npreshared_' + 'key=fixture\nrx_bytes=123\ntx_bytes=456\n' +
                    'public_key=' + self.diagnostic.hex() + '\nrx_bytes=999\ntx_bytes=999\nerrno=0\n\n')
        stats = module.extract(self.settings, response)
        self.assertEqual(stats, {'user>>>Amn-01>>>traffic>>>uplink': 123, 'user>>>Amn-01>>>traffic>>>downlink': 456})
        self.assertNotIn('fixture', str(stats))
        self.assertNotIn(self.first.hex(), str(stats))

    def test_rejects_missing_and_invalid_counters(self):
        for response in ('errno=0\n\n', 'public_key=' + self.first.hex() + '\nrx_bytes=1\nerrno=0\n\n',
                         'public_key=' + self.first.hex() + '\nrx_bytes=-1\ntx_bytes=2\nerrno=0\n\n'):
            with self.assertRaises(ValueError):
                module.extract(self.settings, response)


if __name__ == '__main__':
    unittest.main()
