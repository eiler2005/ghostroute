#!/usr/bin/env python3
"""Evidence cadence and read-only sampler boundaries, independent of production."""
from pathlib import Path
import subprocess,tempfile,unittest
ROOT=Path(__file__).resolve().parents[1]
R=ROOT/'modules/traffic-observatory/router'

class CadenceTests(unittest.TestCase):
    def test_repeated_route_log_does_not_consume_retention_with_duplicates(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);log=folder/'sing-box.log'
            log.write_text('+0300 2026-11-17 09:00:00 INFO [123 0ms] outbound/vless[reality-out]: outbound connection to example.invalid:443\n')
            env={'PATH':'/usr/bin:/bin','GHOSTROUTE_TRAFFIC_STATE_DIR':d,'SINGBOX_LOG_PATH':str(log)}
            for _ in range(2):subprocess.run(['sh',str(R/'sing-box-route-evidence-snapshot')],check=True,env=env)
            rows=(folder/'sing-box-route-evidence.tsv').read_text().splitlines()
            self.assertEqual(len(rows),1)
            self.assertTrue(rows[0].startswith('2026-11-17T09:00:00+0300|123|'))
    def test_frequent_job_only_runs_evidence_readers(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);job=folder/'cron-traffic-evidence';job.write_text((R/job.name).read_text())
            expected=['lan-flow-facts-snapshot','dns-query-snapshot','sing-box-route-evidence-snapshot']
            for name in expected+['lan-traffic-accounting-refresh','mobile-reality-accounting-refresh']:
                p=folder/name;p.write_text('#!/bin/sh\necho '+name+' >> "'+str(folder/'calls')+'"\n');p.chmod(0o755)
            subprocess.run(['sh',str(job)],check=True)
            self.assertEqual((folder/'calls').read_text().splitlines(),expected)
    def test_supervisor_registers_five_minute_evidence_separately_from_maintenance(self):
        source=(ROOT/'modules/routing-core/router/ghostroute-runtime-supervisor').read_text()
        self.assertIn('cron_set TrafficEvidence "*/5 * * * *"',source)
        self.assertIn('cron_set TrafficSnapshot "0 */6 * * *"',source)
    def test_disabled_kernel_accounting_is_reported_without_enabling_it(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);acct=folder/'acct';acct.write_text('0\n')
            source=(R/'lan-flow-facts-snapshot').read_text().replace('STATE_DIR="/jffs/addons/router_configuration/traffic"','STATE_DIR="'+d+'"').replace('[ -x /opt/bin/opkg ] && STATE_DIR="/opt/var/log/router_configuration"',':').replace('ACCT_SYSCTL="/proc/sys/net/netfilter/nf_conntrack_acct"','ACCT_SYSCTL="'+str(acct)+'"')
            p=folder/'sampler';p.write_text(source)
            subprocess.run(['sh',str(p)],check=True,env={'PATH':'/usr/bin:/bin','GHOSTROUTE_LAN_FLOW_MAX_LOAD_X100':'999999'})
            self.assertEqual(acct.read_text(),'0\n')
            self.assertIn('accounting_disabled',(folder/'lan-flow-facts.status').read_text())
    def test_console_ingestion_does_not_leave_a_three_hour_night_gap(self):
        import re
        app=ROOT/'modules/ghostroute-console/app/scripts/run-with-collector.mjs'
        source=app.read_text()
        for setting in ['DAY','NIGHT']:
            line=next(line for line in source.splitlines() if 'GHOSTROUTE_COLLECT_'+setting+'_INTERVAL_SECONDS' in line)
            fallback=int(re.search(r'\|\| (\d+)\)',line).group(1))
            self.assertLessEqual(fallback,900,'detail polling must fit the router retention envelope')

if __name__=='__main__':unittest.main()
