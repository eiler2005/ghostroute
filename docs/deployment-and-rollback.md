# Deployment and Rollback

This is the operator runbook for promoting a change to the live router and
VPS, and for rolling back when something goes wrong. It complements
[`ansible/README.md`](../ansible/README.md) (control-plane mechanics) and
[`SECURITY.md`](../SECURITY.md) §Recovery Boundaries (target times).

## Pre-deploy checklist

Run **all** of these on the control machine before any mutating step. If any
item fails, do not deploy.

1. **Working tree is clean** — no uncommitted changes that should be in the
   release.

   ```bash
   git status
   git log --oneline -5
   ```

2. **Vault values are present** for the playbook you intend to run.

   ```bash
   ansible-vault view ansible/secrets/stealth.yml | head
   ```

3. **Secrets scan is clean.**

   ```bash
   ./modules/secrets-management/bin/secret-scan
   ```

4. **Fixture and shell-syntax tests pass.**

   ```bash
   ./tests/run-fast.sh
   bash -n verify.sh tests/run-all.sh tests/run-fast.sh
   sh -n modules/routing-core/router/firewall-start \
         modules/routing-core/router/nat-start
   ```

5. **Targeted playbook syntax check** (for the specific playbook(s) you'll
   run).

   ```bash
   cd ansible
   ansible-playbook --syntax-check playbooks/20-stealth-router.yml
   ansible-playbook --syntax-check playbooks/21-channel-b-router.yml
   ansible-playbook --syntax-check playbooks/22-channel-c-router.yml
   ansible-playbook --syntax-check playbooks/24-channel-d-router.yml
   ansible-playbook --syntax-check playbooks/99-verify.yml
   ```

6. **Read-only live verification is green.**

   ```bash
   ./verify.sh
   ./modules/ghostroute-health-monitor/bin/router-health-report
   cd ansible && ansible-playbook playbooks/99-verify.yml
   ```

7. **Deploy gate passes** (full A/B/C + DNS + VPS canary).

   ```bash
   ./modules/ghostroute-health-monitor/bin/live-check --active-probe --deploy-gate
   ```

   Normal duration: 40–90 seconds. Bypass (`GHOSTROUTE_SKIP_DEPLOY_GATE=1`) is
   reserved for emergency recovery only.

8. **Safety tag** before any potentially breaking migration:

   ```bash
   git tag pre-<change-name>-$(date +%F)
   git push origin pre-<change-name>-$(date +%F)
   ```

   Example: `pre-channel-b-rotation-2026-05-10`.

## Deploy

Choose the smallest entry point that covers the change. Each step is a
mutation — never run more than one playbook at a time.

```bash
# Router base runtime (no playbook scope) — STEALTH catalog, hooks, LAN policy.
./deploy.sh

# Channel A router data plane.
cd ansible && ansible-playbook playbooks/20-stealth-router.yml

# Channel B selected-client lane (router add-on).
cd ansible && ansible-playbook playbooks/21-channel-b-router.yml

# Channel C selected-client lane (router add-on).
cd ansible && ansible-playbook playbooks/22-channel-c-router.yml

# Channel D experimental router-native NaiveProxy lab (router add-on).
cd ansible && ansible-playbook playbooks/24-channel-d-router.yml

# VPS base runtime.
cd ansible && ansible-playbook playbooks/10-stealth-vps.yml

# Optional VPS direct-mode Channel B.
cd ansible && ansible-playbook playbooks/11-channel-b-vps.yml

# Client profile generation (Vault → ansible/out/).
cd ansible && ansible-playbook playbooks/30-generate-client-profiles.yml
```

## Post-deploy verification

Run within 5 minutes of the deploy completing.

```bash
./verify.sh --verbose
cd ansible && ansible-playbook playbooks/99-verify.yml
cd ..
./modules/ghostroute-health-monitor/bin/router-health-report
./modules/traffic-observatory/bin/traffic-report check
./modules/traffic-observatory/bin/traffic-report today
```

For router runtime hardening changes, include a reboot gate before treating the
deploy as complete. After the router comes back, run `live-check --deploy-gate`
before `99-verify.yml`; this proves the boot supervisor restored LAN REDIRECT
and managed UDP/443 DROP rules without relying on the verify playbook to reapply
`stealth-route-init.sh`. Then run router-only `99-verify.yml` and the health
report for the full assertion set.

Expected invariants:

- `STEALTH_DOMAINS` and `VPN_STATIC_NETS` exist and are non-empty.
- `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000` (outside fallback), active `wgs1`,
  active `wgc1` are absent.
- Channel A REDIRECT listener responds, home Reality listener responds,
  managed split is OK.
- If Channel B/C/D was changed: their ingress responds and the managed split
  through them is OK. Channel D proof must use `channel-d-naiveproxy-socks-in`,
  not Channel C `channel-c-naive-in`.
- `traffic-report check` reports no new "routing mistake" findings.

## Rollback triggers

Roll back immediately if any of these are true after deploy:

- `verify.sh` reports drift on Channel A REDIRECT, home Reality listener, or
  managed split.
- `99-verify.yml` returns non-zero or any module reports `failed > 0`.
- `traffic-report check` shows a "routing mistake" delta vs the previous
  window.
- DNS leaks observed on a known-good test client (BrowserLeaks, mobile
  carrier resolver visible).
- Reality handshake fails on a remote QR client that worked before the
  change.
- Channel B/C/D ingress no longer responds, or starts capturing Channel A
  state (REDIRECT, DNS, TUN, recovery).

## Per-component rollback

Pick the narrowest path that recovers the regressed surface.

### Router data plane (Channel A)

1. `git checkout <pre-tag>` on the control machine.
2. `cd ansible && ansible-playbook playbooks/20-stealth-router.yml` to
   re-apply the prior router configuration.
3. `./verify.sh --verbose` to confirm invariants.
4. Capture evidence under `reports/` for postmortem.

### Channel B / Channel C / Channel D

1. `git checkout <pre-tag>` (or revert the offending commit).
2. Re-run only the affected playbook (`21-channel-b-router.yml` or
   `22-channel-c-router.yml`, or `24-channel-d-router.yml`).
3. Confirm Channel A is **untouched** with `./verify.sh --verbose` and
   `traffic-report check`.

For Channel D removal, set `vault_channel_d_naiveproxy_enabled=false` and rerun
`24-channel-d-router.yml`. Confirm the Caddy service is stopped, the
legacy Channel D `services-start` bootstrap block is absent while the
`GhostRouteRuntimeSupervisor` block remains, D firewall rules are absent, and
A/B/C verification still passes.

### VPS edge

1. Confirm the regression is on the VPS (Caddy / Xray / Reality), not the
   router.
2. `git checkout <pre-tag>` and re-run `10-stealth-vps.yml` (or
   `11-channel-b-vps.yml` if direct-mode B was the change).
3. Verify `99-verify.yml` `stealth-vps` block is `failed=0`.

### DNS policy

1. Roll back changes to `configs/dnsmasq-stealth.conf.add`,
   `configs/static-networks.txt`, or DNS-related Ansible templates.
2. `./deploy.sh` (router base runtime carries the catalogs).
3. `traffic-report check` and a manual BrowserLeaks pass on a test client.

### GhostRoute Console (read-only surface)

The Console is a read-only consumer; rolling it back never affects routing.

1. `cd modules/ghostroute-console/vps` and re-run
   `deploy-readonly.yml` against the previous image tag.
2. If DB corruption is suspected, quarantine `data/ghostroute.db*` and let
   the collector re-populate from upstream snapshots.

### Cold fallback (catastrophic Reality outage)

Use only when the rollback paths above cannot recover routing within the
target time. Single sanctioned entry point:

```bash
ssh admin@<router_lan_ip> '/jffs/scripts/emergency-enable-wgc1.sh --dry-run'
# ...inspect plan...
ssh admin@<router_lan_ip> '/jffs/scripts/emergency-enable-wgc1.sh --enable'
```

After Reality is restored:

```bash
ssh admin@<router_lan_ip> '/jffs/scripts/emergency-enable-wgc1.sh --disable'
./verify.sh --verbose
```

The full procedure is in
[`modules/recovery-verification/docs/failure-modes.md`](../modules/recovery-verification/docs/failure-modes.md).

## After a rollback

1. File a short note under `reports/` describing what regressed, what
   rolled it back, and the residual exposure window.
2. Update [`docs/troubleshooting.md`](troubleshooting.md) if the symptom
   was new.
3. If the regression had a stable reproducer, add a fixture test to
   `tests/` so CI catches it next time.
4. Decide whether the underlying change should be retried with a smaller
   blast radius or abandoned.

## Hard rules

- Never run `./deploy.sh` or any mutating playbook without explicit operator
  authorization. AI agents must ask first.
- Never disable the deploy gate without an explicit emergency reason and a
  recovery plan written down.
- Never rewrite git history on safety tags.
- Never silently mask a regression with cold fallback. Cold fallback exists
  to buy recovery time, not to hide drift.
