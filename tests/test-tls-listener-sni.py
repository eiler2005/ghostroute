#!/usr/bin/env python3
"""Regression: a valid SNI-only listener must not fail the maintenance gate."""
from pathlib import Path
import os
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'modules/ghostroute-health-monitor/bin/live-check'


class SniProbeTest(unittest.TestCase):
    def probe(self, certificate_state):
        source = SOURCE.read_text()
        function = source[source.index('tls_listener_state() {'):source.index('udp_drop_ok() {')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'timeout').write_text('#!/bin/sh\nshift\nexec "$@"\n')
            (root / 'openssl').write_text('''#!/bin/sh
case "$1" in
 s_client)
   case " $* " in
     *" -servername example.invalid "*) echo certificate ;;
     *) exit 1 ;;
   esac ;;
 x509)
   [ "$CERT_STATE" != invalid ] || exit 1
   case " $* " in
     *" -checkend 2592000 "*) [ "$CERT_STATE" != expiring ] ;;
     *) exit 0 ;;
   esac ;;
esac
''')
            for file in root.iterdir():
                file.chmod(0o700)
            env = dict(os.environ, PATH=str(root)+':'+os.environ['PATH'], CERT_STATE=certificate_state)
            return subprocess.check_output(['sh'], input=function+'\ntls_listener_state 20443 example.invalid\n', text=True, env=env).strip()

    def test_valid_sni_only_listener(self):
        self.assertEqual(self.probe('valid'), 'current')

    def test_invalid_certificate_still_fails(self):
        self.assertEqual(self.probe('invalid'), 'invalid')

    def test_expiring_certificate_is_reported(self):
        self.assertEqual(self.probe('expiring'), 'expires-soon')


if __name__ == '__main__':
    unittest.main()
