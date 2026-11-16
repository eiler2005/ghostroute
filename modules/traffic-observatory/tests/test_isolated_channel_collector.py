import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('isolated_channel_collector', Path(__file__).resolve().parents[1] / 'lib/isolated_channel_collector.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProfileIntervalsTests(unittest.TestCase):
    def test_anyt_counts_user_only_and_ignores_probe_and_overlapping_scopes(self):
        before = {'channel': 'anyT', 'instance_id': 'a', 'ts': '2026-01-01T00:00:00Z', 'stats': {}}
        after = dict(before, ts='2026-01-01T00:01:00Z', stats={
            'user>>>lab-client>>>traffic>>>uplink': 100,
            'user>>>lab-client>>>traffic>>>downlink': 200,
            'user>>>lab-probe>>>traffic>>>uplink': 999,
            'inbound>>>anytls>>>traffic>>>uplink': 100,
            'outbound>>>direct-out>>>traffic>>>uplink': 100,
        })
        rows, gaps = module.profile_intervals(before, after)
        self.assertEqual(gaps, [])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]['client_key'], rows[0]['bytes_up'], rows[0]['bytes_down']), ('anyT-01', 100, 200))
        self.assertEqual(rows, module.profile_intervals(before, after)[0])

    def test_snell_user_and_reset_or_restart(self):
        key = 'user>>>snell-lab-2>>>traffic>>>downlink'
        before = {'channel': 'Snell', 'instance_id': 'a', 'ts': '2026-01-01T00:00:00Z', 'stats': {key: 10}}
        after = dict(before, ts='2026-01-01T00:01:00Z', stats={key: 90})
        rows, gaps = module.profile_intervals(before, after)
        self.assertEqual((rows[0]['client_key'], rows[0]['bytes_down'], gaps), ('Snell-02', 80, []))
        self.assertEqual(module.profile_intervals(before, dict(after, instance_id='b')), ([], ['process_changed']))
        rows, gaps = module.profile_intervals(before, dict(after, stats={key: 3}))
        self.assertEqual(rows, [])
        self.assertEqual(gaps, ['Snell-02:counter_reset'])

    def test_rejects_bad_stats_and_time(self):
        before = {'channel': 'anyT', 'instance_id': 'a', 'ts': '2026-01-01T00:00:00Z', 'stats': {}}
        with self.assertRaises(ValueError):
            module.profile_intervals(before, dict(before))
        with self.assertRaises(ValueError):
            module.profile_intervals(before, dict(before, ts='2026-01-01T00:01:00Z', stats={'user>>>lab-client>>>traffic>>>uplink': -1}))


if __name__ == '__main__':
    unittest.main()
