# Claude Code Instructions and rules for working in this project

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

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
**VPN:** WireGuard WGC1  
**Pipeline:** dnsmasq → ipset (VPN_DOMAINS / VPN_STATIC_NETS) → iptables fwmark 0x1000 → ip rule → wgc1

### Key Files

| File | Purpose |
|---|---|
| `configs/dnsmasq.conf.add` | Manual ipset rules (deployed to the router) |
| `configs/dnsmasq-vpn-upstream.conf.add` | DNS upstream via VPN for each domain |
| `configs/static-networks.txt` | Static CIDR subnets (Telegram, Apple) |
| `configs/domains-no-vpn.txt` | Exceptions — domains that do not need VPN |
| `scripts/domain-auto-add.sh` | Auto-discovery: cron runs every hour on the router |
| `scripts/domain-report` | Report on auto-added domains (run from Mac) |
| `docs/vpn-domain-journal.md` | Local domain journal (in `.gitignore`, do not push) |

### Domain Addition Workflow

1. Add `ipset=/<domain>/VPN_DOMAINS` to `configs/dnsmasq.conf.add`
2. Add `server=/<domain>/1.1.1.1@wgc1` + `server=/<domain>/9.9.9.9@wgc1` to `configs/dnsmasq-vpn-upstream.conf.add`
3. Get permission → `./deploy.sh`
4. Update `docs/vpn-domain-journal.md`