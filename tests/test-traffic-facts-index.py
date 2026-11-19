#!/usr/bin/env python3
"""Keep indexed report joins equivalent and bounded on unrelated daily evidence."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / "modules/traffic-observatory/bin/traffic-facts"


class IndexedFactsTests(unittest.TestCase):
    def run_report(self, report, payload, directory, timeout=10):
        evidence = directory / "evidence.json"
        evidence.write_text(json.dumps(payload))
        result = subprocess.run(["bash", str(report), "--json"], env={
            **os.environ, "GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE": str(evidence)
        }, text=True, capture_output=True, check=True, timeout=timeout)
        output = json.loads(result.stdout)
        output.pop("collector_metrics")
        return output

    def test_matching_semantics_for_client_shared_and_time_filters(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            sample = {"sample_id":"sample", "client_ip":"192.0.2.10", "remote_ip":"192.0.2.20", "ts":"2026-11-19T10:00:00Z", "total_bytes":100, "route":"VPS"}
            answer = {"id":"answer", "client_ip":"192.0.2.10", "answer_ip":"192.0.2.20", "domain":"example.invalid", "ts":"2026-11-19T09:59:00Z"}
            route = {"client_ip":"192.0.2.10", "destination":"example.invalid", "ts":"2026-11-19T10:00:00Z", "outbound":"reality-out"}
            for extra in ([], [{**answer, "id":"shared", "domain":"shared.invalid"}],
                          [{**answer, "client_ip":"192.0.2.99", "domain":"other.invalid"}],
                          [{**answer, "id":"future", "ts":"2026-11-19T10:01:00Z"}]):
                payload = {"generated_at":"2026-11-19T10:01:00Z", "flow_samples":[sample],
                           "dns_queries":[answer, *extra], "sing_box_route_evidence":[route, {**route, "client_ip":"192.0.2.99", "outbound":"direct-out"}]}
                output = self.run_report(REPORT, payload, work)
                fact = output["traffic_facts"][0]
                shared = any(row.get("id") == "shared" for row in extra)
                self.assertEqual(fact["destination"], "192.0.2.20" if shared else "example.invalid")
                self.assertEqual(fact["route"], "Unknown" if shared else "VPS")
                self.assertEqual(fact["bytes"], 100)
                self.assertEqual(fact["via_vps_bytes"], 0 if shared else 100)
                self.assertEqual(fact["dns_link_confidence"], "low" if shared else "medium")

    def test_unrelated_daily_evidence_does_not_require_cross_product(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {"generated_at":"2026-11-19T10:01:00Z",
                "flow_samples":[{"sample_id":str(i), "client_ip":"192.0.2.10", "remote_ip":"192.0.2.20", "ts":"2026-11-19T10:00:00Z", "total_bytes":1} for i in range(4000)],
                "dns_queries":[{"answer_ip":f"198.51.{i // 250}.{i % 250 + 1}", "domain":"other.invalid", "ts":"2026-11-19T10:00:00Z"} for i in range(12000)],
                "sing_box_route_evidence":[{"client_ip":f"198.51.{i // 250}.{i % 250 + 1}", "destination":"192.0.2.20", "outbound":"direct-out"} for i in range(12000)]}
            output = self.run_report(REPORT, payload, Path(directory), timeout=8)
            self.assertEqual(len(output["traffic_facts"]), 4000)
            self.assertEqual(output["coverage"]["traffic_fact_bytes"], 4000)
            self.assertTrue(all(row["unknown_bytes"] == 1 for row in output["traffic_facts"]))


if __name__ == "__main__":
    unittest.main()

