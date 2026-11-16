"""Read-only process observations reject PID reuse and never disclose settings."""
from pathlib import Path
import tempfile
import unittest


class ObserverTest(unittest.TestCase):
    def test_owned_processes_and_missing_state(self):
        source = (Path(__file__).resolve().parents[1] / 'bin/channel-health-report').read_text()
        body = source.split("/opt/bin/python3 -I - <<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        namespace = {}
        exec(body.replace('print(json.dumps(observe()))', ''), namespace)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'proc').mkdir()
            namespace['Path'] = lambda value: root / str(value).lstrip('/')
            observed = namespace['observe']()
            self.assertEqual([row['channel'] for row in observed['channels']], ['D', 'anyT', 'Snell', 'Amn'])
            self.assertFalse(observed['channels'][-1]['enabled'])
            self.assertTrue(all(row['application_probe'] == 'not observed' for row in observed['channels']))
            run = root / 'tmp/ghostroute-anytls'
            run.mkdir(parents=True)
            (run / 'policy.pid').write_text('42')
            proc = root / 'proc/42'
            proc.mkdir()
            (proc / 'cmdline').write_bytes(b'unrelated-process\0')
            args = ['/opt/etc/ghostroute-anytls/sing-box-atls', 'run', '-c', '/opt/etc/ghostroute-anytls/policy.json']
            self.assertFalse(namespace['owned'](run, 'policy', args))
            (proc / 'cmdline').write_bytes(b'\0'.join(arg.encode() for arg in args) + b'\0')
            self.assertTrue(namespace['owned'](run, 'policy', args))
            # Observation reads no authentication settings and creates no runtime files.
            self.assertFalse((root / 'opt').exists())


if __name__ == '__main__':
    unittest.main()
