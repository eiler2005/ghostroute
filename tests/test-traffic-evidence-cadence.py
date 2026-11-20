#!/usr/bin/env python3
"""Evidence cadence and read-only sampler boundaries, independent of production."""
from pathlib import Path
import os,subprocess,tempfile,unittest
ROOT=Path(__file__).resolve().parents[1]
R=ROOT/'modules/traffic-observatory/router'

class CadenceTests(unittest.TestCase):
    def test_counter_readers_do_not_invoke_accounting_maintenance(self):
        for name in ['lan-device-counters-snapshot','mobile-reality-counters-snapshot']:
            with self.subTest(reader=name), tempfile.TemporaryDirectory() as d:
                folder=Path(d); calls=folder/'mutations'
                for owner in ['lan-traffic-accounting-refresh','mobile-reality-accounting-refresh']:
                    stub=folder/owner
                    stub.write_text('#!/bin/sh\necho mutation >> "'+str(calls)+'"\n')
                    stub.chmod(0o755)
                save=folder/'iptables-save'
                save.write_text('#!/bin/sh\necho "[1:9000000000] -A RC_MOBILE_REALITY_IN -s 192.0.2.10/32 -j RETURN"\n')
                save.chmod(0o755)
                reader=folder/name
                reader.write_text((R/name).read_text().replace('/jffs/scripts/',str(folder)+'/'))
                subprocess.run(['sh',str(reader)],check=True,capture_output=True,
                    env=dict(os.environ,PATH=str(folder)+':'+os.environ['PATH'],SINGBOX_LOG=str(folder/'absent.log')))
                self.assertFalse(calls.exists(),'reading counters must not install or refresh firewall rules')
    def test_repeated_route_log_does_not_consume_retention_with_duplicates(self):
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);log=folder/'sing-box.log'
            log.write_text('+0300 2026-11-17 09:00:00 INFO [123 0ms] outbound/vless[reality-out]: outbound connection to example.invalid:443\n')
            env={'PATH':'/usr/bin:/bin','GHOSTROUTE_TRAFFIC_STATE_DIR':d,'SINGBOX_LOG_PATH':str(log)}
            subprocess.run(['sh',str(R/'sing-box-route-evidence-snapshot')],check=True,env=env)
            before=(folder/'sing-box-route-evidence.tsv').stat().st_mtime_ns
            subprocess.run(['sh',str(R/'sing-box-route-evidence-snapshot')],check=True,env=env)
            self.assertEqual((folder/'sing-box-route-evidence.tsv').stat().st_mtime_ns,before,'quiet polls must not rewrite retained history')
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
            (folder/'traffic-evidence-lib').write_text((R/'traffic-evidence-lib').read_text())
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
