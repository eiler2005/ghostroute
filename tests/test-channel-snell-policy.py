#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('snell', Path(__file__).resolve().parents[1] / 'modules/routing-core/router/channel-snell-policy.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
runtime_spec = importlib.util.spec_from_file_location('snell_runtime', Path(__file__).resolve().parents[1] / 'modules/routing-core/router/channel-snell.py')
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.source = {'inbounds': [{'type': 'anytls', 'tag': 'original'}],
                       'outbounds': [{'type': 'direct', 'tag': 'direct-out'}],
                       'dns': {'servers': []}, 'route': {'rules': [
                           {'inbound': 'original', 'port': 53, 'outbound': 'direct-out'},
                           {'ip_cidr': ['::/0'], 'action': 'reject'},
                           {'inbound': 'original', 'outbound': 'direct-out'}]}}
        self.slots = [{'port': 20001+i, 'psk': str(i)*40, 'shadowtls_password': str(i+3)*40} for i in range(3)]

    def test_only_wrapped_listeners_and_preserved_policy(self):
        before = copy.deepcopy(self.source)
        result = module.project(self.source, self.slots, 'example.invalid')
        self.assertEqual(self.source, before)
        self.assertEqual(result['outbounds'], before['outbounds'])
        self.assertEqual(result['dns'], before['dns'])
        for inbound in result['inbounds']:
            if inbound['type'] == 'shadowtls':
                self.assertTrue(inbound['strict_mode'])
                self.assertEqual(inbound['version'], 3)
            else:
                self.assertNotIn('listen', inbound)
                self.assertNotIn('listen_port', inbound)
        self.assertEqual(result['route']['rules'][1], before['route']['rules'][1])
        self.assertEqual(len(result['route']['rules'][0]['inbound']), 3)

    def test_reject_duplicate_keys_ports_and_foreign_scope(self):
        for field in ('port', 'psk', 'shadowtls_password'):
            slots = copy.deepcopy(self.slots)
            slots[1][field] = slots[0][field]
            with self.assertRaises(ValueError):
                module.project(self.source, slots, 'example.invalid')
        self.source['route']['rules'][0]['inbound'] = 'foreign'
        with self.assertRaises(ValueError):
            module.project(self.source, self.slots, 'example.invalid')

    def test_anyt_statistics_are_not_inherited(self):
        self.source['experimental'] = {'v2ray_api': {'listen': '127.0.0.1:12099'}}
        result = module.project(self.source, self.slots, 'example.invalid')
        self.assertNotIn('experimental', result)
        self.assertIn('experimental', self.source)

    def test_occupied_statistics_listener_does_not_stop_snell(self):
        address = '127.0.0.1:12099'
        anyt = Mock()
        anyt.stats_listener_available.return_value = False
        stats = {'v2ray_api': {}}
        chosen, suspended = runtime.select_stats(anyt, address, stats, None, None, None)
        self.assertIsNone(chosen)
        self.assertEqual(suspended, address)
        anyt.stats_listener_available.return_value = True
        # Availability returning later must not restart a running channel.
        chosen, suspended = runtime.select_stats(anyt, address, stats, Mock(poll=Mock(return_value=None)), None, suspended)
        self.assertIsNone(chosen)
        self.assertEqual(suspended, address)
        # A process that already owns the listener keeps it without rebinding.
        chosen, _ = runtime.select_stats(anyt, address, stats, Mock(poll=Mock(return_value=None)), address, None)
        self.assertIs(chosen, stats)


if __name__ == '__main__':
    unittest.main()
