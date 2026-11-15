"""Offline privacy and preservation contract for the slot exporter."""
import importlib.machinery
import json
from pathlib import Path
import tempfile
import unittest

exporter = importlib.machinery.SourceFileLoader(
    'channel_inventory', str(Path(__file__).resolve().parents[1] / 'bin/export-channel-inventory')
).load_module()


class InventoryTest(unittest.TestCase):
    def test_private_material_is_not_exported_or_modified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(exporter.inventory(root), [])
            values = [('channel-anytls', 'settings.json', {'users': [
                {'name': 'lab-client', 'password': 'fictional-secret'},
                {'name': 'lab-probe', 'password': 'fictional-probe'}]}),
                ('channel-snell', 'settings.private.json', {'slots': [
                    {'psk': 'fictional-inner', 'shadowtls_password': 'fictional-outer', 'port': '<listener>'}]})]
            originals = {}
            for folder, filename, value in values:
                source = root / folder / filename
                source.parent.mkdir()
                source.write_text(json.dumps(value))
                originals[source] = source.read_bytes()
            rows = exporter.inventory(root)
            self.assertEqual([row['channel'] for row in rows], ['anyT', 'Snell'])
            self.assertTrue(all(row['status'] == 'unknown' for row in rows))
            self.assertNotIn('fictional', json.dumps(rows))
            self.assertNotIn('<listener>', json.dumps(rows))
            for source, original in originals.items():
                self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
