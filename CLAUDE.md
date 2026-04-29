# Claude Code Instructions and rules for working in this project

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.
Adapted from `forrestchang/andrej-karpathy-skills`:
https://github.com/forrestchang/andrej-karpathy-skills

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Mandatory Restrictions

### Git push
**Never run `git push` without the user's explicit permission.**

It is allowed to do local actions: `git add`, `git commit`.
Pushing is allowed only after phrases like “do push”, “push it”, “push”, etc.

### Router deployment
**Never run `./deploy.sh` or copy files to the router (scp/ssh) without the user's explicit permission.**

It is allowed to prepare configs and edit files locally.
Deploying is allowed only after an explicit command.

---

## Project Context

**Router:** ASUS RT-AX88U Pro, Asuswrt-Merlin, BusyBox ash, aarch64
**Primary LAN egress:** Channel B (`sing-box REDIRECT` → VLESS+Reality → VPS)
**Primary mobile ingress:** home Reality QR (`iPhone/Mac -> ASUS :<home-reality-port> -> sing-box home-reality-in -> Reality outbound -> VPS)
**Cold fallback:** preserved `wgc1_*` NVRAM via `scripts/emergency-enable-wgc1.sh`; disabled in steady state

Current routing matrix:
- `br0` LAN/Wi-Fi TCP → `STEALTH_DOMAINS` / `VPN_STATIC_NETS` → nat `REDIRECT` → sing-box → Reality
- `br0` LAN/Wi-Fi UDP/443 → `STEALTH_DOMAINS` / `VPN_STATIC_NETS` → DROP, forcing client fallback to TCP
- `iphone-*` / `macbook` QR profiles → home public IP `:<home-reality-port>` → router-side Reality inbound → same Reality outbound to VPS
- router `OUTPUT` → main routing by default; use explicit proxy only for router-local diagnostics
- Channel A (`wgs1` + `wgc1`) → disabled; emergency-only

Stealth channel B is implemented in `ansible/` as an Ansible-driven path:
- VPS: Caddy L4 on `:443` → Xray/3x-ui Reality inbound on `127.0.0.1:<xray-local-port>`
- Router: sing-box REDIRECT inbound on `0.0.0.0:<lan-redirect-port>`, home Reality inbound on `0.0.0.0:<home-reality-port>`, `STEALTH_DOMAINS` ipset, QUIC fallback rules
- WGC1 is not active; NVRAM is preserved for cold fallback

### Key Files

| File | Purpose |
|---|---|
| `configs/dnsmasq-stealth.conf.add` | Manual rules for `STEALTH_DOMAINS` (LAN → REDIRECT/Reality) |
| `configs/static-networks.txt` | Static CIDR subnets for Channel B |
| `configs/domains-no-vpn.txt` | Exceptions — domains that do not need VPN |
| `ansible/playbooks/10-stealth-vps.yml` | Deploy Caddy L4 + Xray/Reality on VPS |
| `ansible/playbooks/20-stealth-router.yml` | Deploy sing-box + stealth routing on router |
| `ansible/playbooks/30-generate-client-profiles.yml` | Generate router direct-to-VPS profile plus mobile home-ingress QR profiles |
| `ansible/playbooks/99-verify.yml` | Verify channel B on VPS and router |
| `ansible/secrets/stealth.yml.example` | Fill-in template for vault secrets |
| `docs/stealth-channel-implementation-guide.md` | Architecture and rollout guide for the stealth channel |
| `scripts/domain-auto-add.sh` | Auto-discovery: cron runs every hour on the router |
| `scripts/domain-report` | Report on auto-added domains (run from Mac) |
| `docs/vpn-domain-journal.md` | Local domain journal (in `.gitignore`, do not push) |

### Domain Addition Workflow

1. Add `ipset=/<domain>/STEALTH_DOMAINS` to `configs/dnsmasq-stealth.conf.add`
2. Do not add `VPN_DOMAINS` or `server=/...@wgc1` rules; DNS goes through dnscrypt-proxy on `127.0.0.1:<dnscrypt-port>`
3. Get permission → `ROUTER=192.168.50.1 ./deploy.sh`
4. Re-apply stealth router role: `cd ansible && ansible-playbook playbooks/20-stealth-router.yml`
5. Verify: `ansible-playbook playbooks/99-verify.yml`
