#!/bin/sh
set -eu

BACKUP_DIR="${GHOSTROUTE_LAST_GOOD_DIR:-/jffs/backups/ghostroute-last-good}"
BUNDLE="${1:-}"

if [ -z "$BUNDLE" ]; then
  BUNDLE="$(ls -t "$BACKUP_DIR"/router-runtime-*.tgz 2>/dev/null | head -1 || true)"
fi

if [ -z "$BUNDLE" ] || [ ! -f "$BUNDLE" ]; then
  echo "No last-good router runtime bundle found under $BACKUP_DIR" >&2
  exit 1
fi

case "$BUNDLE" in
  "$BACKUP_DIR"/router-runtime-*.tgz) ;;
  *)
    echo "Refusing to restore unexpected bundle path: $BUNDLE" >&2
    exit 1
    ;;
esac

echo "Restoring GhostRoute router runtime from $BUNDLE"
tar -xzf "$BUNDLE" -C /

if [ -x /opt/etc/init.d/S99sing-box ]; then
  /opt/etc/init.d/S99sing-box restart || true
elif [ -x /opt/etc/init.d/S99singbox ]; then
  /opt/etc/init.d/S99singbox restart || true
fi

[ -x /jffs/scripts/nat-start ] && sh /jffs/scripts/nat-start || true
[ -x /jffs/scripts/firewall-start ] && sh /jffs/scripts/firewall-start || true
service restart_dnsmasq || true

echo "Restore complete. Run live-check --active-probe --deploy-gate before deploying again."
