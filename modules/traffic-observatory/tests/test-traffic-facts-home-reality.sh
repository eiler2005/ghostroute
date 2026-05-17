#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

cat > "$TMPDIR/evidence.json" <<'JSON'
{
  "schema_version": 1,
  "generated_at": "2026-05-17T10:10:00.000Z",
  "window": {
    "period": "today",
    "start_ts_utc": "2026-05-16T21:00:00.000Z",
    "end_ts_utc": "2026-05-17T21:00:00.000Z"
  },
  "source": { "command": "traffic-evidence", "schema": "traffic-evidence-v1" },
  "flow_samples": [
    {
      "sample_id": "lan-flow-1",
      "ts": "2026-05-17T10:04:00.000Z",
      "client_ip": "192.0.2.20",
      "client_key": "lan-client",
      "remote_ip": "198.51.100.20",
      "remote_port": "443",
      "proto": "tcp",
      "route": "Unknown",
      "total_bytes": 400,
      "connections": 1,
      "source": "lan-flow-facts"
    }
  ],
  "lan_device_route_deltas": [],
  "sing_box_route_evidence": [
    {
      "id": "route-yt-1",
      "ts": "2026-05-17T10:04:00.000Z",
      "connection_id": "100",
      "route": "VPS",
      "outbound": "reality-out",
      "destination": "youtubei.googleapis.com:443",
      "destination_host": "youtubei.googleapis.com",
      "destination_port": "443",
      "source": "sing-box.log",
      "status": "ok",
      "inbound": "reality-in",
      "profile": "phone-a"
    },
    {
      "id": "route-yt-2",
      "ts": "2026-05-17T10:04:10.000Z",
      "connection_id": "101",
      "route": "VPS",
      "outbound": "reality-out",
      "destination": "youtubei.googleapis.com:443",
      "destination_host": "youtubei.googleapis.com",
      "destination_port": "443",
      "source": "sing-box.log",
      "status": "ok",
      "inbound": "reality-in",
      "profile": "phone-a"
    },
    {
      "id": "route-yt-3",
      "ts": "2026-05-17T10:04:20.000Z",
      "connection_id": "102",
      "route": "VPS",
      "outbound": "reality-out",
      "destination": "youtubei.googleapis.com:443",
      "destination_host": "youtubei.googleapis.com",
      "destination_port": "443",
      "source": "sing-box.log",
      "status": "ok",
      "inbound": "reality-in",
      "profile": "phone-a"
    },
    {
      "id": "route-telegram-1",
      "ts": "2026-05-17T10:04:30.000Z",
      "connection_id": "103",
      "route": "Direct",
      "outbound": "direct-out",
      "destination": "api.telegram.org:443",
      "destination_host": "api.telegram.org",
      "destination_port": "443",
      "source": "sing-box.log",
      "status": "ok",
      "inbound": "reality-in",
      "profile": "phone-a"
    }
  ],
  "home_reality_samples": [
    {
      "sample_id": "home-a",
      "ts": "2026-05-17T10:05:00.000Z",
      "client_key": "phone-a",
      "client_label": "phone-a",
      "source_ip": "198.51.100.10",
      "channel": "A/Home Reality",
      "bytes_up": 200,
      "bytes_down": 800,
      "total_bytes": 1000,
      "source": "mobile_reality_counter_delta",
      "allocation_basis": "observed_profile_counter_delta"
    },
    {
      "sample_id": "home-b",
      "ts": "2026-05-17T10:06:00.000Z",
      "client_key": "phone-b",
      "client_label": "phone-b",
      "source_ip": "198.51.100.11",
      "channel": "A/Home Reality",
      "bytes_up": 100,
      "bytes_down": 500,
      "total_bytes": 600,
      "source": "mobile_reality_counter_delta",
      "allocation_basis": "observed_profile_counter_delta"
    }
  ],
  "dns_queries": [
    {
      "id": "dns-1",
      "ts": "2026-05-17T10:03:59.000Z",
      "client_ip": "192.0.2.20",
      "domain": "lan.example.invalid",
      "answer_ip": "198.51.100.20",
      "qtype": "A",
      "ts_source": "parsed_log"
    }
  ],
  "warnings": []
}
JSON

GHOSTROUTE_TRAFFIC_FACTS_EVIDENCE_FILE="$TMPDIR/evidence.json" \
  "$PROJECT_ROOT/modules/traffic-observatory/bin/traffic-facts" --json today > "$TMPDIR/facts.json"

node - "$TMPDIR/facts.json" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.equal(payload.schema_version, 3);

const facts = payload.traffic_facts;
const phoneA = facts.filter((row) => row.client_key === "phone-a");
assert.equal(phoneA.length, 2);
assert.equal(phoneA.reduce((sum, row) => sum + row.bytes, 0), 1000);
assert.equal(phoneA.reduce((sum, row) => sum + row.via_vps_bytes + row.direct_bytes + row.unknown_bytes, 0), 1000);
assert.equal(phoneA.some((row) => row.destination === "Home Reality ingress"), false);

const youtube = phoneA.find((row) => row.destination === "youtubei.googleapis.com");
assert.ok(youtube);
assert.equal(youtube.bytes, 750);
assert.equal(youtube.via_vps_bytes, 750);
assert.equal(youtube.direct_bytes, 0);
assert.equal(youtube.dns_qname, "");
assert.equal(youtube.dns_status, "no_match");
assert.equal(youtube.destination_confidence, "sing_box_destination");
assert.equal(youtube.byte_confidence, "estimated_connection_share");
assert.equal(youtube.allocation_basis, "home_reality_connection_share");
assert.equal(youtube.evidence_level, "home_reality_sing_box_destination_estimate");
assert.equal(youtube.route_verification, "ingress_route_allocated");

const telegram = phoneA.find((row) => row.destination === "api.telegram.org");
assert.ok(telegram);
assert.equal(telegram.bytes, 250);
assert.equal(telegram.direct_bytes, 250);
assert.equal(telegram.via_vps_bytes, 0);

const phoneB = facts.find((row) => row.client_key === "phone-b");
assert.ok(phoneB);
assert.equal(phoneB.destination, "Home Reality ingress");
assert.equal(phoneB.bytes, 600);
assert.equal(phoneB.via_vps_bytes, 450);
assert.equal(phoneB.direct_bytes, 150);
assert.equal(phoneB.unknown_bytes, 0);

const lan = facts.find((row) => row.client_key === "lan-client");
assert.ok(lan);
assert.equal(lan.destination, "lan.example.invalid");
assert.equal(lan.dns_qname, "lan.example.invalid");
assert.equal(lan.bytes, 400);

const clientA = payload.clients.find((row) => row.client_key === "phone-a");
assert.ok(clientA);
assert.equal(clientA.total_bytes, 1000);
assert.equal(clientA.via_vps_bytes, 750);
assert.equal(clientA.direct_bytes, 250);
assert.equal(clientA.unknown_bytes, 0);
assert.equal(payload.coverage.traffic_fact_bytes, 2000);
NODE

echo "traffic-facts Home Reality attribution fixture test passed"
