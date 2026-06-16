<!-- Keep changes surgical and scoped. See CONTRIBUTING.md and AGENTS.md. -->

## Summary

<!-- What does this change and why? Link the issue/ADR/roadmap item. -->

## Scope / channels touched

<!-- e.g. Channel A data plane, egress switcher, health monitor, Console, docs only. -->

## Checklist

- [ ] Change is minimal and scoped to the request (no unrelated refactors).
- [ ] Docs updated for any changed behavior (README / module docs / ADR / runbook).
- [ ] Tests added or updated; the narrowest proving check was run.
- [ ] `./tests/run-fast.sh` passes locally.
- [ ] `./modules/secrets-management/bin/secret-scan` is clean.
- [ ] For Ansible changes: `ansible-playbook --syntax-check` on touched playbooks.
- [ ] **No secrets, real endpoints, IPs, ports, provider names, UUIDs, keys or
      personal data** are added; only placeholders and mnemonic roles.
- [ ] Architecture invariants preserved (managed split -> `reality-out`; no
      legacy WireGuard/`RC_VPN_ROUTE` resurrection; B/C/D do not take over
      Channel A ownership).

## How verified

<!-- Commands run and their result. Note if a step was skipped and why. -->
