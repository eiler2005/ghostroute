# Architecture Review — router_configuration

**Date:** 2026-04-26
**Reviewer perspective:** senior infrastructure engineer / staff-level architect
   evaluating the repo as if it were a candidate's portfolio submission for a
   senior infrastructure / SRE role.
**Audience for this document:** future LLM agent or engineer implementing the
   prioritized change plan in §6. **No coding inside this document — only
   architectural critique and prescription.**
**Companion docs:** `architecture.md`, `operational-modules.md`,
   `getting-started.md`, plus the per-module READMEs in `modules/*/`.
**Status:** advisory. No changes applied. Implementing LLM should treat §6 as
   the work plan and §8 as the acceptance criteria.

---

## §0. Executive summary

The repo went through a substantial, mature refactor. Top-level layout follows
**module-by-responsibility** with thin orchestrators (`deploy.sh`, `verify.sh`)
and an explicit `scripts/ = reserved` policy that prevents drift back into a
script-soup pattern. Documentation is no longer a flat dump of 17 implementation
guides — each topic has a single source of truth in its owning module, with the
top-level `docs/` acting as a navigation hub. **This is genuinely good
work and would already pass a junior-to-mid-level architect review.**

**For senior-level assessment**, however, the gap is mostly in **operational
maturity** rather than architectural decomposition: the codebase looks like a
clean home project, not yet like an industrial repo. The differences a senior
hiring manager will notice immediately:

1. **Ansible roles have no `defaults/main.yml` or `meta/main.yml`** — this is
   the single most visible "this is not a reusable role library" signal.
2. **Zero CI/CD infrastructure** — no `.github/workflows`, no
   `.gitlab-ci.yml`, no pre-commit hooks, no automated lint/syntax check on
   merge.
3. **Hardcoded paths in 50+ task lines** that should live in `group_vars`.
4. **Idempotency hidden behind `changed_when: false`** — 15+ Ansible tasks
   that suppress state-tracking instead of computing it correctly.
5. **No Architecture Decision Records (ADRs)** — every interesting decision
   (e.g., "why home Reality ingress instead of a public RU forwarder",
   "why we keep wgc1 NVRAM forever") is buried in implementation guides
   rather than captured in canonical, versioned ADRs.
6. **No diagrams in `architecture.md`** — only ASCII art. A senior reviewer
   expects mermaid / C4 / sequence diagrams in a portfolio repo.
7. **One latent security regression** — `UDP/443 DROP` is claimed
   "Applied" in §1.0 of `stealth-security-review-and-fixes.md`, but the
   probe-side audit could not find a corresponding rule in
   `firewall-start`. Requires verification (§4.1).

**Verdict for portfolio purposes:**

| Axis | Score | Notes |
|------|-------|-------|
| Modular decomposition | **A−** | Clean module boundaries; `scripts/` policy is excellent |
| Documentation | **A−** | Good navigation, single-source-of-truth per topic; missing diagrams + ADRs |
| Ansible quality | **C+** | Roles are not idiomatic; no defaults/meta; idempotency gaps |
| Operational ergonomics | **C** | No Makefile, no CI, no lint; manual deploy.sh |
| Security posture | **A−** | 11/12 invariants confirmed, 1 regression to verify |
| Test coverage | **B−** | Fixtures exist, run-all.sh orchestrator works; no CI integration |
| Project hygiene | **C+** | LICENSE present; no CHANGELOG, no CONTRIBUTING, no SECURITY.md, no .editorconfig |

**Overall:** B+ today; **A−/A** is reachable by executing the §6 plan in 2-3
focused sessions (~12-16 hours of work).

---

## §1. What's excellent (validate first)

It is important to call these out **explicitly** — both because they should
not be regressed during cleanup, and because they are the strongest signals
of architectural taste in the repo today.

### 1.1 The `modules/` pattern is the right primitive

Each `modules/<mod>/` is a **mini-component** with:
- `README.md` (purpose / public commands / artifacts / dependencies / tests / related docs)
- `bin/` (executables — public surface)
- `router/` (router-side artifacts deployed to `/jffs/scripts/`)
- `vps/` (VPS-side artifacts deployed to `/opt/...`)
- `tests/` (when applicable)
- `docs/` (deep dives owned by this module)
- `fixtures/` (test inputs)

The boundaries are clear:
- Anything that **runs continuously on the router** lives under `routing-core/router/`.
- Anything that **observes** lives in `ghostroute-health-monitor` or `traffic-observatory`.
- Anything **stateful about secrets** lives in `secrets-management`.

This is **the right level of granularity** for a repo of this size — neither
microservices-by-default nor monolithic. A senior reviewer will appreciate that
module sizes are commensurate with their responsibilities, not artificially
sliced.

### 1.2 `scripts/` reserved with policy

The fact that `scripts/` is **empty by policy** with a `README.md` saying
"module-owned commands go in `modules/<mod>/bin`" is a sign of architectural
discipline. Many candidate repos let `scripts/` become a junk drawer. Keeping
it locked down by convention prevents that.

### 1.3 Thin orchestrators

- `verify.sh` shrank from ~400 lines to **7 lines**, delegating to
  `modules/recovery-verification/bin/verify.sh`.
- `deploy.sh` orchestrates Ansible playbooks rather than re-implementing
  config logic.

This is **the inversion of control** done right. The root of the repo is now
an **interface**, not an implementation.

### 1.4 Documentation refactor preserved content

Of the 17 prior implementation guides, **all but one** were moved into module
docs/. Old:
```
docs/
  stealth-channel-implementation-guide.md
  channel-a-decommission-implementation-guide.md
  mobile-lte-home-relay-implementation-guide.md
  sni-rotation-candidates.md
  stealth-security-review-and-fixes.md
  ... (17 files)
```
New:
```
docs/                            # navigation only (8 files)
modules/<mod>/docs/              # canonical deep dives
modules/routing-core/docs/       # 7 files
modules/reality-sni-rotation/docs/  # 1 file
modules/ghostroute-health-monitor/docs/  # 4 files
...
```

Single source of truth per topic. Cross-references work. This is **noticeably
better** than most personal infrastructure repos.

### 1.5 Security posture mostly preserved

Out of 12 audited invariants from the prior security reviews, **11 are
verifiable in the current code**:
- IPv6 kill-switch (NVRAM + dnsmasq filter-AAAA)
- MSS clamping symmetric (PREROUTING + OUTPUT)
- OpenClaw off shared :443
- SNI = `gateway.icloud.com`
- DoH via SOCKS5 (`dnscrypt-proxy proxy = socks5://127.0.0.1:1080`)
- wgs1/wgc1 disabled, NVRAM preserved as cold fallback
- VPN_DOMAINS ipset removed
- TCP buffer sysctl applied
- Connlimit on `:<home-reality-port>` (300)
- Mobile reality ingress on `:<home-reality-port>`

This is real, hard-won security work and the refactor did not erase it.

### 1.6 Test fixtures pattern

`modules/recovery-verification/fixtures/router-health/` contains saved health
states (`state-sample.env`, `state-ipv6-runtime.env`, `journal-sample.md`).
Tests assert against these fixtures. **This is exactly the right approach**
for shell-script-heavy codebases where running real commands in CI is
impractical.

### 1.7 Vault pattern

`ansible/secrets/stealth.yml.example` is comprehensive (~125 lines), with
clear sections, placeholder values, and inline guidance for what each variable
does. Real `stealth.yml` is gitignored. `~/.vault_pass.txt` referenced via
`ansible.cfg`. This is industry-standard.

---

## §2. Best-practice gaps (the bulk of this review)

### 2.1 🔴 Ansible role hygiene — the biggest visible gap

**No role has `defaults/main.yml`.** This means:
- Variables hide in `group_vars/` and inline in `tasks/main.yml`.
- A reader of the role cannot tell "what does this role expect" without grepping
  the entire repo.
- Roles are **not reusable** as standalone units (e.g., to publish to Galaxy
  or share between projects).

**No role has `meta/main.yml`.** This means:
- Implicit ordering (`ipv6_kill must run before stealth_routing`) lives only
  in playbook role lists. Forgetting the order silently breaks deploys.
- No ability to declare dependencies (`role X requires role Y first`).
- No platform tags (Merlin / Linux / what kernel).

**Hardcoded paths everywhere:** `/opt/bin/`, `/opt/etc/`, `/jffs/scripts/`,
`/usr/bin/caddy` repeat across 10+ tasks instead of being defined once in
`group_vars/routers.yml` (or `group_vars/all.yml`).

**`changed_when: false` overuse:** 15+ tasks declare themselves "never
changed" to silence Ansible's state-tracking. This is the wrong fix. The
right fix is:
- Use `register:` and a follow-up `when:` block.
- Or use `ansible.builtin.stat` / `ansible.builtin.lineinfile` / proper
  modules instead of `raw:` + sed/awk.

**`raw:` overuse:** 30+ `raw:` calls. Some are legitimate (Merlin's BusyBox
ash + NVRAM is a valid reason). But many could be replaced with
`ansible.builtin.copy` + `ansible.builtin.command` + `creates:` or
`ansible.builtin.lineinfile`. Each `raw:` is a place where Ansible has zero
visibility into what state changed.

**Procedure-disguised-as-role:** `roles/xray_reality/tasks/seed_reality.yml`
is **219 lines of imperative YAML**. This is a script wearing a role mask.
It should be:
- A standalone Python or Ansible module (`roles/xray_reality/library/`).
- Or a separate playbook called explicitly from `10-stealth-vps.yml`.
- Or moved into `modules/<some-module>/bin/` and called via a single
  `command:` task.

### 2.2 🔴 Zero CI/CD infrastructure

**No `.github/workflows/`** (or `.gitlab-ci.yml`, `Jenkinsfile`, etc.).
Tests run only when an operator manually executes `tests/run-all.sh`. There
is no PR gate.

**No pre-commit hooks** (`.pre-commit-config.yaml`). Any contributor — or any
LLM agent — can land changes that break syntax, lint, or invariants.

For a portfolio repo, this is the **single most visible gap**. The
expectation in 2026 is that any PR to any infrastructure repo runs at
minimum:
- shellcheck
- yamllint
- ansible-lint
- `bash -n` syntax check
- `ansible-playbook --syntax-check` for every playbook
- `tests/run-all.sh`
- secret-scanning (gitleaks)

A 50-line GitHub Actions workflow gets you 80% of this. Currently 0% exists.

### 2.3 🔴 No linting configuration

- No `.shellcheckrc`, no `.editorconfig`, no `.yamllint`, no `.ansible-lint`,
  no `.markdownlint.json`.
- Means the project has no enforced style, only de-facto style.
- Two contributors (or two LLM sessions) will produce divergent style
  drift over time.

### 2.4 🟡 Hardcoded values that should be vars

Examples found:
| File | Line approx | Hardcoded value |
|------|-------------|------------------|
| `roles/singbox_client/tasks/main.yml` | ~22 | `/opt/etc/init.d/S99singbox` |
| `roles/singbox_client/tasks/main.yml` | ~25 | `/opt/etc/sing-box/` |
| `roles/stealth_routing/tasks/main.yml` | ~55 | `/jffs/configs/dnsmasq.conf.add` |
| `roles/dnscrypt_proxy/tasks/main.yml` | various | `/opt/etc/dnscrypt-proxy/dnscrypt-proxy.toml` |

These should be in `group_vars/routers.yml` as:
```yaml
opt_init_d_dir: /opt/etc/init.d
singbox_init_path: "{{ opt_init_d_dir }}/S99singbox"
singbox_config_dir: /opt/etc/sing-box
```

### 2.5 🟡 No Architecture Decision Records (ADRs)

A standard pattern for serious infrastructure repos:
```
docs/adr/
  0001-record-architecture-decisions.md
  0002-modules-as-primary-decomposition.md
  0003-keep-wgc1-nvram-as-cold-fallback.md
  0004-home-reality-ingress-vs-ru-forwarder.md
  0005-no-cgnat-assumption.md
  0006-channel-a-decommissioned.md
  0007-shared-caddy-l4-on-443.md
  ... (one per material decision)
```

Each ADR is short (< 1 page) and follows the [Michael Nygard
template](https://github.com/joelparkerhenderson/architecture-decision-record):
- Title, Status (Proposed / Accepted / Superseded), Context, Decision,
  Consequences.

The repo has **plenty** of architectural decisions (variant A vs B for mobile
relay, cascade exit yes/no, SNI selection, etc.), but they're embedded in
implementation guides rather than captured as standalone ADRs. **A senior
reviewer reading this repo cold cannot easily reconstruct decision history.**

### 2.6 🟡 No diagrams in `architecture.md`

`architecture.md` is text-only. ASCII art is in some files
(`network-flow-and-observer-model.md`, others) but a portfolio repo in 2026
should have:
- **C4 model diagrams** (System / Container / Component) — at least Levels
  1 and 2.
- **Sequence diagram** for the mobile-LTE-via-home-Reality flow.
- **Network topology** diagram (mermaid `flowchart` syntax renders on GitHub).
- **State diagram** for emergency cold-fallback transitions.

mermaid renders inline on GitHub and is text-source-controlled. There is no
excuse for not having it.

### 2.7 🟡 Operational ergonomics

**No Makefile or task runner.** Currently the canonical "how do I do X" answers
are scattered:
- "How do I deploy?" → `./deploy.sh`
- "How do I verify?" → `./verify.sh`
- "How do I run tests?" → `tests/run-all.sh`
- "How do I lint?" → not possible
- "How do I generate client profiles?" → `cd ansible && ansible-playbook playbooks/30-...`

A `Makefile` (or `justfile`, or `Taskfile.yml`) consolidates these:
```make
.PHONY: deploy verify test lint clients secret-rotate

deploy:
	./deploy.sh

verify:
	./verify.sh

test:
	tests/run-all.sh

lint:
	shellcheck modules/*/bin/* modules/*/router/*
	yamllint ansible/
	ansible-lint ansible/playbooks/*.yml

clients:
	cd ansible && ansible-playbook playbooks/30-generate-client-profiles.yml
```

This is a **single discoverable entrypoint** for everything an operator (or
hiring reviewer) might want to do.

### 2.8 🟡 No CHANGELOG / version tracking

There are no semver tags, no `CHANGELOG.md`. For a personal infra repo this
is mostly cosmetic, but for a portfolio repo it signals release discipline.
Tag every meaningful state transition (e.g., `v1.0-channel-a-decommissioned`,
`v1.1-mobile-relay`, `v1.2-monitoring-system`).

### 2.9 🟡 Project hygiene files missing

| File | Purpose | Currently |
|------|---------|-----------|
| `LICENSE` | OSS license | ✅ Present |
| `README.md` | Overview | ✅ Present (and bilingual!) |
| `CHANGELOG.md` | Release history | ❌ Missing |
| `CONTRIBUTING.md` | How to contribute | ❌ Missing |
| `SECURITY.md` | Vuln reporting + threat model | ❌ Missing |
| `CODE_OF_CONDUCT.md` | Community norms | ❌ Missing (optional) |
| `.editorconfig` | Editor settings consistency | ❌ Missing |
| `.gitattributes` | LFS / line endings | ❌ Missing |
| `.github/ISSUE_TEMPLATE/` | Issue templates | ❌ Missing |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR template | ❌ Missing |
| `CODEOWNERS` | Review routing | ❌ Missing |

Most are 5-line additions. Their **absence** is the signal — present they're
table stakes; absent they look unprofessional.

### 2.10 🟡 `home_reality_*` variable scope confusion

Several mobile-relay vars exist both in `routers.yml` and `vault.yml`. A
reader cannot tell which is canonical. Standard fix: vault holds **only
secrets** (keys, passwords, UUIDs). All non-secret config goes in
`group_vars/routers.yml`. Currently this boundary is blurred.

### 2.11 🟢 (minor) Module naming polish

Most names are good. Two slightly off:
- `dns-catalog-intelligence` — "intelligence" sounds grandiose for what's a
  domain auto-add and review tool. Consider `dns-catalog` or
  `dns-catalog-management`.
- `recovery-verification` — combines two concerns (recovery scripts +
  verification). Could split into `recovery` (emergency-enable-wgc1.sh) and
  `verification` (verify.sh). Mild trade-off; current works.

---

## §3. Module-level observations

### 3.1 Module boundaries — clean

No cross-module hardcoded paths in `bin/` scripts. Shared utilities live in
`modules/shared/lib/` and are sourced explicitly. **No circular dependencies
detected.**

### 3.2 Test coverage — uneven

| Module | Tests | Why missing or fine |
|--------|-------|---------------------|
| routing-core | ❌ No tests | Data plane verified via `99-verify.yml`; arguably OK but should have at least syntax tests |
| ghostroute-health-monitor | ✅ test-health-monitor.sh + test-vps-health-monitor.sh | Good |
| traffic-observatory | ❌ No tests | Read-only observatory; arguably OK |
| dns-catalog-intelligence | ✅ test-catalog-review.sh + test-dns-forensics.sh | Good |
| reality-sni-rotation | ❌ No tests | Has docs only |
| client-profile-factory | ❌ No tests | Critical — generates secrets to disk; **should be tested with a known-input/known-output fixture** |
| secrets-management | ❌ No tests | Sensitive area; vault round-trip should be tested |
| recovery-verification | ✅ test-router-health.sh | Good |
| performance-diagnostics | n/a | Knowledge-base only |

Two specific gaps that matter for an employer review:
- **client-profile-factory has no tests.** It generates QR codes and VLESS
  URIs from vault. A regression here silently produces broken profiles. This
  is the most-likely-to-break-without-noticing module.
- **routing-core has no syntax tests.** A `bash -n` over `firewall-start`
  / `nat-start` / `stealth-route-init.sh` should be in CI minimum.

### 3.3 README quality is consistent

All module READMEs follow approximately the same structure: purpose / public
commands / artifacts / dependencies / failure modes / tests / related docs.
**This is a strong positive.** A reviewer can move between modules without
re-learning the doc shape.

One improvement: add **"Public API stability"** section to each README,
declaring which `bin/` commands are stable vs experimental. Helpful when
modules will eventually be consumed by other agents/scripts.

### 3.4 `modules/shared/` is correctly small

Just two files: `router-health-common.sh`, `device-labels.sh`. Resists the
temptation to grow into a kitchen-sink utilities lib. **Good restraint.**

---

## §4. Security audit

### 4.1 🔴 UDP/443 DROP — needs verification

**Status:** ambiguous. The status table in `modules/routing-core/docs/
stealth-security-review-and-fixes.md §1.0` claims this fix is **Applied**,
but a probe-side audit could not find a `--dport 443 ... -j DROP` rule for
the STEALTH ipset in `modules/routing-core/router/firewall-start` or in
`stealth-route-init.sh.j2`.

**Recommended action for implementing LLM:**
1. SSH the router and run:
   ```
   iptables -t filter -S FORWARD | grep -iE 'udp.*dpt:443.*(DROP|REJECT)'
   ```
2. If a DROP rule is present → status table is correct; the audit was wrong;
   document where the rule is created.
3. If no DROP rule (or REJECT only) → this is a real regression vs the
   security review's claim. Fix per `stealth-security-review-and-fixes.md
   §1.2`. Update the status table accordingly.
4. Add a `verify.sh` assertion + a `99-verify.yml` task that fails when this
   rule is missing — so the regression cannot recur silently.

### 4.2 ✅ Other invariants confirmed

- IPv6 kill-switch ✓
- MSS clamping symmetric ✓
- OpenClaw moved off `:443` ✓
- SNI = `gateway.icloud.com` ✓
- DoH via SOCKS5 ✓
- wgs1/wgc1 disabled, NVRAM preserved ✓
- VPN_DOMAINS removed ✓
- TCP buffers / `tcp_slow_start_after_idle=0` ✓
- Connlimit `:<home-reality-port>` 300 ✓
- Mobile reality `:<home-reality-port>` ✓
- `filter-AAAA` ✓

### 4.3 🟡 Channel A decommission guide possibly lost

`docs/channel-a-decommission-implementation-guide.md` was the source-of-truth
for **how the cold-fallback works** and **what NVRAM fields to preserve**.
The audit could not locate it in the new layout.

If lost: this is **not** a runtime regression (cold-fallback script still
exists in `recovery-verification/`), but it **is** a documentation regression.
The reasoning behind the cold-fallback policy is now undocumented.

**Recommended action:** restore content from git history or recreate as
`modules/recovery-verification/docs/cold-fallback-policy.md` or
`docs/adr/000X-keep-wgc1-nvram-as-cold-fallback.md`.

### 4.4 🟡 Fix-application audit trail not enforceable

Currently the `§1.0 Implementation status` table in
`stealth-security-review-and-fixes.md` is hand-maintained. There's no
machine-checkable proof that "Applied" actually means applied. Two
suggestions:
1. Add a one-shot script `modules/recovery-verification/bin/audit-fixes.sh`
   that parses the status table, extracts each fix's verifiable claim
   (e.g., "iptables FORWARD has DROP rule for udp/443"), and asserts it
   against runtime.
2. Run this in CI on a representative fixture, or in `99-verify.yml` against
   the live router. Failures = drift.

### 4.5 🟢 Defense-in-depth opportunities

These are not regressions but next-level hardening:
- **Hetzner IP rotation rehearsal** — automate a dry-run of moving Reality
  to a new IP. Currently manual; takes hours under stress.
- **Rule-set sync probe** — already specified in monitoring guide; once
  monitoring is implemented, this is the first probe to wire up because it
  detects the **routing leak** scenario (mobile traffic for newly-added
  STEALTH domains going via `direct-out` instead of Hetzner).
- **`secrets/` audit cron** — periodic check that `secrets/` contents do
  **not** get accidentally committed. `gitleaks` in pre-commit + CI.

---

## §5. "Would an employer be impressed?" checklist

A senior hiring manager reviewing this repo for an Infrastructure / SRE /
Platform Engineer role evaluates against an implicit rubric. Here it is,
explicit, with current state:

| Signal | Why it matters | Currently |
|--------|----------------|-----------|
| Clean module boundaries | shows ability to design systems | ✅ |
| Reproducible deploys | shows infra-as-code maturity | ⚠️ Partial (Ansible idempotency gaps) |
| Tests run automatically | shows operational maturity | ❌ No CI |
| Linting enforced | shows attention to code quality | ❌ No lint config |
| Documentation discoverable | shows respect for future readers | ✅ |
| Diagrams in docs | shows ability to communicate visually | ❌ No diagrams |
| ADRs for major decisions | shows architectural thinking | ❌ No ADR folder |
| Threat model documented | shows security awareness | ✅ (in `stealth-security-review-and-fixes.md`) |
| Failure modes documented | shows ops awareness | ✅ (`recovery-verification/docs/`) |
| CHANGELOG | shows release discipline | ❌ |
| CONTRIBUTING / SECURITY | shows OSS maturity | ❌ |
| Pre-commit hooks | shows attention to detail | ❌ |
| Reproducible local dev | shows tooling maturity | ⚠️ (no Makefile) |
| Visible CI status badge in README | first thing recruiters see | ❌ |
| Semver tags | shows release discipline | ❌ |
| `make test`, `make lint`, `make deploy` work | shows ergonomics thinking | ❌ |

**Score: 5/16 strong, 2/16 partial, 9/16 missing.**

After executing §6 plan: **15/16 strong, 1/16 partial.** The remaining one
(CI status badge if private repo) is unsolvable without making the repo
public.

---

## §6. Prioritized change plan (the work for the implementing LLM)

Each item below is a **discrete deliverable** with acceptance criteria.
Execute in numerical order. Do not jump to P2 before P0 + P1 are landed.

### P0 — Security regression first (do today)

#### P0.1 Verify and document the UDP/443 DROP rule

**Deliverable:**
- Determine whether the rule is actually applied on the live router.
- If applied, document where (file + line ref) in
  `stealth-security-review-and-fixes.md §1.0` table.
- If not applied, restore the rule per §1.2 of that doc, then document.
- Add a `verify.sh` assertion that fails if the rule is missing.
- Add a corresponding task to `99-verify.yml`.

**Acceptance:** running `./verify.sh` exits 0 only when the DROP rule is
present in the live router's `iptables -S FORWARD`.

#### P0.2 Restore or recreate Channel A decommission documentation

**Deliverable:** either restore `channel-a-decommission-implementation-guide.md`
from git history into `modules/recovery-verification/docs/`, **or** write a
condensed `cold-fallback-policy.md` covering:
- Which NVRAM fields are preserved (`wgc1_*`)
- Which are forced to zero (`wgc1_enable`, `wgs1_enable`)
- The emergency restoration procedure (run `emergency-enable-wgc1.sh`)
- Why this design was chosen (cold-fallback as bounded retreat option)

**Acceptance:** a future operator or LLM reading only this single doc
understands both **what** the cold-fallback is and **why** it exists.

#### P0.3 Add `audit-fixes.sh` to make the security status table verifiable

**Deliverable:** new script
`modules/recovery-verification/bin/audit-fixes.sh` that:
- Parses the §1.0 status table in `stealth-security-review-and-fixes.md`.
- For each "Applied" claim, executes the matching runtime check (sysctl
  read, iptables grep, NVRAM read, etc.).
- Emits per-claim PASS/FAIL.
- Exits non-zero if any FAIL.

**Acceptance:** running the script against a healthy router exits 0;
flipping any tracked invariant (e.g., `nvram set ipv6_service=enabled`)
makes the script exit non-zero with a clear message naming the failed
invariant.

### P1 — Ansible role hygiene

#### P1.1 Add `defaults/main.yml` to every role

**Deliverable:** for each of the 10 roles, create
`roles/<role>/defaults/main.yml` containing every variable the role
consumes, with documentation comments and reasonable defaults. Then
**remove the corresponding entries from `group_vars/`** if they were only
there to feed this role (operator-specific overrides stay in `group_vars/`).

**Acceptance:** every role's task files reference no variable that is not
either (a) defined in its `defaults/main.yml`, (b) injected via
`group_vars/`, or (c) loaded via vault. `ansible-lint` passes.

#### P1.2 Add `meta/main.yml` to every role

**Deliverable:** for each role, declare:
```yaml
galaxy_info:
  author: <owner>
  description: <one line>
  min_ansible_version: "2.15"
  platforms:
    - name: GenericLinux
      versions: [all]
dependencies:
  - role: ipv6_kill           # for stealth_routing
```

**Acceptance:** the playbook order in `20-stealth-router.yml` becomes
implicit (Ansible orders by dependency). Removing a role from the
playbook list and leaving only the dependent role still produces the same
deploy.

#### P1.3 Extract hardcoded paths into vars

**Deliverable:** introduce a single `group_vars/all.yml` block:
```yaml
# Filesystem layout vars (override per-host if needed)
opt_root: /opt
opt_bin: "{{ opt_root }}/bin"
opt_etc: "{{ opt_root }}/etc"
opt_init_d: "{{ opt_root }}/etc/init.d"
opt_var: "{{ opt_root }}/var"
jffs_root: /jffs
jffs_scripts: "{{ jffs_root }}/scripts"
jffs_configs: "{{ jffs_root }}/configs"
jffs_var_log: "{{ jffs_root }}/var/log"
```
Then sweep all role tasks and replace string literals with the var
references.

**Acceptance:** `grep -rE '/opt/(bin|etc|init.d)|/jffs/(scripts|configs)' ansible/roles/`
returns no matches. (May still match in templates, which is fine.)

#### P1.4 Replace `changed_when: false` masking

For each task with `changed_when: false`, decide:
- If the task **never** changes state → keep `changed_when: false` and add
  a comment explaining why.
- If the task **sometimes** changes state → register output, set
  `changed_when:` to a real expression, and add a `when:` to skip the
  follow-up if not needed.

**Acceptance:** running the playbook twice in a row on a fresh router
results in `changed=0` on the second run. (Currently this is not
guaranteed.)

#### P1.5 Refactor `seed_reality.yml`

The 219-line procedural YAML in `roles/xray_reality/tasks/seed_reality.yml`
should be moved to:
- `modules/<some-module>/bin/seed-reality.sh` (or `.py`), called via a
  single `ansible.builtin.command` task with proper `creates:` gate.
- Or a custom Ansible module under `roles/xray_reality/library/seed_reality.py`.

**Acceptance:** `roles/xray_reality/tasks/main.yml` is < 50 lines and
reads cleanly.

### P1.6 Document `home_reality_*` var ownership

**Deliverable:** in `architecture.md` or a new
`docs/configuration-reference.md`, declare for every variable used by the
mobile-relay path:
- Where it lives (vault vs `group_vars/routers.yml`).
- Why (secret vs config).
- Who consumes it.

**Acceptance:** running `grep -rE 'home_reality_' ansible/` shows every
reference flows through one source — no fork.

### P1 — CI / Lint / Pre-commit

#### P1.7 Add `.pre-commit-config.yaml`

**Deliverable:** a pre-commit config that runs at minimum:
- `pre-commit-hooks/check-merge-conflict`
- `pre-commit-hooks/end-of-file-fixer`
- `pre-commit-hooks/trailing-whitespace`
- `shellcheck-py/shellcheck-py` on `**/*.sh`
- `adrienverge/yamllint` on `ansible/**/*.yml` and `**/*.yaml`
- `ansible/ansible-lint`
- `gitleaks/gitleaks` (secret scanning)
- (optional) `igorshubovych/markdownlint-cli` for `**/*.md`

**Acceptance:** `pre-commit install && pre-commit run --all-files` passes.
README.md gains a "Pre-commit hooks" section explaining how to enable.

#### P1.8 Add `.github/workflows/ci.yml`

**Deliverable:** GitHub Actions workflow that on every PR runs:
- pre-commit hooks
- `bash -n` over every shell script
- `ansible-playbook --syntax-check` over every playbook
- `tests/run-all.sh`
- (optional) `markdownlint` on `**/*.md`

**Acceptance:** the workflow is triggered on push and pull_request to
`main`. README.md shows a CI status badge.

#### P1.9 Add `.editorconfig`, `.yamllint`, `.shellcheckrc`, `.ansible-lint`,
`.markdownlint.json`

**Deliverable:** sensible default configs for each linter. Keep them
minimally restrictive at first (don't break on existing code).

**Acceptance:** all linters pass against the current codebase. CI in P1.8
runs them automatically.

### P2 — Documentation polish

#### P2.1 Create `docs/adr/` and seed initial ADRs

**Deliverable:** create `docs/adr/0001-record-architecture-decisions.md`
introducing the ADR convention. Then write at least these ADRs:
- 0002 modules-as-primary-decomposition
- 0003 keep-wgc1-nvram-as-cold-fallback
- 0004 home-reality-ingress-vs-ru-forwarder
- 0005 channel-a-decommissioned
- 0006 sni-gateway-icloud-com
- 0007 shared-caddy-l4-on-443
- 0008 doh-via-stealth-tunnel
- 0009 ipv6-disabled-for-stealth
- 0010 mobile-relay-split-routing

Each ADR ~½ page, Michael Nygard format.

**Acceptance:** `docs/adr/README.md` lists all ADRs. Each ADR has
**Status: Accepted** (or **Superseded by NNNN**) and is reachable from
`architecture.md`.

#### P2.2 Add diagrams to `architecture.md`

**Deliverable:** at least three mermaid diagrams in `architecture.md`:
- **C4 System Context** — actors (RKN, ISPs, Hetzner, family devices) and
  the system boundary.
- **C4 Container** — router, VPS, mobile devices, ntfy.sh, monitoring.
- **Sequence diagram** for "iPhone on LTE → Hetzner exit" (managed flow)
  AND for "iPhone on LTE → home WAN exit" (non-managed flow).

mermaid renders inline on GitHub.

**Acceptance:** `architecture.md` opens in GitHub viewer with rendered
diagrams. The diagrams are accurate to the current state.

#### P2.3 `Public API stability` section in module READMEs

**Deliverable:** for each module's README.md, add a final section listing
public commands and their stability:
```markdown
## Public API stability

| Command | Status | Since |
|---------|--------|-------|
| bin/health-report | Stable | v1.0 |
| bin/health-report-daily | Experimental | v1.2 |
```

**Acceptance:** every module README has this section.

### P2 — Project hygiene

#### P2.4 Add `CHANGELOG.md`

Use [Keep a Changelog](https://keepachangelog.com/) format. Initial
entries reconstructed from git log: Channel-A decommission, mobile relay,
LTE perf hardening, monitoring system planning, modules refactor.

**Acceptance:** CHANGELOG present, semver-versioned, release notes for
last ~5 logical milestones.

#### P2.5 Add `CONTRIBUTING.md`

Should cover: how to run tests, how to lint, the deploy lifecycle, the
modules pattern, secret handling, who reviews what.

**Acceptance:** CONTRIBUTING.md exists and is referenced from README.md.

#### P2.6 Add `SECURITY.md`

Should cover:
- Threat model (RKN/ISP detection avoidance is the primary goal).
- Out-of-scope threats (physical seizure, legal compulsion, etc. — list
  exactly what we do NOT defend against).
- How to report a security issue (email or signal contact).
- Supported version policy.

**Acceptance:** SECURITY.md is referenced from README.md and stealth-
security-review-and-fixes.md.

#### P2.7 Add `Makefile` (or `justfile` / `Taskfile.yml`)

**Deliverable:** Makefile with at least these targets:
- `make help` (default; lists targets)
- `make deploy`
- `make verify`
- `make test`
- `make lint`
- `make format`
- `make clients`
- `make audit-fixes` (P0.3)

**Acceptance:** `make help` runs from a fresh clone and lists targets.
README.md updates to point at `make` as canonical entrypoint.

#### P2.8 Add `.editorconfig`, `.gitattributes`

Already mentioned in P1.9 for `.editorconfig`. Add `.gitattributes` for
line-ending normalization (`* text=auto`) and to mark binary files.

**Acceptance:** files included.

### P3 — Module-level test coverage

#### P3.1 Tests for `client-profile-factory`

**Deliverable:** a fixture-based test that:
- Reads a known-input `clients.yml` fixture (no real secrets).
- Runs the profile generation.
- Asserts the output VLESS URI matches a golden file.

**Acceptance:** `modules/client-profile-factory/tests/test-profile-generation.sh`
exists and passes.

#### P3.2 Syntax tests for `routing-core`

**Deliverable:** a test that runs `bash -n` over every shell script in
`routing-core/router/` and `routing-core/vps/`.

**Acceptance:** test exists; `tests/run-all.sh` calls it.

#### P3.3 Vault round-trip test for `secrets-management`

**Deliverable:** a test that verifies vault encrypt/decrypt round-trip
works on `stealth.yml.example` (which is non-secret).

**Acceptance:** `modules/secrets-management/tests/test-vault-round-trip.sh`
exists.

### P3 — Naming polish (optional, low-value)

#### P3.4 Consider renaming `dns-catalog-intelligence` → `dns-catalog`

Mild improvement; not worth breaking module paths unless other module
moves are happening anyway.

#### P3.5 Decide on `recovery-verification` split

If they grow further, split into `recovery` and `verification`. Today,
keep as-is.

### P3 — Stretch goals

#### P3.6 Architecture review automation

Set up GitHub Actions to run `audit-fixes.sh` (P0.3) on a schedule against
a saved fixture, and produce a public-facing badge. This makes the
"architecture review is living" claim demonstrable.

#### P3.7 SBOM / dependency manifests

For VPS-side Docker images, generate Software Bill of Materials. Optional
but impressive in a security-focused infra portfolio.

---

## §7. What NOT to change (preserve these)

The implementing LLM should treat the following as **load-bearing**:

1. **The `modules/` decomposition.** Do not move modules around or rename
   without explicit consent.
2. **The `scripts/ = reserved` policy.** Do not put new scripts at root
   `scripts/`. Module-owned commands go in `modules/<mod>/bin/`.
3. **The `verify.sh` 7-line delegator pattern.** The whole point is that
   root scripts are interfaces, not implementations.
4. **The 11 confirmed security invariants** (§4.2). Each P1+ change must
   not regress any of them.
5. **The `stealth.yml.example` vault template structure.** It's a teaching
   document for new operators; preserve its didactic comments.
6. **Bilingual README** (English + Russian). The user invested in
   translation; keep both in sync.
7. **The Channel A cold-fallback semantics** — wgc1 NVRAM is **never**
   deleted, only `wgc1_enable=0`.
8. **The `update-singbox-rule-sets.sh` synchronization step**. Adding
   domains to `dnsmasq-stealth.conf.add` without rerunning this script
   creates a routing leak (specified in monitoring runbook §4.1).
9. **The `home_reality_*` two-tier identity model** — router-side Reality
   keypair is **distinct** from Hetzner-side Reality keypair.
10. **`maxtg_bridge` coexistence**. The bridge container on the VPS must
    keep running and must not be merged into the stealth Docker compose.

---

## §8. Acceptance criteria for the implementing LLM

After executing the §6 plan, the following must all be true:

### Quantitative

- [ ] `pre-commit run --all-files` exits 0.
- [ ] `make lint` exits 0.
- [ ] `make test` exits 0 (offline; no live router required).
- [ ] `ansible-lint ansible/playbooks/*.yml` exits 0.
- [ ] `shellcheck modules/**/bin/* modules/**/router/* modules/**/vps/*`
      exits 0 (or has documented allow-list).
- [ ] CI workflow runs on PR and shows green.
- [ ] CI badge in README.md is rendered.
- [ ] Every Ansible role has `defaults/main.yml`.
- [ ] Every Ansible role has `meta/main.yml`.
- [ ] No hardcoded `/opt/...` or `/jffs/...` paths in `roles/*/tasks/*.yml`.
- [ ] `ansible-playbook 20-stealth-router.yml` followed by an immediate
      second run reports `changed=0` on second run (true idempotency).
- [ ] `audit-fixes.sh` exits 0.
- [ ] `verify.sh` includes the UDP/443 DROP assertion.
- [ ] At least 7 ADRs exist under `docs/adr/`.
- [ ] At least 3 mermaid diagrams in `architecture.md`.
- [ ] `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `Makefile`,
      `.editorconfig`, `.pre-commit-config.yaml` all present.
- [ ] `make help` runs and lists at least 6 targets.

### Qualitative

- [ ] A **fresh reader** can clone the repo and answer "how do I deploy?",
      "how do I run tests?", "what are the security invariants?", "what's
      the threat model?" purely from top-level docs (without spelunking
      into module deep-dives). Top-level docs may **link** into module
      docs but should be self-contained for these four questions.
- [ ] An **LLM agent** can read `status.json` (when monitoring is also
      implemented per the monitoring guide) plus `audit-fixes.sh` output
      and report the system's health correctly without further context.
- [ ] A **hiring manager** scanning the repo for 5 minutes finds: clean
      modules, ADRs, diagrams, CI badge, CHANGELOG, lint configs. None
      of these require deep reading; they are first-impression signals.

### Negative criteria (regressions to avoid)

- [ ] No security invariant from §4.2 regressed.
- [ ] No module renamed or moved.
- [ ] `scripts/` remains empty (or contains only the policy README).
- [ ] No new top-level shell scripts; new functionality goes into modules.
- [ ] No hardcoded secrets in any committed file. Run `gitleaks` to verify.
- [ ] Bilingual README pair stays in sync.

---

## §9. Glossary

- **ADR** — Architecture Decision Record. Short markdown file per major
  decision, conventionally numbered.
- **C4 model** — Simon Brown's diagramming notation: Context / Container /
  Component / Code.
- **Idempotent** — running the same task twice produces the same result.
  Ansible's strict definition: second run reports `changed=0`.
- **Module** (in this repo) — a directory under `modules/` with a defined
  ownership boundary and a public `bin/` interface.
- **Cold fallback** — wgc1 NVRAM preserved but disabled. Activated only
  via `emergency-enable-wgc1.sh`.
- **Routing leak** — mobile traffic for a STEALTH-classified domain
  exiting via `direct-out` (home WAN) instead of through Reality. See
  monitoring runbook §3.3.

---

## §10. Open questions for the operator

These are **not** blockers for the implementing LLM — they're for the
operator to answer in a follow-up:

1. **Is the repo private or will it be public?** Affects how aggressive
   we should be with `gitleaks`, what badges go in README, and whether
   `CODEOWNERS` is meaningful.
2. **Do we want Galaxy-publishable Ansible roles?** If yes, P1.2 needs
   richer `meta/main.yml`. If no, minimum viable.
3. **Should client-profile-factory tests use real cryptography?** The
   testable behavior is the **format** of the generated VLESS URI, not the
   crypto correctness. Use placeholder keys.
4. **What's the SLO for the deploy pipeline?** "Manual + Ansible idempotent"
   today; do we want to formalize this (e.g., "any change can be reverted
   in < 5 min via `make rollback`")?
5. **Is multi-VPS failover in scope for the next quarter?** If yes, this
   review's P3 should add an ADR and a basic plan.

---

## §11. Final word

This is a **strong** repo for a personal infrastructure project. The
modular decomposition is the kind of taste-driven decision that
distinguishes thoughtful engineers from shortcut-takers. The work needed
to take it from "good personal project" to "industrial-grade portfolio"
is mostly **operational tooling and project hygiene**, not architectural
rethinking. Roughly 12-16 hours of focused work executes the §6 plan and
takes the repo to A-/A territory by senior-architect rubric.

The architectural choices that already work — modules, thin orchestrators,
documented invariants, fixture tests, vault patterns, single-source-of-truth
docs — should be preserved through the cleanup. The §7 list is the
do-not-touch boundary.

After §6 is done, I would **recommend** this repo to a hiring manager
without reservation as evidence of senior infrastructure engineering taste.
