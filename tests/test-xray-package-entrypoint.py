#!/usr/bin/env python3
"""Exercise the actual Ansible shell task against temporary package layouts."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
TASKS = yaml.safe_load((ROOT / 'ansible/roles/channel_b_home_relay/tasks/main.yml').read_text())
SCRIPT = next(t['ansible.builtin.raw'] for t in TASKS[1]['block'] if t['name'].startswith('Preserve legacy Xray'))


class EntrypointTests(unittest.TestCase):
    def run_task(self, root):
        script = SCRIPT.replace('{{ channel_b_home_router_xray_bin_path | quote }}', shlex.quote('/opt/bin/xray'))
        script = script.replace('/opt/', str(root)+'/')
        return subprocess.run(['sh'], input=script, text=True, capture_output=True)

    def test_new_layout_creates_idempotent_alias(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'bin').mkdir(); (root/'sbin').mkdir()
            binary = root/'sbin/xray'; binary.write_text('#!/bin/sh\n'); binary.chmod(0o700)
            first = self.run_task(root)
            self.assertEqual(first.returncode, 0)
            self.assertIn('alias_created', first.stdout)
            self.assertEqual((root/'bin/xray').resolve(), binary.resolve())
            second = self.run_task(root)
            self.assertEqual(second.returncode, 0)
            self.assertNotIn('alias_created', second.stdout)

    def test_existing_binary_and_broken_link_are_not_replaced(self):
        for broken in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root/'bin').mkdir(); (root/'sbin').mkdir()
                (root/'sbin/xray').write_text('package'); (root/'sbin/xray').chmod(0o700)
                legacy = root/'bin/xray'
                if broken: legacy.symlink_to('absent')
                else: legacy.write_text('custom'); legacy.chmod(0o700)
                result = self.run_task(root)
                self.assertEqual(result.returncode, 1 if broken else 0)
                self.assertNotIn('alias_created', result.stdout)
                self.assertEqual(os.readlink(legacy) if broken else legacy.read_text(), 'absent' if broken else 'custom')


if __name__ == '__main__':
    unittest.main()
