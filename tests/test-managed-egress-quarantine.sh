#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
mkdir -p "$TMPDIR/bin"
cat > "$TMPDIR/bin/ansible-vault" <<'MOCK'
#!/bin/sh
[ "$1" = view ] || exit 99
printf '%s\n' 'vault_router_managed_egress_mode: hermes_vps' 'vault_channel_d_managed_egress_mode: follow' 'vault_router_sensitive_sites_enabled: true'
MOCK
chmod +x "$TMPDIR/bin/ansible-vault"
export PATH="$TMPDIR/bin:$PATH"
helper="${PROJECT_ROOT}/modules/routing-core/bin/managed-egress-mode"
for channel in abc d; do
  if bash "$helper" set backup_reality --channel "$channel" > "$TMPDIR/result" 2>&1; then
    echo "quarantined backend selected for $channel" >&2
    exit 1
  fi
  rg -q 'backup_reality is quarantined' "$TMPDIR/result"
done
bash "$helper" set hermes_vps > "$TMPDIR/result"
rg -q 'already hermes_vps' "$TMPDIR/result"
bash "$helper" status > "$TMPDIR/status"
rg -q '^quarantined backend: backup_reality ' "$TMPDIR/status"
rg -q '^available A/B/C modes: primary_vps hermes_vps$' "$TMPDIR/status"
rg -q '^available Channel D modes: follow primary_vps hermes_vps$' "$TMPDIR/status"
echo "managed egress quarantine: both lanes reject quarantine, healthy selection and status pass"
