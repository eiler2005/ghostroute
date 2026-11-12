import json
from pathlib import Path
import tempfile
import unittest

from mac_guard.install import extension
from mac_guard.policy import GuardError


class OrdinaryRoutingTests(unittest.TestCase):
    def test_default_explicit_choice_and_upgrade_persistence(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            destination = state / 'extension'
            extension(destination, ['sensitive.example.org'])
            self.assertEqual(json.loads((destination / 'ordinary-routing.json').read_text()), {'mode': 'network'})
            extension(destination, ['sensitive.example.org'], 'external_pac')
            extension(destination, ['sensitive.example.org'])
            self.assertEqual(json.loads((destination / 'ordinary-routing.json').read_text()), {'mode': 'external_pac'})
            self.assertEqual((state / 'ordinary-routing-mode').stat().st_mode & 0o777, 0o600)
            extension(destination, ['sensitive.example.org'], 'network')
            self.assertEqual(json.loads((destination / 'ordinary-routing.json').read_text()), {'mode': 'network'})

    def test_invalid_or_untrusted_choice_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as root:
            state = Path(root)
            mode = state / 'ordinary-routing-mode'
            for value in ('invalid', 'network' * 100):
                mode.write_text(value)
                mode.chmod(0o600)
                with self.assertRaises(GuardError):
                    extension(state / 'extension', ['sensitive.example.org'])
            mode.write_text('external_pac')
            mode.chmod(0o644)
            with self.assertRaises(GuardError):
                extension(state / 'extension', ['sensitive.example.org'])
            mode.unlink()
            mode.symlink_to(state / 'missing')
            with self.assertRaises(GuardError):
                extension(state / 'extension', ['sensitive.example.org'])
