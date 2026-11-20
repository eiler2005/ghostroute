"""Cross-channel accounting must preserve scope, units and missing evidence."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
FACTS = ROOT / 'modules/traffic-observatory/bin/traffic-facts'
AT = '2026-11-20T09:05:00Z'


def facts(**sources):
    with tempfile.TemporaryDirectory() as directory:
        file = Path(directory) / 'evidence.json'
        file.write_text(json.dumps(dict(generated_at=AT, **sources)))
        result = subprocess.run([str(FACTS), '--json', 'today'],
            capture_output=True, text=True,
            env=dict(os.environ, GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE=str(file)))
        if result.returncode:
            raise AssertionError(result.stderr)
        return json.loads(result.stdout)


class MeasurementCoreTests(unittest.TestCase):
    def test_sensitive_exit_is_observed_for_each_channel_without_allocating_bytes(self):
        channels = ['Home Wi-Fi/LAN', 'A/Home Reality', 'Channel B', 'Channel C',
                    'Channel D', 'Channel anyT', 'Channel Snell', 'Channel Amn']
        events = [dict(ts=AT, channel=ch, connection_id=str(i), source='fixture',
            client_ip='192.0.2.10', profile='lab-client' if ch == 'Channel anyT' else 'fixture',
            inbound='snell-lab-1' if ch == 'Channel Snell' else 'fixture',
            destination_host='example.invalid', destination_port='443', outbound='sensitive-out')
            for i,ch in enumerate(channels)]
        rows = facts(sing_box_route_evidence=events)['traffic_facts']
        self.assertEqual(len(rows), len(channels))
        self.assertTrue(all(r['route']=='VPS' and r['bytes']==0 and r['byte_confidence']=='not_measured' for r in rows))

    def test_other_channel_event_cannot_verify_a_home_wifi_flow(self):
        flow = dict(sample_id='lan', ts=AT, client_ip='192.0.2.10',
            remote_ip='198.51.100.10', remote_port='443', proto='tcp',
            total_bytes=100, connections=1)
        for channel in ('A/Home Reality', 'Channel B', 'Channel C', 'Channel D',
                        'Channel anyT', 'Channel Snell', 'Channel Amn', 'Channel M'):
            with self.subTest(channel=channel):
                event = dict(ts=AT, client_ip=flow['client_ip'],
                    destination_host=flow['remote_ip'], destination_port='443',
                    protocol='tcp', outbound='reality-out', channel=channel)
                row = facts(flow_samples=[flow], sing_box_route_evidence=[event])['traffic_facts'][0]
                self.assertEqual(row['route'], 'Unknown')
                self.assertEqual(row['unknown_bytes'], 100)

    def test_all_counter_adapters_use_one_volume_and_measurement_contract(self):
        amount = 8 * 1024**3 + 123
        home = dict(sample_id='home', client_key='shared', channel='A/Home Reality',
            ts=AT, bytes_up=123, bytes_down=amount-123, total_bytes=amount)
        lan = dict(sample_id='lan', client_key='shared', client_ip='192.0.2.10',
            ts=AT, interval_start_utc='2026-11-20T09:00:00Z',
            total_bytes=amount, vpn_bytes=123, direct_bytes=amount-123, other_bytes=0)
        isolated = [dict(sample_id=ch, client_key='shared', channel=ch, ts=AT,
            bytes_up=123, bytes_down=amount-123) for ch in ('anyT', 'Snell', 'Amn', 'D')]
        payload = facts(home_reality_samples=[home], lan_device_route_deltas=[lan],
            isolated_channel_samples=isolated)
        self.assertEqual(len(payload['traffic_facts']), 6)
        self.assertEqual(len(payload['clients']), 6)
        self.assertEqual(payload['coverage']['traffic_fact_bytes'], 6 * amount)
        for row in payload['traffic_facts']:
            self.assertEqual(row['bytes'], amount)
            self.assertEqual(row['bytes'], row['via_vps_bytes'] + row['direct_bytes'] + row['unknown_bytes'])
            self.assertEqual(row['measurement_role'], 'volume')
            self.assertEqual(row['destination'], '')
            if row['channel'] == 'Channel D':
                self.assertEqual((row['measurement_kind'], row['connection_count']), ('completed_stream', 1))
            else:
                self.assertEqual((row['measurement_kind'], row['connection_count']), ('counter_delta', None))
        for channel in ('Channel B', 'Channel C', 'Channel M'):
            self.assertEqual(payload['coverage']['channels'][channel]['volume_status'], 'not_observed')


if __name__ == '__main__':
    unittest.main()
