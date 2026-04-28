#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains() {
  local path="$1"
  local pattern="$2"
  if ! rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain pattern: ${pattern}" >&2
    exit 1
  fi
}

assert_contains_fixed() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain text: ${needle}" >&2
    exit 1
  fi
}

assert_generated_contains_fixed() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "$path" >/dev/null; then
    echo "Expected generated ${path} to contain text: ${needle}" >&2
    sed -n '1,160p' "$path" >&2 || true
    exit 1
  fi
}

assert_compact_contains() {
  local path="$1"
  local needle="$2"
  local compact
  compact="$(tr -d '[:space:]' < "${PROJECT_ROOT}/${path}")"
  if ! grep -F -- "$needle" >/dev/null <<<"$compact"; then
    echo "Expected ${path} compact form to contain text: ${needle}" >&2
    exit 1
  fi
}

SINGBOX_TEMPLATE="ansible/roles/singbox_client/templates/config.json.j2"
ROUTING_TEMPLATE="ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2"
RULESET_SCRIPT="modules/routing-core/router/update-singbox-rule-sets.sh"

# api.ipify.org is only the explicit A/B/C parity canary. The real contract is
# broader: every domain/CIDR classified as managed after reaching the router
# must follow the same managed-vs-direct split on LAN/Wi-Fi and Channels A/B/C.
assert_contains_fixed "configs/dnsmasq-stealth.conf.add" "ipset=/ipify.org/STEALTH_DOMAINS"
assert_contains_fixed "ansible/group_vars/routers.yml" "managed_split_checker_domain: ipify.org"
assert_contains_fixed "ansible/group_vars/routers.yml" "managed_split_checker_host: api.ipify.org"

# Channel A LAN/Wi-Fi path: DNS-populated STEALTH_DOMAINS must enter the local
# sing-box REDIRECT listener, static CIDRs use the same path, and QUIC must be
# dropped to force TCP inspection.
assert_contains "$ROUTING_TEMPLATE" 'iptables -t nat -A PREROUTING -i br0 -p tcp -m set --match-set "\$IPSET" dst -j REDIRECT --to-ports "\$REDIRECT_PORT"'
assert_contains "$ROUTING_TEMPLATE" 'iptables -t nat -A PREROUTING -i br0 -p tcp -m set --match-set "\$STATIC_IPSET" dst -j REDIRECT --to-ports "\$REDIRECT_PORT"'
assert_contains "$ROUTING_TEMPLATE" 'iptables -I FORWARD 1 -i br0 -p udp --dport 443 -m set --match-set "\$IPSET" dst -j DROP'
assert_contains "$ROUTING_TEMPLATE" 'iptables -I FORWARD 1 -i br0 -p udp --dport 443 -m set --match-set "\$STATIC_IPSET" dst -j DROP'
assert_contains_fixed "$SINGBOX_TEMPLATE" '{ "inbound": "redirect-in", "outbound": "reality-out" }'

# Selected-client home-first paths: every remote ingress must apply the same
# post-ingress policy: sniff target, send tunneled DNS through Reality, keep
# local direct exceptions direct, send managed destinations to Reality/VPS, then
# fall back to home WAN direct.
for inbound in \
  "reality-in" \
  "channel-b-relay-socks" \
  "channel-c-naive-in" \
  "channel-c-shadowrocket-http-in"; do
  assert_contains_fixed "$SINGBOX_TEMPLATE" "\"inbound\": \"${inbound}\""
  if [ "$inbound" != "reality-in" ] || rg -n -F -- '"inbound": "reality-in", "action": "sniff"' "${PROJECT_ROOT}/${SINGBOX_TEMPLATE}" >/dev/null; then
    assert_contains_fixed "$SINGBOX_TEMPLATE" "\"inbound\": \"${inbound}\", \"action\": \"sniff\""
  fi
  assert_compact_contains "$SINGBOX_TEMPLATE" "\"inbound\":\"${inbound}\",\"port\":[53,853],\"outbound\":\"reality-out\""
  assert_compact_contains "$SINGBOX_TEMPLATE" "\"inbound\":\"${inbound}\",\"domain_suffix\":[\"vtb.ru\",\"app-analytics-services-att.com\",\"app-measurement.com\",\"firebaseinstallations.googleapis.com\"],\"outbound\":\"direct-out\""
  assert_compact_contains "$SINGBOX_TEMPLATE" "\"inbound\":\"${inbound}\",\"rule_set\":[\"stealth-domains\",\"stealth-static\"],\"outbound\":\"reality-out\""
  assert_compact_contains "$SINGBOX_TEMPLATE" "\"inbound\":\"${inbound}\",\"outbound\":\"direct-out\""
done

# The rule-set generator is the bridge between dnsmasq/ipset state and mobile
# selected-client routing. It must consume manual catalog, auto catalog, static
# CIDRs, and live/snapshotted STEALTH_DOMAINS IPs.
assert_contains_fixed "$RULESET_SCRIPT" 'MANUAL_DNSMASQ="${MANUAL_DNSMASQ:-/jffs/configs/dnsmasq-stealth.conf.add}"'
assert_contains_fixed "$RULESET_SCRIPT" 'AUTO_DNSMASQ="${AUTO_DNSMASQ:-/jffs/configs/dnsmasq-autodiscovered.conf.add}"'
assert_contains_fixed "$RULESET_SCRIPT" 'STEALTH_IPSET_SNAPSHOT="${STEALTH_IPSET_SNAPSHOT:-}"'
assert_contains_fixed "ansible/playbooks/99-verify.yml" "Managed checker domain is mirrored into sing-box domain rule-set"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/rules"
cat > "$TMPDIR/manual.conf" <<'EOF_MANUAL'
ipset=/ipify.org/STEALTH_DOMAINS
ipset=/unmanaged.example/OTHER_SET
EOF_MANUAL
cat > "$TMPDIR/auto.conf" <<'EOF_AUTO'
ipset=/auto-managed.example/STEALTH_DOMAINS
EOF_AUTO
cat > "$TMPDIR/static.txt" <<'EOF_STATIC'
203.0.113.0/24
EOF_STATIC
cat > "$TMPDIR/stealth.ipset" <<'EOF_IPSET'
create STEALTH_DOMAINS hash:ip family inet hashsize 1024 maxelem 65536
add STEALTH_DOMAINS 198.51.100.10
EOF_IPSET

MANUAL_DNSMASQ="$TMPDIR/manual.conf" \
AUTO_DNSMASQ="$TMPDIR/auto.conf" \
STATIC_NETS="$TMPDIR/static.txt" \
STEALTH_IPSET_SNAPSHOT="$TMPDIR/stealth.ipset" \
SINGBOX_RULE_DIR="$TMPDIR/rules" \
  "${PROJECT_ROOT}/${RULESET_SCRIPT}" --no-restart >/dev/null

assert_generated_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"ipify.org"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"auto-managed.example"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-static.json" '"203.0.113.0/24"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-static.json" '"198.51.100.10/32"'

echo "managed split parity static tests passed"
