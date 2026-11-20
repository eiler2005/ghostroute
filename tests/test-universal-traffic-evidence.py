import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SAMPLER = ROOT / 'modules/traffic-observatory/router/sing-box-route-evidence-snapshot'
FACTS = ROOT / 'modules/traffic-observatory/bin/traffic-facts'


def event(tag, profile='', outbound='reality-out', ident=42, host='example.invalid'):
    user = '[' + profile + '] ' if profile else ''
    return (
        f'+0000 2026-11-20 09:00:00 INFO [{ident} 1ms] inbound/{tag}: inbound connection from 192.0.2.10:1234\n'
        f'+0000 2026-11-20 09:00:00 INFO [{ident} 2ms] inbound/{tag}: {user}inbound connection to {host}:443\n'
        f'+0000 2026-11-20 09:00:00 INFO [{ident} 3ms] outbound/vless[{outbound}]: outbound connection to {host}:443\n'
    )


class UniversalTrafficEvidenceTest(unittest.TestCase):
    def test_event_detail_is_bounded_without_clipping_volume(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'evidence.json'
            file.write_text(json.dumps(dict(generated_at='2026-11-20T09:05:00Z',
                sing_box_route_evidence=[dict(ts='2026-11-20T09:00:00Z',connection_id=str(i),source='fixture',
                    channel='Channel anyT',profile='lab-client',destination_host='example.invalid',outbound='reality-out') for i in range(2010)],
                isolated_channel_samples=[dict(channel='anyT',client_key='anyT-01',sample_id='counter',ts='2026-11-20T09:05:00Z',bytes_up=123,bytes_down=0)])))
            result = subprocess.run([str(FACTS),'--json','today'],check=True,capture_output=True,text=True,
                env=dict(os.environ,GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE=str(file)))
            payload=json.loads(result.stdout)
            self.assertEqual(len(payload['traffic_facts']),2001)
            self.assertTrue(payload['coverage']['connection_events_truncated'])
            self.assertEqual(payload['coverage']['traffic_fact_bytes'],123)

    def test_route_correlation_rejects_conflicts_and_other_ports_or_protocols(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'evidence.json'
            sample=dict(sample_id='flow',ts='2026-11-20T09:00:00Z',client_ip='192.0.2.10',remote_ip='198.51.100.10',remote_port='443',proto='tcp',total_bytes=100)
            good=dict(ts=sample['ts'],client_ip=sample['client_ip'],destination_host=sample['remote_ip'],destination_port='443',protocol='tcp',outbound='reality-out')
            wrong=[{**good,'destination_port':'8443','outbound':'direct-out'},{**good,'protocol':'udp','outbound':'direct-out'}]
            for events,route in [(wrong+[good],'VPS'),(wrong+[good,{**good,'outbound':'direct-out'}],'Unknown')]:
                file.write_text(json.dumps(dict(generated_at=sample['ts'],flow_samples=[sample],sing_box_route_evidence=events)))
                result=subprocess.run([str(FACTS),'--json','today'],check=True,capture_output=True,text=True,
                    env=dict(os.environ,GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE=str(file)))
                self.assertEqual(json.loads(result.stdout)['traffic_facts'][0]['route'],route)

    def test_shared_client_key_does_not_mix_channels(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'evidence.json'
            file.write_text(json.dumps(dict(generated_at='2026-11-20T09:05:00Z',
                isolated_channel_samples=[dict(channel=channel,client_key='fixture',sample_id=channel,
                    ts='2026-11-20T09:05:00Z',bytes_up=amount,bytes_down=0) for channel,amount in [('anyT',100),('Snell',200)]])))
            result = subprocess.run([str(FACTS),'--json','today'],check=True,capture_output=True,text=True,
                env=dict(os.environ,GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE=str(file)))
            payload = json.loads(result.stdout)
            self.assertEqual([(r['channel'],r['total_bytes']) for r in payload['clients']], [('Channel anyT',100),('Channel Snell',200)])

    def test_all_processes_keep_identity_scope_and_rereads_do_not_duplicate(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            logs = {
                'SINGBOX_LOG_PATH': event('vless[reality-in]', 'fixture-a', ident=1)
                    + event('socks[channel-b-relay-socks]', ident=2)
                    + event('http[channel-c-shadowrocket-http-in]', 'fixture-c', ident=3)
                    + event('socks[channel-d-naiveproxy-socks-in]', ident=4)
                    + event('redirect[redirect-in]', ident=5),
                'GHOSTROUTE_ANYT_LOG_PATH': event('anytls[channel-anytls-in]', 'lab-client-04'),
                'GHOSTROUTE_SNELL_LOG_PATH': event('snell[snell-lab-1]'),
                'GHOSTROUTE_AMN_LOG_PATH': event('tun[amn-in]').replace(' connection ', ' packet connection '),
            }
            env = dict(os.environ, GHOSTROUTE_TRAFFIC_STATE_DIR=directory)
            for key, content in logs.items():
                file = temp / key
                file.write_text(content)
                env[key] = str(file)
            for _ in range(2):
                subprocess.run(['sh', str(SAMPLER)], env=env, check=True, capture_output=True)
            rows = [line.split('|') for line in (temp / 'sing-box-route-evidence.tsv').read_text().splitlines()]
            self.assertEqual(len(rows), 8)
            self.assertTrue(all(len(row) == 14 for row in rows))
            self.assertEqual(next(row[13] for row in rows if row[12] == 'Channel Amn'), 'udp')
            self.assertEqual({row[12] for row in rows}, {'A/Home Reality', 'Home Wi-Fi/LAN', 'Channel B', 'Channel C', 'Channel D', 'Channel anyT', 'Channel Snell', 'Channel Amn'})
            self.assertEqual(len({row[7] for row in rows if row[1] == '42'}), 3)

    def test_restart_does_not_reuse_old_identity_and_ipv6_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            temp = Path(directory)
            log = temp / 'main.log'
            log.write_text(event('vless[reality-in]', 'old-profile')
                + '+0000 2026-11-20 09:01:00 INFO sing-box started\n'
                + '+0000 2026-11-20 09:01:00 INFO [42 1ms] outbound/direct[direct-out]: outbound connection to [2001:db8::10]:443\n')
            env = dict(os.environ, GHOSTROUTE_TRAFFIC_STATE_DIR=directory, SINGBOX_LOG_PATH=str(log),
                GHOSTROUTE_ANYT_LOG_PATH='/nonexistent', GHOSTROUTE_SNELL_LOG_PATH='/nonexistent', GHOSTROUTE_AMN_LOG_PATH='/nonexistent')
            subprocess.run(['sh', str(SAMPLER)], env=env, check=True, capture_output=True)
            rows = (temp / 'sing-box-route-evidence.tsv').read_text().splitlines()
            last = rows[-1].split('|')
            self.assertEqual(last[5], '2001:db8::10')
            self.assertEqual(last[10:13], ['', '', ''])

    def test_connection_detail_never_allocates_profile_volume(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'evidence.json'
            channels = ['A/Home Reality', 'Channel B', 'Channel C', 'Channel D', 'Channel anyT', 'Channel Snell', 'Channel Amn', 'Home Wi-Fi/LAN']
            observations = [dict(id=str(i), ts='2026-11-20T09:00:00Z', connection_id=str(i), source='fixture',
                channel=channel, profile='lab-client-04' if channel == 'Channel anyT' else 'fixture',
                client_ip='192.0.2.10', inbound='snell-lab-1' if channel == 'Channel Snell' else 'fixture',
                destination_host='example.invalid', destination_port='443', outbound='reality-out') for i, channel in enumerate(channels)]
            observations.append({**observations[4], 'profile': 'lab-probe', 'connection_id': 'probe'})
            # A repeated read of the same connection event is one observation.
            observations.append(observations[4])
            file.write_text(json.dumps(dict(generated_at='2026-11-20T09:05:00Z', sing_box_route_evidence=observations,
                isolated_channel_samples=[dict(channel='anyT', client_key='anyT-04', sample_id='counter',
                    start='2026-11-20T09:00:00Z', ts='2026-11-20T09:05:00Z', bytes_up=100, bytes_down=900)])))
            result = subprocess.run([str(FACTS), '--json', 'today'], check=True, capture_output=True, text=True,
                env=dict(os.environ, GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE=str(file)))
            payload = json.loads(result.stdout)
            facts = payload['traffic_facts']
            detail = [r for r in facts if r['measurement_kind'] == 'connection_event']
            self.assertEqual(len(detail), len(channels))
            self.assertTrue(all(r['bytes'] == 0 and r['byte_confidence'] == 'not_measured' and r['measurement_role'] == 'detail' for r in detail))
            counter = next(r for r in facts if r['measurement_kind'] == 'counter_delta')
            self.assertEqual((counter['bytes'], counter['unknown_bytes'], counter['route']), (1000, 1000, 'Unknown'))
            self.assertIsNone(counter['connection_count'])
            self.assertEqual(payload['coverage']['traffic_fact_bytes'], 1000)
            self.assertEqual(payload['coverage']['channels']['Channel anyT']['connection_events'], 1)
            self.assertEqual(payload['coverage']['channels']['Channel B']['volume_status'], 'not_observed')
            self.assertEqual(payload['coverage']['channels']['Channel M']['destination_status'], 'not_observed')


if __name__ == '__main__':
    unittest.main()
