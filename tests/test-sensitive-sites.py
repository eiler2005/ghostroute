#!/usr/bin/env python3
"""Render real routing config and exercise the sensitive sites contract offline."""
import copy
import json
import re
from pathlib import Path

import jinja2

ROOT = Path(__file__).resolve().parents[1]
DOMAINS = [line.strip() for line in (ROOT / "configs/sensitive-domains.txt").read_text().splitlines()
           if line.strip() and not line.lstrip().startswith("#")]
env = jinja2.Environment(undefined=jinja2.StrictUndefined)
env.filters["bool"] = lambda v: str(v).lower() in ("true", "1", "yes")
env.filters["to_json"] = json.dumps
template = env.from_string((ROOT / "ansible/roles/singbox_client/templates/config.json.j2").read_text())
BASE = {
    "router_managed_egress_mode": "backup_reality",
    "router_sensitive_sites_enabled": True,
    "router_sensitive_sites_domains": DOMAINS,
    "router_backup_reality_server": "backup.example.invalid",
    "router_backup_reality_server_port": 443,
    "router_backup_reality_uuid": "uuid-backup",
    "router_backup_reality_server_name": "backup-cover.example.invalid",
    "router_backup_reality_public_key": "backup-key",
    "router_backup_reality_short_id": "bb",
    "router_hermes_vps_host": "sensitive.example.invalid",
    "router_hermes_vps_port": 443,
    "router_hermes_vps_server_name": "sensitive-cover.example.invalid",
    "reality_server_public_key": "owned-key",
    "reality_server_names": ["cover.example.invalid"],
    "clients": [{"name": "router", "uuid": "uuid-owned", "short_id": "aa"}],
    "singbox_redirect_port": 12001,
    "singbox_log_path": "/tmp/sensitive-sites-fixture.log",
    "singbox_dnscrypt_socks_port": 12002,
    "router_dns_egress_mode": "policy_split",
    "home_reality_enabled": True,
    "home_reality_listen": "0.0.0.0",
    "home_reality_ingress_port": 12003,
    "home_clients": [{"name": "test-client", "uuid": "uuid-home"}],
    "home_reality_server_names": ["home.example.invalid"],
    "home_reality_dest_host": "cover.example.invalid",
    "home_reality_dest_port": 443,
    "home_reality_server_private_key": "home-private-fixture",
    "home_reality_server_short_ids": ["cc"],
    "channel_b_home_upstream_socks_port": 12004,
    "channel_c_home_enabled": True,
    "channel_c_home_listen": "127.0.0.1",
    "channel_c_home_ingress_port": 12005,
    "channel_c_home_clients": [{"username": "fixture", "password": "fixture"}],
    "channel_c_home_public_host": "naive.example.invalid",
    "channel_c_home_tls_cert_path": "/tmp/fixture.crt",
    "channel_c_home_tls_key_path": "/tmp/fixture.key",
    "channel_c_shadowrocket_enabled": True,
    "channel_c_shadowrocket_ingress_port": 12006,
    "channel_c_shadowrocket_clients": [{"username": "fixture", "password": "fixture"}],
    "channel_d_naiveproxy_enabled": True,
    "channel_d_naiveproxy_upstream_socks_port": 12007,
    "channel_d_managed_egress_mode": "follow",
    "channel_m_maxtg_enabled": True,
    "channel_m_maxtg_reverse_enabled": True,
    "channel_m_maxtg_listen": "127.0.0.1",
    "channel_m_maxtg_ingress_port": 12008,
    "channel_m_maxtg_reverse_ingress_port": 12009,
    "channel_m_maxtg_clients": [{"username": "fixture", "password": "fixture"}],
    "channel_m_maxtg_public_host": "service.example.invalid",
    "channel_m_maxtg_tls_cert_path": "/tmp/fixture.crt",
    "channel_m_maxtg_tls_key_path": "/tmp/fixture.key",
    "channel_a_selected_full_vps_enabled": True,
    "channel_a_selected_full_vps_lan_clients": ["fixture-client"],
    "channel_a_selected_full_vps_home_reality_users": ["test-client"],
    "channel_a_selected_full_vps_tproxy_port": 12010,
    "channel_a_selected_full_vps_dns_servers": ["192.0.2.53"],
}


def render(**overrides):
    return json.loads(template.render(**(BASE | overrides)))


def suffix(host, domain):
    return host == domain or host.endswith("." + domain)


def route(config, inbound, host, port=443):
    """First-match routing for the fields exercised by these traffic fixtures."""
    for rule in config["route"]["rules"]:
        inbounds = rule.get("inbound", [])
        if isinstance(inbounds, str):
            inbounds = [inbounds]
        if inbounds and inbound not in inbounds:
            continue
        if rule.get("action") in ("sniff", "route-options"):
            continue
        if "port" in rule:
            ports = rule["port"] if isinstance(rule["port"], list) else [rule["port"]]
            if port not in ports:
                continue
        if "auth_user" in rule or rule.get("ip_is_private"):
            continue
        if "domain" in rule and host not in rule["domain"]:
            continue
        if "domain_suffix" in rule and not any(suffix(host, d) for d in rule["domain_suffix"]):
            continue
        if "rule_set" in rule:
            # These fixtures represent destinations already classified managed.
            if host == "unmanaged.example.invalid":
                continue
        if "outbound" in rule:
            return rule["outbound"]
    return config["route"]["final"]


def main():
    c = render()
    inbounds = {x["tag"] for x in c["inbounds"]}
    scoped = set(c["route"]["rules"][1]["inbound"])
    assert scoped <= inbounds, scoped - inbounds
    assert not any(x.startswith("channel-m-") for x in scoped)
    assert c["route"]["rules"][0]["action"] == "sniff"
    assert "redirect-in" in scoped, "LAN REDIRECT must sniff before its catch-all"
    for inbound in scoped:
        for host in ["claude.ai", "api.anthropic.com", "platform.claude.com",
                     "bridge.claudeusercontent.com", "widget.claudemcpcontent.com",
                     "chatgpt.com", "ws.chatgpt.com", "api.openai.com", "cdn.openaimerge.com",
                     "gemini.google.com", "aistudio.google.com", "generativelanguage.googleapis.com",
                     "notebooklm.google.com", "accounts.google.com"]:
            assert route(c, inbound, host) == "sensitive-out", (inbound, host)
        for host in ["youtube.com", "www.google.com", "maps.google.com",
                     "youtubei.googleapis.com", "github.com", "evilclaude.ai", "claude.ai.attacker.invalid"]:
            assert route(c, inbound, host) == "reality-out", (inbound, host)
    for inbound in [x for x in inbounds if x.startswith("channel-m-")]:
        assert route(c, inbound, "claude.ai") == "direct-out"
    assert route(c, "channel-c-naive-in", "unmanaged.example.invalid") == "direct-out"
    outbounds = {o["tag"]: o for o in c["outbounds"]}
    assert outbounds["reality-out"]["server"] == "backup.example.invalid"
    assert outbounds["sensitive-out"]["server"] == "sensitive.example.invalid"
    assert outbounds["sensitive-out"]["type"] == "vless"
    assert not any(o["type"] in ("selector", "urltest") for o in c["outbounds"])
    assert "detour" not in outbounds["sensitive-out"], "no chained fallback"
    # An unavailable chosen outbound must remain selected, never retry the next
    # routing rule with a different egress identity.
    broken = copy.deepcopy(c)
    next(o for o in broken["outbounds"] if o["tag"] == "sensitive-out")["server"] = "unavailable.example.invalid"
    assert route(broken, "redirect-in", "claude.ai") == "sensitive-out"
    pinned = render(channel_d_managed_egress_mode="primary_vps", vps_ssh_host="primary.example.invalid")
    assert route(pinned, "channel-d-naiveproxy-socks-in", "claude.ai") == "sensitive-out"
    assert route(pinned, "channel-d-naiveproxy-socks-in", "youtube.com") == "reality-out-d"
    disabled = render(router_sensitive_sites_enabled=False)
    assert not any(o["tag"] == "sensitive-out" for o in disabled["outbounds"])
    assert route(disabled, "redirect-in", "claude.ai") == "reality-out"
    extended = render(router_sensitive_sites_domains=DOMAINS + ["new-sensitive.example.invalid"])
    for inbound in scoped:
        assert route(extended, inbound, "api.new-sensitive.example.invalid") == "sensitive-out"
    assert disabled["inbounds"] == c["inbounds"], "no client-visible migration"
    minimal = render(channel_c_home_enabled=False, channel_c_shadowrocket_enabled=False,
                     channel_d_naiveproxy_enabled=False, home_reality_enabled=False,
                     channel_m_maxtg_enabled=False, channel_a_selected_full_vps_enabled=False)
    assert set(minimal["route"]["rules"][1]["inbound"]) == {"redirect-in", "dnscrypt-socks-in"}
    assert len(DOMAINS) == len(set(DOMAINS))
    assert all(re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z0-9-]+", d) for d in DOMAINS)
    assert not {"google.com", "googleapis.com", "gstatic.com", "googleusercontent.com"} & set(DOMAINS)
    catalog = set(re.findall(r"^ipset=/([^/]+)/STEALTH_DOMAINS$", (ROOT / "configs/dnsmasq-stealth.conf.add").read_text(), re.M))
    assert all(any(suffix(d, parent) for parent in catalog) for d in DOMAINS), "sensitive domains must reach LAN REDIRECT"
    direct = [x.strip() for x in (ROOT / "configs/domains-no-vpn.txt").read_text().splitlines()
              if x.strip() and not x.lstrip().startswith("#")]
    assert not any(suffix(d, x) or suffix(x, d) for d in DOMAINS for x in direct), "direct exceptions conflict with sensitive sites"
    print("sensitive sites: rendered routing, lane isolation, fallback, catalog and disabled-mode checks passed")


if __name__ == "__main__":
    main()
