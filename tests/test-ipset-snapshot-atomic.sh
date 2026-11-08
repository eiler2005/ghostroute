#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT
mkdir -p "$FIXTURE_DIR/bin" "$FIXTURE_DIR/state"

sed \
  -e "s|^STATE_DIR=\"/jffs/addons/router_configuration\"$|STATE_DIR=\"$FIXTURE_DIR/state\"|" \
  -e '/^\[ -x \/opt\/bin\/opkg \] && STATE_DIR=/d' \
  "$PROJECT_ROOT/modules/routing-core/router/cron-save-ipset" > "$FIXTURE_DIR/cron-save-ipset"

cat > "$FIXTURE_DIR/bin/ipset" <<'MOCK'
#!/bin/sh
case "$1:$MOCK_IPSET_MODE" in
  list:missing) exit 1 ;;
  list:*) printf 'Number of entries: 1\n'; exit 0 ;;
  save:failed) printf 'create STEALTH_DOMAINS hash:ip family inet\n'; exit 2 ;;
  save:malformed) printf 'incomplete snapshot\n'; exit 0 ;;
  save:header_only) printf 'create STEALTH_DOMAINS hash:ip family inet\n'; exit 0 ;;
  save:valid)
    printf 'create STEALTH_DOMAINS hash:ip family inet\n'
    printf 'add STEALTH_DOMAINS 198.51.100.10\n'
    exit 0 ;;
esac
exit 99
MOCK
chmod +x "$FIXTURE_DIR/bin/ipset"

STATE_FILE="$FIXTURE_DIR/state/STEALTH_DOMAINS.ipset"
printf 'previous snapshot\n' > "$STATE_FILE"
export PATH="$FIXTURE_DIR/bin:$PATH"

for mode in missing failed malformed header_only; do
  if MOCK_IPSET_MODE="$mode" sh "$FIXTURE_DIR/cron-save-ipset" && [ "$mode" != missing ]; then
    echo "invalid $mode snapshot was accepted" >&2
    exit 1
  fi
  [ "$(cat "$STATE_FILE")" = 'previous snapshot' ]
  ! compgen -G "$STATE_FILE.tmp.*" >/dev/null
done

MOCK_IPSET_MODE=valid sh "$FIXTURE_DIR/cron-save-ipset"
grep -q '^create STEALTH_DOMAINS hash:ip family inet$' "$STATE_FILE"
grep -q '^add STEALTH_DOMAINS 198.51.100.10$' "$STATE_FILE"
! compgen -G "$STATE_FILE.tmp.*" >/dev/null
echo 'atomic ipset snapshot: missing, failed, malformed, short and valid saves passed'
