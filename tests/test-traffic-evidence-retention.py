#!/usr/bin/env python3
"""Append/compaction behavior without production data or storage dependencies."""
from pathlib import Path
import subprocess, tempfile, unittest

LIB = Path(__file__).resolve().parents[1] / 'modules/traffic-observatory/router/traffic-evidence-lib'


class RetentionTests(unittest.TestCase):
    def retain(self, path, now):
        subprocess.run(['sh', '-c', '. "$1"; traffic_evidence_retain "$2" 10 "$3"',
                        'retention-test', str(LIB), str(path), str(now)], check=True)

    def test_sparse_appends_keep_inode_until_hourly_compaction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'facts.tsv'
            records = [f'event-{i}|{i * 100}\n' for i in range(11)]
            path.write_text(''.join(records))
            before = path.stat()
            self.retain(path, 1000)
            self.retain(path, 4599)
            self.assertEqual(path.stat().st_ino, before.st_ino)
            self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertEqual(path.read_text(), ''.join(records))
            self.retain(path, 4600)
            self.assertEqual(path.read_text(), ''.join(records[-10:]))

    def test_burst_hits_safety_ceiling_without_waiting_an_hour(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'facts.tsv'
            records = [f'event-{i}|{i * 100}\n' for i in range(12)]
            path.write_text(''.join(records))
            self.retain(path, 1000)
            self.assertEqual(path.read_text(), ''.join(records[-10:]))
            self.assertEqual(len(path.read_text().splitlines()), 10)

    def test_quiet_history_does_not_write_a_marker_or_replace_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'facts.tsv'
            path.write_text('observed|7\n')
            before = path.stat()
            self.retain(path, 1000)
            self.assertEqual(path.stat().st_ino, before.st_ino)
            self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
            self.assertFalse(Path(str(path) + '.compacted-at').exists())

    def test_clock_rollback_does_not_disable_retention(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'facts.tsv'
            path.write_text(''.join(f'{i}\n' for i in range(11)))
            Path(str(path) + '.compacted-at').write_text('9000\n')
            self.retain(path, 1000)
            self.assertEqual(path.read_text(), ''.join(f'{i}\n' for i in range(1, 11)))


if __name__ == '__main__':
    unittest.main()
