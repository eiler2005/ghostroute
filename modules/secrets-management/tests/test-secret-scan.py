"""Binary assets are not text; text findings must remain enforced."""
from pathlib import Path
import runpy
import tempfile
import unittest

SCANNER = Path(__file__).resolve().parents[1] / 'bin/secret-scan'


class ScanBoundaryTests(unittest.TestCase):
    def test_icns_is_excluded_while_same_literal_in_text_is_rejected(self):
        scanner = runpy.run_path(str(SCANNER))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            literal = next(iter(scanner['SENSITIVE_LITERALS']))
            (root/'art.icns').write_bytes(b'icns\x00' + literal.encode())
            (root/'note.md').write_text(literal)
            scope = scanner['candidate_files'].__globals__
            scope['ROOT'] = root
            scope['git_output'] = lambda *args: ['art.icns', 'note.md']
            self.assertEqual(scanner['candidate_files'](), [root/'note.md'])
            self.assertTrue(scanner['scan_file'](root/'note.md'))


if __name__ == '__main__':
    unittest.main()
