#!/usr/bin/env python3
"""Exercise the router's actual awk stages with connection turnover fixtures."""
import re,subprocess,tempfile,unittest
from pathlib import Path

SOURCE=(Path(__file__).resolve().parents[1]/'modules/traffic-observatory/router/lan-flow-facts-snapshot').read_text()
PARSE=re.search(r"awk -v max_facts=.*?'\n(.*?)\n' \"\$TMP_LAN\" \"\$TMP_CONNTRACK\"",SOURCE,re.S).group(1)
DELTA=re.search(r"awk -F'\|' -v max_facts=.*?'\n(.*?)\n' \"\$PREV_FILE\" \"\$TMP_CURRENT\"",SOURCE,re.S).group(1)

class ConnectionDeltas(unittest.TestCase):
    def snapshot(self,connections,maximum=1200):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);lan=root/'lan';track=root/'conntrack'
            lan.write_text('192.0.2.10\n')
            track.write_text(''.join(f'tcp 6 100 ESTABLISHED src=192.0.2.10 dst=198.51.100.20 sport={port} dport=443 packets=1 bytes={up} src=198.51.100.20 dst=192.0.2.10 sport=443 dport={port} packets=1 bytes={down}\n' for port,up,down in connections))
            return subprocess.check_output(['awk','-v',f'max_facts={maximum}',PARSE,str(lan),str(track)],text=True)

    def deltas(self,previous,current):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);a=root/'previous';b=root/'current';a.write_text(previous);b.write_text(current)
            result=subprocess.check_output(['awk',"-F|",'-v','max_facts=1200',DELTA,str(a),str(b)],text=True)
            return [line.split('|') for line in result.splitlines()]

    def test_closed_connection_does_not_replay_survivor_lifetime_bytes(self):
        previous=self.snapshot([(10001,1000,10000),(10002,500,5000)])
        current=self.snapshot([(10001,1100,10500)])
        rows=self.deltas(previous,current)
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0][4:7],['100','500','600'])

    def test_new_tuple_is_a_baseline_then_only_its_increment_is_counted(self):
        previous=self.snapshot([(10001,100,1000)])
        current=self.snapshot([(10001,110,1100),(10002,500,5000)])
        self.assertEqual(self.deltas(previous,current)[0][6],'110')
        following=self.snapshot([(10001,120,1200),(10002,520,5500)])
        self.assertEqual(self.deltas(current,following)[0][6],'630')

    def test_reset_and_reappearance_never_replay_lifetime_bytes(self):
        initial=self.snapshot([(10001,1000,10000)])
        reset=self.snapshot([(10001,10,100)])
        self.assertEqual(self.deltas(initial,reset),[])
        self.assertEqual(self.deltas(reset,self.snapshot([(10001,20,200)]))[0][6],'110')
        absent=self.snapshot([(10002,10,100)])
        self.assertEqual(self.deltas(absent,initial),[])

    def test_legacy_aggregate_baseline_initializes_without_replay(self):
        legacy='192.0.2.10|198.51.100.20|443|tcp|1000|10000|2|ESTABLISHED\n'
        self.assertEqual(self.deltas(legacy,self.snapshot([(10001,1000,10000)])),[])

    def test_large_counters_and_fact_limit_do_not_truncate_connection_baselines(self):
        previous=self.snapshot([(10001,5*1024**3,10*1024**3)])
        current=self.snapshot([(10001,5*1024**3+123,10*1024**3+456)])
        self.assertEqual(self.deltas(previous,current)[0][6],'579')
        baseline=self.snapshot([(10000+i,10,100) for i in range(5)],maximum=1)
        self.assertEqual(len(baseline.splitlines()),5)

if __name__=='__main__':unittest.main()
