#!/bin/sh
# Emergency cold fallback for retired WireGuard.
#
# Default mode is --dry-run. Only --enable creates WireGuard traffic.
# The script keeps normal Channel A REDIRECT rules in place, but marks selected LAN
# traffic and bypasses the REDIRECT rules so wgc1 can carry it.

set -eu

MODE="${1:---dry-run}"
MARK="0x1000/0x1000"
RULE_PRIO="9900"
TABLE="wgc1"
STEALTH_SET="STEALTH_DOMAINS"
STATIC_SET="VPN_STATIC_NETS"

usage() {
  echo "Usage: $0 [--dry-run|--enable|--disable]" >&2
  exit 2
}

[ "$MODE" = "--dry-run" ] || [ "$MODE" = "--enable" ] || [ "$MODE" = "--disable" ] || usage

is_dry_run() {
  [ "$MODE" = "--dry-run" ]
}

run() {
  if is_dry_run; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

ensure_rule() {
  table="$1"
  chain="$2"
  shift 2

  if ! iptables -t "$table" -C "$chain" "$@" 2>/dev/null; then
    run iptables -t "$table" -I "$chain" 1 "$@"
  fi
}

delete_rule_loop() {
  table="$1"
  chain="$2"
  shift 2

  while iptables -t "$table" -C "$chain" "$@" 2>/dev/null; do
    run iptables -t "$table" -D "$chain" "$@"
  done
}

check_preserved_nvram() {
  missing=""
  for field in wgc1_priv wgc1_addr wgc1_aips wgc1_ep_addr wgc1_ep_port wgc1_ppub wgc1_dns wgc1_mtu wgc1_alive; do
    value="$(nvram get "$field" 2>/dev/null || true)"
    [ -n "$value" ] || missing="${missing}${field} "
  done

  if [ -n "$missing" ]; then
    echo "Missing required cold-fallback NVRAM fields: $missing" >&2
    exit 1
  fi
}

enable_fallback() {
  check_preserved_nvram

  echo "Enabling emergency wgc1 fallback for STEALTH_DOMAINS and VPN_STATIC_NETS"
  run nvram set wgc1_enable=1
  run nvram commit
  run service restart_wgc

  if ! ip rule show 2>/dev/null | grep -q "fwmark 0x1000/0x1000 lookup ${TABLE}"; then
    run ip rule add fwmark "$MARK" table "$TABLE" prio "$RULE_PRIO"
  fi

  ensure_rule mangle PREROUTING -i br0 -m set --match-set "$STEALTH_SET" dst -j MARK --set-mark "$MARK"
  ensure_rule mangle PREROUTING -i br0 -m set --match-set "$STATIC_SET" dst -j MARK --set-mark "$MARK"

  ensure_rule nat PREROUTING -i br0 -m mark --mark "$MARK" -j ACCEPT
  ensure_rule filter FORWARD -i br0 -m mark --mark "$MARK" -j ACCEPT

  echo "Emergency fallback is ready. Disable it with: $0 --disable"
}

disable_fallback() {
  echo "Disabling emergency wgc1 fallback and restoring Reality-only steady state"

  delete_rule_loop filter FORWARD -i br0 -m mark --mark "$MARK" -j ACCEPT
  delete_rule_loop nat PREROUTING -i br0 -m mark --mark "$MARK" -j ACCEPT
  delete_rule_loop mangle PREROUTING -i br0 -m set --match-set "$STATIC_SET" dst -j MARK --set-mark "$MARK"
  delete_rule_loop mangle PREROUTING -i br0 -m set --match-set "$STEALTH_SET" dst -j MARK --set-mark "$MARK"

  while ip rule show 2>/dev/null | grep -q "fwmark 0x1000/0x1000 lookup ${TABLE}"; do
    run ip rule del fwmark "$MARK" table "$TABLE" 2>/dev/null || break
  done

  run nvram set wgc1_enable=0
  run nvram commit
  run service restart_wgc
  echo "Emergency fallback disabled."
}

case "$MODE" in
  --dry-run)
    check_preserved_nvram
    echo "Dry-run only. Planned --enable actions:"
    enable_fallback
    ;;
  --enable)
    enable_fallback
    ;;
  --disable)
    disable_fallback
    ;;
esac
