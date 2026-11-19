#!/usr/bin/env python3
"""Exercise real probe functions with failed networking and retained log entries."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
MONITOR = ROOT / "modules/ghostroute-health-monitor/router"


class ProbeAvailabilityTests(unittest.TestCase):
    def run_probe(self, name, log_text, port=8443, tcp_status=1):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            config = work / "config.json"
            config.write_text(json.dumps({"outbounds": [{"tag": "reality-out", "server": "127.0.0.1", "server_port": port}]}, indent=2))
            log = work / "singbox.log"
            log.write_text(log_text)
            source = (MONITOR / "run-probes").read_text()
            functions = source[source.index("should_run()"):source.rindex("\nhm_init_dirs\n")]
            shell = f"""
. "{MONITOR / 'lib.sh'}"
PROBE_FILTER="{name}"
SINGBOX_CONFIG_PATH="{config}"
SINGBOX_LOG_PATH="{log}"
HEALTH_MONITOR_SOCKS_PORT=1
hm_curl() {{ return 28; }}
hm_tcp_open() {{ printf '%s\\n' "$2" >&2; return {tcp_status}; }}
hm_emit() {{ printf '%s %s\\n' "$1" "$2"; }}
{functions}
probe_{name}
"""
            return subprocess.run(["sh"], input=shell, text=True, capture_output=True, check=True)

    def test_stale_attempt_never_proves_availability(self):
        for name in ("channel_a_reality", "vps_path"):
            result = self.run_probe(name, "2000-01-01 outbound/vless[reality-out]: connection attempt\n")
            self.assertEqual(result.stdout.strip(), name + " UNKNOWN")

    def test_failed_network_without_log_is_critical(self):
        for name in ("channel_a_reality", "vps_path"):
            self.assertEqual(self.run_probe(name, "").stdout.strip(), name + " CRIT")

    def test_tcp_uses_configured_port(self):
        result = self.run_probe("vps_path", "", tcp_status=0)
        self.assertEqual(result.stdout.strip(), "vps_path OK")
        self.assertEqual(result.stderr.strip(), "8443")

    def test_missing_port_is_unknown(self):
        result = self.run_probe("vps_path", "", port=None)
        self.assertEqual(result.stdout.strip(), "vps_path UNKNOWN")


if __name__ == "__main__":
    unittest.main()

