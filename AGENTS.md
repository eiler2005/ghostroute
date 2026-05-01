# Agent Instructions

This is the shared instruction file for Codex, Claude Code, and other coding
agents working in GhostRoute. Keep durable project rules here so the agent
briefing does not drift between tools.

## Project Snapshot

GhostRoute is a single-operator routing platform for an ASUS RT-AX88U Pro
running Asuswrt-Merlin. It keeps home LAN/Wi-Fi devices app-free, gives
selected remote clients home-first ingress, and sends only managed destinations
through a VPS Reality/Vision egress.

Core model:
- Router runtime: BusyBox `ash`, `dnsmasq`, `ipset`, `iptables`, `sing-box`,
  and selected Xray/Reality support.
- VPS edge: Caddy layer4 on public TCP/443 in front of Xray/3x-ui Reality, with
  restricted managed DNS where configured.
- Channel A: production automatic router data plane for LAN/Wi-Fi split routing
  and Home Reality clients.
- Channel B: production selected-client home-first lane with its own ingress and
  relay; it must stay isolated from Channel A ownership.
- Channel C: selected-client home-first Naive/HTTPS CONNECT compatibility lane;
  C1-Shadowrocket is live-proven, C1-sing-box native Naive depends on client
  support.
- Legacy WireGuard (`wgs1` + `wgc1`) is disabled in steady state and preserved
  only as an explicit cold fallback.

## Karpathy-Style Agent Workflow

These Karpathy-style rules are here to reduce common LLM coding mistakes:
hidden assumptions, over-engineering, broad diffs, and weak verification.

- Think before coding: state assumptions for non-trivial work, surface real
  ambiguity, and ask only when the repo cannot answer the question. If multiple
  interpretations are plausible, present them instead of silently choosing. If
  a simpler path exists, say so and push back when warranted.
- Read the relevant docs before changing behavior: start with `README.md`,
  `README-ru.md`, `SECURITY.md`, `docs/operational-modules.md`,
  `ansible/README.md`, and the module docs for the area being touched.
- Keep changes simple. Implement the minimum useful change; do not add features,
  flexibility, configurability, abstractions, or error handling that the request
  does not need. If the solution is growing large, simplify before continuing.
- Make surgical edits. Touch only files needed for the request, avoid unrelated
  refactors, and do not improve adjacent code, comments, or formatting just
  because they are nearby.
- Match local style, naming, shell dialect, and documentation tone. Router-side
  scripts must remain compatible with BusyBox `ash` unless a file clearly uses
  Bash.
- Preserve user work. The worktree may contain unrelated local edits; do not
  revert or reformat them.
- Clean up only your own leftovers. Remove imports, variables, functions, or
  docs that your change made obsolete; leave pre-existing dead code alone unless
  the user asked to remove it.
- Work toward verifiable goals. For multi-step tasks, identify the relevant
  checks before or while editing, then run the safe ones before finishing. For
  bug fixes, prefer a reproducing test or fixture before the fix when practical;
  for refactors, preserve behavior and verify before/after expectations.
- Prefer the narrowest check that proves the current change. Do not run broad
  suites such as `./tests/run-all.sh`, full Ansible verification, live reports,
  or long browser/e2e checks unless the user explicitly asks for them or the
  change touches the shared contract they cover. When a broad check would be
  useful but not strictly required, ask first and name the time/risk tradeoff.
- For every significant change, update the relevant docs before recommending or
  making a git commit. If tests exist for the changed behavior, run them first;
  if there are no applicable tests, explicitly say that the change is docs-only
  or has no test coverage and still update any affected README, module doc, ADR,
  runbook, or operator note.
- If you notice unrelated dead code, stale docs, or risky architecture drift,
  mention it instead of silently editing outside the request.

## Safety Rules

- Never run `git commit` or `git push` without explicit user permission.
- Never run `./deploy.sh` without explicit user permission.
- Never deploy to, copy files to, or mutate the router/VPS with `ssh`, `scp`,
  `rsync`, router scripts, or mutating Ansible playbooks without explicit user
  permission.
- Never deploy or recommend deploy until the relevant local tests/checks for the
  change have passed. If tests are unavailable or intentionally skipped, say so
  clearly and get explicit user confirmation before any deploy step.
- Treat Ansible playbooks `00-*`, `10-*`, `11-*`, `20-*`, `21-*`, `22-*`, and
  `30-generate-client-profiles.yml` as mutating or artifact-generating. Run them
  only when the user explicitly authorizes that class of action.
- `ansible/playbooks/99-verify.yml`, `./verify.sh`, health reports, traffic
  reports, syntax checks, fixture tests, and secret scans are read-only/safe
  checks unless the current docs for a command say otherwise.
- Before any broad mutating playbook, confirm deploy-critical Vault values are
  present and prefer read-only verification first.

## Secrets and Privacy

- No sensitive information belongs in git, public docs, commit messages, issue
  text, chat transcripts, or other shareable history. This includes credentials,
  tokens, passwords, usernames, hostnames, public IPs, private IPs, ports, local
  device names, traffic evidence, provider details, and any value that could
  identify or access the real deployment.
- Never commit or paste real endpoints, listener ports, private IP details,
  SSH users, local-only aliases, bypass rules, UUIDs, Reality keys, short IDs,
  admin paths, QR payloads, VLESS URIs, Vault values, or generated client
  profiles.
- Keep real secrets and deployment-specific values in Ansible Vault, the
  appropriate secrets store, or gitignored local files only.
- Generated artifacts under `ansible/out/`, local `reports/`, private docs, and
  domain journals are local/operator data and must stay out of public tracked
  docs unless explicitly sanitized.
- When documentation needs a concrete value to explain a concept, use fake or
  obfuscated examples such as `<router_lan_ip>`, `<home-reality-port>`,
  `<lan-redirect-port>`, `example.invalid`, `198.51.100.10`, or clearly masked
  values like `user-***` and `uuid-...`.
- Run `./modules/secrets-management/bin/secret-scan` only when the user asks
  for a commit/push, when recommending a commit/push, or when a change directly
  touches secrets-sensitive paths or generated artifacts. For ordinary local
  edit/test loops, ask before running it; it is safe but can be noisy and
  expensive in agent context.

## Architecture Invariants

- LAN/Wi-Fi managed TCP matches `STEALTH_DOMAINS` / `VPN_STATIC_NETS`, enters
  NAT `REDIRECT`, then goes through sing-box to Reality/Vision egress.
- LAN/Wi-Fi UDP/443 for managed destinations is dropped to force TCP fallback.
- Router `OUTPUT` uses main routing by default; explicit proxying is for
  router-local diagnostics only.
- Do not reintroduce legacy `VPN_DOMAINS`, `RC_VPN_ROUTE`, `0x1000`, active
  `wgs1`, active `wgc1`, or per-domain WireGuard DNS upstreams as normal
  production state.
- Channel B and Channel C are selected-client lanes, not automatic failover for
  Channel A. They must not take over Channel A REDIRECT, router DNS, TUN, or
  recovery ownership.
- Mobile/home-first managed traffic must apply the same post-router
  `STEALTH_DOMAINS` / `VPN_STATIC_NETS` split as LAN/Wi-Fi.
- `STEALTH_DOMAINS` is the active managed domain catalog; `VPN_STATIC_NETS` is
  the shared static CIDR catalog; `configs/domains-no-vpn.txt` contains
  exceptions.
- Public docs should describe stable behavior, interfaces, and recovery paths.
  Incident snapshots and one-off execution plans should remain local or be
  summarized into stable docs.

## Where Things Live

- Module-owned commands live in `modules/<module>/bin`.
- Router runtime implementations live in `modules/<module>/router`.
- VPS runtime implementations live in `modules/<module>/vps`.
- Shared shell helpers live in `modules/shared/lib`.
- Module-owned deep dives live in `modules/<module>/docs`.
- Root `deploy.sh` and `verify.sh` are platform entrypoints and should remain at
  the repository root.
- The top-level `scripts/` directory is reserved for future cross-repo utilities
  without a clear module owner.
- Ansible deployment and verification live under `ansible/`; generated profile
  output under `ansible/out/` is gitignored local credential material.

## Checks

Prefer the narrowest check that proves the change. Useful safe checks:

```bash
./modules/secrets-management/bin/secret-scan
./tests/run-all.sh
bash -n verify.sh tests/run-all.sh tests/test-module-entrypoints.sh
sh -n modules/routing-core/router/firewall-start modules/routing-core/router/nat-start
```

For Ansible changes, run relevant syntax checks from `ansible/`, for example:

```bash
cd ansible
ansible-playbook --syntax-check playbooks/20-stealth-router.yml
ansible-playbook --syntax-check playbooks/21-channel-b-router.yml
ansible-playbook --syntax-check playbooks/22-channel-c-router.yml
ansible-playbook --syntax-check playbooks/99-verify.yml
```

After documentation changes that touch routing state, run:

```bash
rg '[@]wgc1|[O]UTPUT -j RC_VPN_ROUTE|[P]REROUTING -i br0 -j RC_VPN_ROUTE|server=/.*[@]wgc1' README*.md docs AGENTS.md CLAUDE.md
```

Any remaining matches must be explicitly legacy, retired, rollback-only, or
historical.

Live checks such as `./verify.sh --verbose`,
`./modules/ghostroute-health-monitor/bin/router-health-report`,
`./modules/traffic-observatory/bin/traffic-report today`, and
`cd ansible && ansible-playbook playbooks/99-verify.yml` may require network
access and live targets; run them only when appropriate for the task.

## Docs to Read

- `README.md` and `README-ru.md` for the top-level GhostRoute model.
- `SECURITY.md` for protected assets, secret handling, and recovery boundaries.
- `docs/operational-modules.md` for module ownership and public commands.
- `ansible/README.md` for deployment, Vault, generated profiles, and live
  verification.
- `docs/architecture.md`, `docs/channels.md`, and
  `docs/routing-policy-principles.md` for routing behavior.
- Relevant `modules/<module>/docs/` files before changing a module.
