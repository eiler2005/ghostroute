"""Exercise rollback orchestration with isolated paths and mocked Docker/curl."""
import io
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest


class RollbackTest(unittest.TestCase):
    def test_restore_targets_only_console_and_preserves_database(self):
        source = Path(__file__).resolve().parents[1] / 'vps/rollback-console.sh'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve() / 'console'
            backup = root / 'rollback/release'
            backup.mkdir(parents=True)
            repo = root / 'repo'
            repo.mkdir()
            data = root / 'data'
            data.mkdir()
            database = data / 'ghostroute.db'
            database.write_bytes(b'current traffic database')
            (backup / 'image-tag').write_text('ghostroute-console:rollback-test')
            with tarfile.open(backup / 'console-source.tar.gz', 'w:gz') as archive:
                member = tarfile.TarInfo('modules/ghostroute-console/vps/restore-marker')
                member.size = 8
                archive.addfile(member, io.BytesIO(b'previous'))
            script = Path(directory) / 'rollback.sh'
            script.write_text(source.read_text().replace('root=/opt/ghostroute-console', f'root={root}'))
            binary = Path(directory) / 'bin'
            binary.mkdir()
            log = Path(directory) / 'commands'
            for command in ['docker', 'curl']:
                mock = binary / command
                mock.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$ROLLBACK_TEST_LOG"\n')
                mock.chmod(0o700)
            env = {**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH'], 'ROLLBACK_TEST_LOG': str(log)}
            result = subprocess.run(['sh', str(script), str(backup)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            commands = log.read_text()
            self.assertIn('stop ghostroute-console', commands)
            self.assertIn('up -d --no-build ghostroute-console', commands)
            self.assertNotIn(' down', commands)
            self.assertEqual(database.read_bytes(), b'current traffic database')
            self.assertEqual((repo / 'modules/ghostroute-console/vps/restore-marker').read_bytes(), b'previous')
            # An invalid backup must be rejected before any Docker action.
            before = log.read_text()
            result = subprocess.run(['sh', str(script), str(root / 'data')], env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(log.read_text(), before)


if __name__ == '__main__':
    unittest.main()
