from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

from mac_guard.install import extension
from mac_guard.policy import GuardError


class OrdinaryExceptionsTests(unittest.TestCase):
    def test_private_source_preserved_and_generated_policy_is_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);target=root/'blocker';source=root/'ordinary-direct-domains.txt'
            extension(target,['sensitive.example.org'])
            self.assertEqual(json.loads((target/'ordinary-direct-domains.json').read_text()),[])
            source.write_text('ordinary.example.org\n');source.chmod(0o600)
            extension(target,['sensitive.example.org'])
            self.assertEqual(json.loads((target/'ordinary-direct-domains.json').read_text()),['ordinary.example.org'])
            self.assertEqual(source.read_text(),'ordinary.example.org\n')
            self.assertNotIn('ordinary.example.org',(target/'rules.json').read_text())

    def test_reject_overlap_broad_scope_and_untrusted_private_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);target=root/'blocker';source=root/'ordinary-direct-domains.txt'
            for value in ['sensitive.example.org','api.sensitive.example.org','example.org','com','localhost','127.0.0.1','https://ordinary.example.org/', '\n'.join(f'x{i}.example.net' for i in range(33))]:
                source.write_text(value);source.chmod(0o600)
                with self.assertRaises(GuardError):extension(target,['sensitive.example.org'])
            source.write_text('ordinary.example.org');source.chmod(0o644)
            with self.assertRaises(GuardError):extension(target,['sensitive.example.org'])
            source.chmod(0o600)
            with patch('mac_guard.install.os.getuid',return_value=-1):
                with self.assertRaises(GuardError):extension(target,['sensitive.example.org'])
            source.unlink();source.symlink_to(root/'missing')
            with self.assertRaises(GuardError):extension(target,['sensitive.example.org'])
