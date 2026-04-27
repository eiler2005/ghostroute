# Routing Core Module Overview

## Purpose

Routing Core owns the production data plane: dnsmasq/ipset classification,
Merlin firewall hooks, sing-box REDIRECT, home Reality ingress, managed Reality
egress to the VPS and direct-out fallback for non-managed traffic.

## Features

- Builds and refreshes router-side hooks for NAT, firewall and service startup.
- Maintains sing-box rule-set synchronization from the repo-managed catalogs.
- Preserves Channel A only as a cold fallback path, not as steady-state routing.

## How It Works

`deploy.sh` copies the router scripts from this module to the ASUS Merlin
runtime paths. Merlin then calls `/jffs/scripts/nat-start`,
`/jffs/scripts/firewall-start` and `/jffs/scripts/services-start`; those hooks
install the REDIRECT, counter and cron behavior used by the rest of GhostRoute.

## Architecture

- `router/` contains BusyBox-compatible router scripts.
- `deploy.sh` and Ansible install those scripts to stable `/jffs/scripts/*`
  runtime paths.
- sing-box rule-sets are generated under the configured router rule-set
  directory, currently `/opt/etc/sing-box/rule-sets`.

## Read-only / Mutating Contract

This module mutates routing only during explicit deploy, explicit rule-set
refresh, or explicit manual recovery. Health, traffic and DNS report modules may
inspect its state, but must not silently change routing.

## Public Commands

- `./deploy.sh`
- `./modules/routing-core/router/update-singbox-rule-sets.sh`
- Runtime-only router hooks under `/jffs/scripts/*`

## Runtime Storage & Artifacts

- `/jffs/scripts/firewall-start`
- `/jffs/scripts/nat-start`
- `/jffs/scripts/services-start`
- `/jffs/scripts/update-singbox-rule-sets.sh`
- `/opt/etc/sing-box/rule-sets`

## Dependencies On Other Modules

- DNS & Catalog Intelligence provides domain/static network inputs.
- Traffic Observatory installs counters that are invoked from the firewall path.
- Recovery & Verification validates the routing invariants.

## Failure Modes

- Missing Merlin hook files.
- Rule-set drift between router runtime and repo catalogs.
- sing-box REDIRECT not receiving managed traffic.
- WireGuard cold fallback accidentally re-enabled.

## Tests

- `./modules/recovery-verification/tests/test-router-health.sh`
- `./verify.sh`
- Ansible `playbooks/99-verify.yml`

## Related Docs

- `docs/architecture.md`
- `modules/routing-core/docs/current-routing-explained.md`
- `modules/routing-core/docs/network-flow-and-observer-model.md`
- `modules/routing-core/docs/channel-routing-operations.md`
- `modules/routing-core/docs/stealth-channel-implementation-guide.md`
