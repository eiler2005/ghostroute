#!/bin/sh
# Generate sing-box source rule-sets from the same catalogs that populate
# STEALTH_DOMAINS and VPN_STATIC_NETS. Used by mobile Home Reality ingress so
# reality-in follows the same managed-vs-direct split as home LAN traffic.

set -eu

MODE="${1:---no-restart}"
[ "$MODE" = "--no-restart" ] || [ "$MODE" = "--restart-if-changed" ] || {
  echo "Usage: $0 [--no-restart|--restart-if-changed]" >&2
  exit 2
}

SINGBOX_DIR="${SINGBOX_DIR:-/opt/etc/sing-box}"
RULE_DIR="${SINGBOX_RULE_DIR:-${SINGBOX_DIR}/rule-sets}"
DOMAINS_JSON="${SINGBOX_STEALTH_DOMAINS_JSON:-${RULE_DIR}/stealth-domains.json}"
STATIC_JSON="${SINGBOX_STATIC_NETS_JSON:-${RULE_DIR}/stealth-static.json}"
MANUAL_DNSMASQ="${MANUAL_DNSMASQ:-/jffs/configs/dnsmasq-stealth.conf.add}"
AUTO_DNSMASQ="${AUTO_DNSMASQ:-/jffs/configs/dnsmasq-autodiscovered.conf.add}"
STATIC_NETS="${STATIC_NETS:-/jffs/configs/router_configuration.static_nets}"
SINGBOX_BIN="${SINGBOX_BIN:-/opt/bin/sing-box}"
SINGBOX_INIT="${SINGBOX_INIT:-/opt/etc/init.d/S99singbox}"

TMP_PREFIX="/tmp/singbox-rule-sets.$$"
DOMAINS_TXT="${TMP_PREFIX}.domains"
STATIC_TXT="${TMP_PREFIX}.static"
DOMAINS_NEW="${TMP_PREFIX}.domains.json"
STATIC_NEW="${TMP_PREFIX}.static.json"
CHANGED=0

cleanup() {
  rm -f "$DOMAINS_TXT" "$STATIC_TXT" "$DOMAINS_NEW" "$STATIC_NEW"
}
trap cleanup EXIT

mkdir -p "$RULE_DIR"

extract_stealth_domains() {
  awk -v target_set="STEALTH_DOMAINS" '
    /^ipset=\// {
      line = $0
      sub(/[[:space:]]*#.*/, "", line)
      n = split(line, parts, "/")
      if (n < 3) next
      set_name = parts[n]
      if (set_name != target_set) next
      for (i = 2; i < n; i++) {
        domain = parts[i]
        gsub(/^[.]+/, "", domain)
        gsub(/[[:space:]]/, "", domain)
        if (domain != "" && domain !~ /[*]/) {
          print tolower(domain)
        }
      }
    }
  ' "$@" 2>/dev/null | sort -u
}

extract_static_cidrs() {
  awk '
    {
      sub(/[[:space:]]*#.*/, "", $0)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $0)
      if ($0 ~ /^[0-9A-Fa-f:.]+\/[0-9]+$/) print $0
    }
  ' "$@" 2>/dev/null | sort -u
}

write_source_rule_set() {
  input_file="$1"
  output_file="$2"
  field_name="$3"

  {
    printf '{\n'
    printf '  "version": 3,\n'
    if [ -s "$input_file" ]; then
      printf '  "rules": [\n'
      printf '    { "%s": [\n' "$field_name"
      awk '
        {
          gsub(/\\/,"\\\\")
          gsub(/"/,"\\\"")
          printf "%s      \"%s\"", (NR == 1 ? "" : ",\n"), $0
        }
        END { if (NR > 0) printf "\n" }
      ' "$input_file"
      printf '    ] }\n'
      printf '  ]\n'
    else
      printf '  "rules": []\n'
    fi
    printf '}\n'
  } > "$output_file"
}

install_if_changed() {
  new_file="$1"
  target_file="$2"

  if [ ! -f "$target_file" ] || ! cmp -s "$new_file" "$target_file"; then
    cp "$new_file" "$target_file"
    CHANGED=1
  fi
}

extract_stealth_domains "$MANUAL_DNSMASQ" "$AUTO_DNSMASQ" > "$DOMAINS_TXT"
extract_static_cidrs "$STATIC_NETS" > "$STATIC_TXT"

write_source_rule_set "$DOMAINS_TXT" "$DOMAINS_NEW" "domain_suffix"
write_source_rule_set "$STATIC_TXT" "$STATIC_NEW" "ip_cidr"

install_if_changed "$DOMAINS_NEW" "$DOMAINS_JSON"
install_if_changed "$STATIC_NEW" "$STATIC_JSON"

domain_count=$(wc -l < "$DOMAINS_TXT" 2>/dev/null | tr -d ' ')
static_count=$(wc -l < "$STATIC_TXT" 2>/dev/null | tr -d ' ')
domain_count=${domain_count:-0}
static_count=${static_count:-0}

echo "sing-box rule-sets: domains=${domain_count}, static=${static_count}, changed=${CHANGED}"

if [ "$MODE" = "--restart-if-changed" ] && [ "$CHANGED" = "1" ]; then
  "$SINGBOX_BIN" check -C "$SINGBOX_DIR" >/dev/null
  "$SINGBOX_INIT" restart
  echo "sing-box restarted after rule-set update"
fi
