#!/usr/bin/env python3
"""Project the live selected-client split into an isolated Amn TUN config."""
import argparse
import copy
import hashlib
import ipaddress
import json
import os
from pathlib import Path

SOURCE_TAG = "channel-b-relay-socks"
AMN_TAG = "channel-amn-tun"
BASE = Path("/opt/etc/ghostroute-amn")


def project(source, settings):
    if not any(i.get("tag") == SOURCE_TAG for i in source["inbounds"]):
        raise ValueError("Selected-client reference inbound is missing")
    rules = []
    for original in source["route"]["rules"]:
        scope = original.get("inbound", [])
        scope = [scope] if isinstance(scope, str) else scope
        if not scope:
            raise ValueError("Unscoped production rule requires explicit review")
        if SOURCE_TAG not in scope:
            continue
        rule = copy.deepcopy(original)
        rule["inbound"] = AMN_TAG
        if "auth_user" in rule:
            raise ValueError("User-scoped policy cannot be projected to an IP peer")
        rules.append(rule)
    # DNS needs to reach the existing loopback resolver before private-IP denial.
    dns = [r for r in rules if r.get("port") == 53]
    if len(dns) != 2 or dns[0].get("override_address") != "127.0.0.1" or dns[1].get("outbound") != "direct-out":
        raise ValueError("Reference DNS policy is not the supported router resolver path")
    rules = [r for r in rules if r not in dns]
    if not any(r.get("outbound") == "reality-out" and "rule_set" in r for r in rules):
        raise ValueError("Managed split is missing")
    if rules[-1] != {"inbound": AMN_TAG, "outbound": "direct-out"}:
        raise ValueError("Reference split final rule changed")
    referenced = {r["outbound"] for r in rules + dns if "outbound" in r}
    if not referenced <= {"direct-out", "reality-out", "sensitive-out"}:
        raise ValueError("Unexpected egress in reference policy")
    outbounds = [copy.deepcopy(o) for o in source["outbounds"] if o["tag"] in referenced]
    if {o["tag"] for o in outbounds} != referenced:
        raise ValueError("Referenced outbound is missing")
    if any(o["type"] not in ("vless", "direct") for o in outbounds):
        raise ValueError("Automatic egress selection is not supported")
    route = copy.deepcopy(source["route"])
    route["rules"] = dns + [
        {"ip_cidr": ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "::/0"], "action": "reject"},
        # First IPv4 lab forces TCP for QUIC on this inbound only.
        {"network": "udp", "port": 443, "action": "reject"},
    ] + rules
    route["final"] = "direct-out"
    address = ipaddress.ip_interface(settings["policy_address"])
    if address.version != 4 or address.network.prefixlen != 30 or address.ip == address.network.broadcast_address:
        raise ValueError("Policy TUN requires an isolated IPv4 /30 with a spare address")
    return {
        "log": {"level": "warn", "output": "/tmp/ghostroute-amn/policy.log", "timestamp": True},
        "dns": copy.deepcopy(source["dns"]),
        "inbounds": [{"type": "tun", "tag": AMN_TAG, "interface_name": "gr-amn-tun", "address": [str(address)], "mtu": settings["mtu"], "auto_route": False, "auto_redirect": False, "stack": "gvisor"}],
        "outbounds": outbounds,
        "route": route,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("settings", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    raw = args.source.read_bytes()
    result = project(json.loads(raw), json.loads(args.settings.read_text()))
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    args.output.with_suffix(".source.sha256").write_text(hashlib.sha256(raw).hexdigest() + "\n")


if __name__ == "__main__":
    main()
