import io
import json
from pathlib import Path
import plistlib
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from mac_guard.chrome_bridge import forward, launch_app, serve
from mac_guard.install import native_host


class ChromeLaunchTests(unittest.TestCase):
    def test_launch_is_fixed_and_does_not_forward_access(self):
        state, app = Path('/fixture'), Path('/fixture/Guard.app')
        message = {'op': 'launch', 'profile': 'a' * 32}
        with patch('mac_guard.chrome_bridge.launch_app', return_value={'ok': True}) as launch, \
                patch('mac_guard.chrome_bridge.socket.socket') as connection:
            self.assertEqual(forward(state, message, app), {'ok': True})
            launch.assert_called_once_with(app)
            connection.assert_not_called()
            launch.reset_mock()
            for invalid in [dict(message, app='/arbitrary.app'), dict(message, allowed=True),
                            dict(message, url='https://example.org'), dict(message, profile='invalid')]:
                self.assertEqual(forward(state, invalid, app), {'ok': False})
            launch.assert_not_called()

    @patch('mac_guard.chrome_bridge.sys.platform', 'darwin')
    def test_launch_only_installed_bundle_with_bounded_background_open(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / 'Guard with spaces.app'
            (app / 'Contents').mkdir(parents=True)
            info = app / 'Contents/Info.plist'
            info.write_bytes(plistlib.dumps({'CFBundleIdentifier': 'org.ghostroute.guard'}))
            with patch('mac_guard.chrome_bridge.subprocess.run') as run:
                self.assertEqual(launch_app(app), {'ok': True})
                run.assert_called_once_with(['/usr/bin/open', '-g', '-a', str(app.resolve()), '--args', '--background'],
                                            check=True, capture_output=True, timeout=3)
                run.side_effect = subprocess.TimeoutExpired('open', 3)
                self.assertEqual(launch_app(app), {'ok': False})
                run.reset_mock()
                for content in [plistlib.dumps({'CFBundleIdentifier': 'other.application'}), plistlib.dumps([]), b'broken']:
                    info.write_bytes(content)
                    self.assertEqual(launch_app(app), {'ok': False})
                self.assertEqual(launch_app(None), {'ok': False})
                self.assertEqual(launch_app(Path(temporary) / 'missing.app'), {'ok': False})
                run.assert_not_called()

    def test_launch_frame_reply_does_not_claim_connected_or_allowed(self):
        message = json.dumps({'op': 'launch', 'profile': 'a' * 32}).encode()
        output = io.BytesIO()
        with patch('mac_guard.chrome_bridge.launch_app', return_value={'ok': True}):
            serve(io.BytesIO(struct.pack('=I', len(message)) + message), output, Path('/fixture'))
        self.assertEqual(json.loads(output.getvalue()[4:]), {'ok': True})

    def test_installer_binds_bundle_path_not_browser_payload(self):
        import shlex
        import sys
        with tempfile.TemporaryDirectory() as temporary:
            state = Path(temporary)
            app = state / 'App with spaces.app'
            native_host(state, state / 'extension', state / 'manifests', Path(sys.executable), app)
            command = (state / 'Chrome Native Host/ghostroute-events').read_text().splitlines()[1]
            args = shlex.split(command)
            self.assertEqual(args[args.index('--app') + 1], str(app.resolve()))


if __name__ == '__main__':
    unittest.main()
