#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import socket
import struct
import threading
import unittest
from unittest.mock import patch
import subprocess

MODULE = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


probe = load('probe', MODULE / 'router/telegram-egress-probe.py')
control = load('control', MODULE / 'lib/telegram-egress-check.py')


def response(nonce):
    body = struct.pack('<I', 0x05162463) + nonce + bytes(16)
    return bytes(8) + bytes(8) + struct.pack('<I', len(body)) + body


class TelegramEgressTests(unittest.TestCase):
    def test_nonce_constructor_length_and_truncation(self):
        nonce = bytes(range(16))
        good = response(nonce)
        self.assertTrue(probe.valid_res_pq(good, nonce))
        for bad in [good[:-1], good[:20], b'X' + good[1:], good[:20] + bytes(4) + good[24:]]:
            self.assertFalse(probe.valid_res_pq(bad, nonce))
        self.assertFalse(probe.valid_res_pq(good, bytes(16)))

    def test_native_protocol_round_trip_and_wrong_nonce(self):
        for wrong_nonce in [False, True]:
            listener = socket.socket()
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            errors = []
            def serve():
                try:
                    with listener, listener.accept()[0] as stream:
                        stream.settimeout(2)
                        self.assertEqual(probe.exact(stream, 3), b'\x05\x01\x00')
                        stream.sendall(b'\x05\x00')
                        request = probe.exact(stream, 10)
                        self.assertEqual(request[-2:], struct.pack('!H', 5222))
                        stream.sendall(b'\x05\x00\x00\x01' + bytes(6))
                        head = probe.exact(stream, 2)
                        self.assertEqual(head[0], 0xef)
                        data = probe.exact(stream, head[1] * 4)
                        nonce = data[-16:] if not wrong_nonce else bytes(16)
                        data = response(nonce)
                        stream.sendall(bytes([len(data) // 4]) + data)
                except Exception as exc:
                    errors.append(exc)
            thread = threading.Thread(target=serve)
            thread.start()
            result = probe.native_probe(port, ('fixture', '192.0.2.10', 5222), 2)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertFalse(errors, errors)
            self.assertEqual(result['ok'], not wrong_nonce)

    def test_partial_body_or_timeout_cannot_pass(self):
        with patch.object(probe.subprocess, 'run', return_value=subprocess.CompletedProcess([], 28, b'partial', b'')):
            self.assertFalse(probe.transfer(19001, 'https://example.invalid', 2)[0])
        with patch.object(probe.subprocess, 'run', side_effect=subprocess.TimeoutExpired([], 2)):
            self.assertFalse(probe.transfer(19001, 'https://example.invalid', 2)[0])

    def test_qualification_is_fail_closed_and_requires_identity(self):
        good = [{'ok': True}]
        web = {'telegram': True, 'web': True}
        self.assertTrue(probe.qualifies(good, web, 'matches_configured', True))
        self.assertTrue(probe.qualifies(good, web, 'observed_not_home', True))
        for rows, sites, identity, unchanged in [
            ([], web, 'matches_configured', True),
            ([{'ok': False}], web, 'matches_configured', True),
            (good, {'telegram': False}, 'matches_configured', True),
            (good, {}, 'matches_configured', True),
            (good, web, 'home_leak', True),
            (good, web, 'mismatch', True),
            (good, web, 'failed', True),
            (good, web, 'matches_configured', False),
        ]:
            self.assertFalse(probe.qualifies(rows, sites, identity, unchanged))

    def test_prepare_reuses_real_role_contract_and_rejects_bad_targets(self):
        vault = {'vps_ssh_host': '198.51.100.10', 'vault_router_hermes_vps_host': '198.51.100.20',
                 'clients': [{'name': 'router', 'uuid': 'fixture-uuid', 'short_id': 'aa'}],
                 'reality_server_names': ['cover.example.invalid'], 'reality_server_public_key': 'fixture-public'}
        for key, value in {'server': 'backup.example.invalid', 'uuid': 'fixture-backup',
                           'server_name': 'backup-cover.example.invalid', 'public_key': 'fixture-key', 'short_id': 'bb'}.items():
            vault['vault_router_backup_reality_' + key] = value
        payload = control.prepare(vault, [('fixture', '192.0.2.10', 443)], 3, 8)
        self.assertEqual(set(payload['backends']), {'primary_vps', 'backup_reality', 'hermes_vps'})
        self.assertEqual(payload['backends']['primary_vps']['expected_exit'], '198.51.100.10')
        self.assertNotIn('expected_exit', payload['backends']['backup_reality'])
        for targets in [[], [('bad label', '192.0.2.10', 443)], [('fixture', 'not-an-ip', 443)], [('fixture', '192.0.2.10', 0)]]:
            with self.assertRaises(ValueError):
                control.prepare(vault, targets, 3, 8)


if __name__ == '__main__':
    unittest.main()
