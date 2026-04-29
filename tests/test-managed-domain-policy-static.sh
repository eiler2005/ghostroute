#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

assert_contains_fixed() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain text: ${needle}" >&2
    exit 1
  fi
}

assert_contains_regex() {
  local path="$1"
  local pattern="$2"
  if ! rg -n -- "$pattern" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} to contain pattern: ${pattern}" >&2
    exit 1
  fi
}

assert_file_contains_fixed() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "$path" >/dev/null; then
    echo "Expected ${path} to contain text: ${needle}" >&2
    cat "$path" >&2
    exit 1
  fi
}

assert_not_contains_fixed() {
  local path="$1"
  local needle="$2"
  if rg -n -F -- "$needle" "${PROJECT_ROOT}/${path}" >/dev/null; then
    echo "Expected ${path} not to contain text: ${needle}" >&2
    exit 1
  fi
}

assert_file_not_contains_fixed() {
  local path="$1"
  local needle="$2"
  if rg -n -F -- "$needle" "$path" >/dev/null; then
    echo "Expected ${path} not to contain text: ${needle}" >&2
    cat "$path" >&2
    exit 1
  fi
}

assert_generated_contains_fixed() {
  local path="$1"
  local needle="$2"
  if ! rg -n -F -- "$needle" "$path" >/dev/null; then
    echo "Expected generated ${path} to contain text: ${needle}" >&2
    sed -n '1,200p' "$path" >&2 || true
    exit 1
  fi
}

assert_generated_not_contains_fixed() {
  local path="$1"
  local needle="$2"
  if rg -n -F -- "$needle" "$path" >/dev/null; then
    echo "Expected generated ${path} not to contain text: ${needle}" >&2
    sed -n '1,200p' "$path" >&2 || true
    exit 1
  fi
}

DNSMASQ_CATALOG="configs/dnsmasq-stealth.conf.add"
STATIC_CATALOG="configs/static-networks.txt"
NO_VPN_CATALOG="configs/domains-no-vpn.txt"
STEALTH_TASKS="ansible/roles/stealth_routing/tasks/main.yml"
FIREWALL_START="modules/routing-core/router/firewall-start"
RULESET_SCRIPT="modules/routing-core/router/update-singbox-rule-sets.sh"
AUTO_ADD_SCRIPT="modules/dns-catalog-intelligence/router/domain-auto-add.sh"

# Manual managed-domain catalog: representative families that must affect both
# LAN/Wi-Fi dnsmasq ipsets and mobile sing-box rule-sets after deploy.
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/telegram.org/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/t.me/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/whatsapp.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/imo.im/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/openai.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/discord.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/canva.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/notion.so/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/rutracker.org/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/browserleaks.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/browserleaks.net/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/browserleaks.org/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/meduza.io/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/account.apple.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/idmsa.apple.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/icloud.com.cn/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/apzones.com/STEALTH_DOMAINS"
assert_contains_fixed "$DNSMASQ_CATALOG" "ipset=/doh.dns.apple.com/STEALTH_DOMAINS"

# Static direct-IP catalog: this is still managed traffic. It covers services
# that can connect by IP before a DNS-populated ipset entry exists.
assert_contains_regex "$STATIC_CATALOG" '^17[.]0[.]0[.]0/8'
assert_contains_regex "$STATIC_CATALOG" '^31[.]13[.]64[.]0/18'
assert_contains_regex "$STATIC_CATALOG" '^91[.]108[.]4[.]0/22'
assert_contains_regex "$STATIC_CATALOG" '^149[.]154[.]160[.]0/20'
assert_contains_regex "$STATIC_CATALOG" '^5[.]150[.]156[.]0/22'

# Direct/skip policy: these are not managed-route additions. Russian TLDs are
# skipped by code; sensitive non-RU services can be listed explicitly.
assert_contains_fixed "$NO_VPN_CATALOG" "championat.com"
assert_contains_fixed "$NO_VPN_CATALOG" "vtb.ru"
assert_not_contains_fixed "$NO_VPN_CATALOG" "meduza.io"
assert_contains_fixed "$AUTO_ADD_SCRIPT" 'RU_TLDS="\.ru$|\.su$|\.xn--p1ai$|\.xn--80adxhks$|\.xn--d1acj3b$|\.xn--p1acf$|\.tatar$|\.moscow$"'
assert_contains_fixed "$AUTO_ADD_SCRIPT" 'is_domain_covered_by_lists "$domain" "$NO_VPN_DOMAINS"'
assert_contains_fixed "$AUTO_ADD_SCRIPT" 'update-singbox-rule-sets.sh --restart-if-changed'

# Deploy must install all policy sources, including private/local extensions.
assert_contains_fixed "$STEALTH_TASKS" "configs/dnsmasq-stealth.conf.add"
assert_contains_fixed "$STEALTH_TASKS" "configs/private/dnsmasq-stealth.local.conf.add"
assert_contains_fixed "$STEALTH_TASKS" "configs/static-networks.txt"
assert_contains_fixed "$STEALTH_TASKS" "configs/no-vpn-ip-ports.txt"
assert_contains_fixed "$STEALTH_TASKS" "secrets/no-vpn-ip-ports.local.txt"
assert_contains_fixed "$STEALTH_TASKS" "configs/domains-no-vpn.txt"

# LAN/Wi-Fi must populate both ipsets from those sources.
assert_contains_fixed "$FIREWALL_START" "ipset create STEALTH_DOMAINS hash:ip"
assert_contains_fixed "$FIREWALL_START" "ipset create VPN_STATIC_NETS hash:net"
assert_contains_fixed "$FIREWALL_START" 'sed -e '\''s/#.*$//'\'' -e '\''/^[[:space:]]*$/d'\'' "$STATIC_NETWORKS_FILE"'
assert_contains_fixed "$FIREWALL_START" 'ipset add VPN_STATIC_NETS "$network"'

# Mobile selected-client paths consume the same policy through generated
# sing-box source rule-sets.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/rules" "$TMPDIR/fakebin" "$TMPDIR/forensics"

cat > "$TMPDIR/manual.conf" <<'EOF_MANUAL'
ipset=/telegram.org/STEALTH_DOMAINS
ipset=/t.me/STEALTH_DOMAINS
ipset=/openai.com/STEALTH_DOMAINS
ipset=/ignored.example/OTHER_SET
EOF_MANUAL
cat > "$TMPDIR/auto.conf" <<'EOF_AUTO'
ipset=/auto-managed.example/STEALTH_DOMAINS
EOF_AUTO
cat > "$TMPDIR/static.txt" <<'EOF_STATIC'
198.51.100.0/24
203.0.113.0/24
EOF_STATIC
cat > "$TMPDIR/stealth.ipset" <<'EOF_IPSET'
create STEALTH_DOMAINS hash:ip family inet hashsize 1024 maxelem 65536
add STEALTH_DOMAINS 198.51.100.20
EOF_IPSET

MANUAL_DNSMASQ="$TMPDIR/manual.conf" \
AUTO_DNSMASQ="$TMPDIR/auto.conf" \
STATIC_NETS="$TMPDIR/static.txt" \
STEALTH_IPSET_SNAPSHOT="$TMPDIR/stealth.ipset" \
SINGBOX_RULE_DIR="$TMPDIR/rules" \
DNSMASQ_VPS_DNS_CONF="$TMPDIR/managed-vps-dns.conf" \
  "${PROJECT_ROOT}/${RULESET_SCRIPT}" --no-restart >/dev/null

assert_generated_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"telegram.org"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"t.me"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"openai.com"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"auto-managed.example"'
assert_generated_not_contains_fixed "$TMPDIR/rules/stealth-domains.json" '"ignored.example"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-static.json" '"198.51.100.0/24"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-static.json" '"203.0.113.0/24"'
assert_generated_contains_fixed "$TMPDIR/rules/stealth-static.json" '"198.51.100.20/32"'

# Auto-discovery policy: blocked/confirmed foreign domains can become managed;
# Russian TLDs, domains-no-vpn entries, and already-covered manual/auto domains
# must not be added. This mirrors what Wi-Fi/LAN will later see in dnsmasq and
# what mobile channels receive after update-singbox-rule-sets refreshes.
cat > "$TMPDIR/fakebin/service" <<'EOF_SERVICE'
#!/bin/sh
exit 0
EOF_SERVICE
cat > "$TMPDIR/fakebin/logger" <<'EOF_LOGGER'
#!/bin/sh
exit 0
EOF_LOGGER
cat > "$TMPDIR/fakebin/curl" <<'EOF_CURL'
#!/bin/sh
printf '200'
exit 0
EOF_CURL
chmod +x "$TMPDIR/fakebin/service" "$TMPDIR/fakebin/logger" "$TMPDIR/fakebin/curl"

cat > "$TMPDIR/dnsmasq.log" <<'EOF_LOG'
Apr 29 10:00:00 dnsmasq[100]: query[A] blocked.example from 192.168.50.10
Apr 29 10:00:01 dnsmasq[100]: query[A] api.telegram.org from 192.168.50.10
Apr 29 10:00:02 dnsmasq[100]: query[A] mobile-bank.ru from 192.168.50.10
Apr 29 10:00:03 dnsmasq[100]: query[A] championat.com from 192.168.50.10
Apr 29 10:00:04 dnsmasq[100]: query[A] api.existing-auto.example from 192.168.50.10
EOF_LOG
cat > "$TMPDIR/auto-runtime.conf" <<'EOF_AUTO_RUNTIME'
ipset=/existing-auto.example/STEALTH_DOMAINS
EOF_AUTO_RUNTIME
cat > "$TMPDIR/no-vpn.txt" <<'EOF_NO_VPN'
championat.com
vtb.ru
EOF_NO_VPN
cat > "$TMPDIR/blocked-list.txt" <<'EOF_BLOCKED'
blocked.example
EOF_BLOCKED

PATH="$TMPDIR/fakebin:$PATH" \
DOMAIN_AUTO_ADD_LOG_FILE="$TMPDIR/dnsmasq.log" \
DOMAIN_AUTO_ADD_ACTIVITY_LOG_FILE="$TMPDIR/activity.log" \
DOMAIN_AUTO_ADD_MANAGED_FILE="$TMPDIR/manual.conf" \
DOMAIN_AUTO_ADD_AUTO_FILE="$TMPDIR/auto-runtime.conf" \
DOMAIN_AUTO_ADD_NO_VPN_FILE="$TMPDIR/no-vpn.txt" \
DOMAIN_AUTO_ADD_BLOCKED_LIST_FILE="$TMPDIR/blocked-list.txt" \
DOMAIN_AUTO_ADD_LEASES_FILE="$TMPDIR/leases.txt" \
DOMAIN_AUTO_ADD_FORENSICS_DIR="$TMPDIR/forensics" \
CANDIDATE_EVENTS_STATE="$TMPDIR/candidate-events.tsv" \
PROBE_HISTORY_STATE="$TMPDIR/probe-history.tsv" \
  sh "${PROJECT_ROOT}/${AUTO_ADD_SCRIPT}" >/dev/null

assert_file_contains_fixed "$TMPDIR/auto-runtime.conf" "ipset=/blocked.example/STEALTH_DOMAINS"
assert_file_contains_fixed "$TMPDIR/auto-runtime.conf" "ipset=/existing-auto.example/STEALTH_DOMAINS"
assert_file_not_contains_fixed "$TMPDIR/auto-runtime.conf" "telegram.org"
assert_file_not_contains_fixed "$TMPDIR/auto-runtime.conf" "mobile-bank.ru"
assert_file_not_contains_fixed "$TMPDIR/auto-runtime.conf" "championat.com"

echo "managed domain policy static tests passed"
