#!/usr/bin/env python3
import base64
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import unittest
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
loader = importlib.machinery.SourceFileLoader('snell_profile', str(ROOT / 'modules/routing-core/bin/channel-snell-profile'))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


def decode(value):
    return base64.urlsafe_b64decode(value + '=' * (-len(value) % 4)).decode()


class SnellProfileTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host':'example.invalid', 'cover':'example.com'}
        self.slot = {'port':23456, 'psk':'test-snell-psk', 'shadowtls_password':'test-shadowtls-password'}

    def test_matches_native_shadowrocket_export(self):
        # Decoded from the app's own QR, using only a manually entered fake node.
        expected = 'snell://Y2hhY2hhMjAtaWV0Zi1wb2x5MTMwNTp0ZXN0LXNuZWxsLXBza0BleGFtcGxlLmludmFsaWQ6MjM0NTY?version=4&shadow-tls=eyJ2ZXJzaW9uIjoiMyIsImhvc3QiOiJleGFtcGxlLmNvbSIsInBhc3N3b3JkIjoidGVzdC1zaGFkb3d0bHMtcGFzc3dvcmQifQ#GhostRoute%20QR%20format%20test'
        self.assertEqual(module.uri(self.settings, self.slot, 'GhostRoute QR format test'), expected)

    def test_outer_password_and_sni_are_preserved(self):
        self.slot['shadowtls_password'] = 'fake+/=&unicode-ёж'
        parsed = urllib.parse.urlsplit(module.uri(self.settings, self.slot, 'тест #1'))
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query['version'], ['4'])
        self.assertEqual(json.loads(decode(query['shadow-tls'][0])), {'version':'3', 'host':'example.com', 'password':self.slot['shadowtls_password']})
        self.assertEqual(urllib.parse.unquote(parsed.fragment), 'тест #1')

    def test_ipv6_is_bracketed(self):
        self.settings['host'] = '2001:db8::1'
        parsed = urllib.parse.urlsplit(module.uri(self.settings, self.slot, 'test'))
        self.assertEqual(decode(parsed.netloc), 'chacha20-ietf-poly1305:test-snell-psk@[2001:db8::1]:23456')

    def test_empty_outer_password_is_rejected(self):
        self.slot['shadowtls_password'] = ''
        with self.assertRaises(ValueError):module.uri(self.settings, self.slot, 'test')

    def test_invalid_port_is_rejected(self):
        self.slot['port'] = 65536
        with self.assertRaises(ValueError):module.uri(self.settings, self.slot, 'test')


if __name__ == '__main__':unittest.main()
