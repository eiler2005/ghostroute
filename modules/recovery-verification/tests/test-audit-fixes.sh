#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

"${PROJECT_ROOT}/modules/recovery-verification/bin/audit-fixes" >/tmp/ghostroute-audit-fixes-pass.txt

fixture="${TMPDIR}/repo"
mkdir -p "${fixture}/ansible/roles/stealth_routing/templates"
mkdir -p "${fixture}/ansible/playbooks"
mkdir -p "${fixture}/modules/recovery-verification/bin"
mkdir -p "${fixture}/modules/shared/lib"
mkdir -p "${fixture}/modules/ghostroute-health-monitor/router"
mkdir -p "${fixture}/modules/ghostroute-health-monitor/bin"
mkdir -p "${fixture}/modules/traffic-observatory/bin"
mkdir -p "${fixture}/modules/dns-catalog-intelligence/bin"
mkdir -p "${fixture}/modules/client-profile-factory/bin"
mkdir -p "${fixture}/modules/secrets-management/bin"
mkdir -p "${fixture}/ansible/roles/example/defaults"
mkdir -p "${fixture}/ansible/roles/example/meta"
mkdir -p "${fixture}/scripts" "${fixture}/docs/adr" "${fixture}/tests"

cat >"${fixture}/scripts/README.md" <<'EOF'
scripts policy
EOF
cat >"${fixture}/README.md" <<'EOF'
module native
EOF
cat >"${fixture}/README-ru.md" <<'EOF'
module native
EOF
cat >"${fixture}/docs/adr/0004-channel-a-cold-fallback.md" <<'EOF'
Channel A cold fallback
EOF
cat >"${fixture}/ansible/roles/example/defaults/main.yml" <<'EOF'
---
EOF
cat >"${fixture}/ansible/roles/example/meta/main.yml" <<'EOF'
---
EOF
cat >"${fixture}/ansible/roles/stealth_routing/templates/stealth-route-init.sh.j2" <<'EOF'
iptables -I FORWARD 1 -i br0 -p udp --dport 443 -m set --match-set "$IPSET" dst -j DROP
EOF
cat >"${fixture}/ansible/playbooks/99-verify.yml" <<'EOF'
dport 443 match-set anything DROP
EOF
cat >"${fixture}/modules/recovery-verification/bin/verify.sh" <<'EOF'
CHANNEL_B_DROP_QUIC_STEALTH
Channel A RC_VPN_ROUTE RULE_MARK_0X1000
EOF
cat >"${fixture}/modules/shared/lib/router-health-common.sh" <<'EOF'
CHANNEL_B_DROP_QUIC_STATIC
EOF
cat >"${fixture}/modules/ghostroute-health-monitor/router/run-probes" <<'EOF'
channel_a_resurrection
EOF

for path in \
  modules/traffic-observatory/bin/traffic-report \
  modules/ghostroute-health-monitor/bin/router-health-report \
  modules/ghostroute-health-monitor/bin/ghostroute-health-report \
  modules/dns-catalog-intelligence/bin/catalog-review-report \
  modules/dns-catalog-intelligence/bin/dns-forensics-report \
  modules/dns-catalog-intelligence/bin/domain-report \
  modules/client-profile-factory/bin/client-profiles \
  modules/secrets-management/bin/secret-scan \
  modules/recovery-verification/bin/verify.sh
do
  touch "${fixture}/${path}"
  chmod +x "${fixture}/${path}"
done

if GHOSTROUTE_AUDIT_ROOT="${fixture}" GHOSTROUTE_AUDIT_SKIP_SECRET_SCAN=1 \
  "${PROJECT_ROOT}/modules/recovery-verification/bin/audit-fixes" >/tmp/ghostroute-audit-fixes-bad.txt 2>&1; then
  echo "audit-fixes should fail when static UDP/443 DROP invariant is incomplete" >&2
  exit 1
fi

if ! rg -q 'routing template installs UDP/443 DROP for VPN_STATIC_NETS' /tmp/ghostroute-audit-fixes-bad.txt; then
  cat /tmp/ghostroute-audit-fixes-bad.txt >&2
  echo "audit-fixes failure did not mention missing static UDP/443 DROP invariant" >&2
  exit 1
fi

echo "audit-fixes tests passed"
