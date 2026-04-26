# Routing Core Module Overview

## Purpose

Routing Core owns the production data plane: dnsmasq/ipset classification,
Merlin firewall hooks, sing-box REDIRECT, home Reality ingress, managed Reality
egress and direct-out fallback for non-managed traffic.

## Architecture

Router runtime scripts live in `router/` and are installed to the existing
`/jffs/scripts/*` paths by `deploy.sh` and Ansible. The module does not change
remote path names; it only gives the implementation a clearer home in the repo.

## Contract

This module is mutating only during explicit deploy or manual recovery. Normal
monitoring and report commands must not call these scripts to modify routing.

## Commands And Storage

- Public wrappers: `scripts/firewall-start`, `scripts/nat-start`,
  `scripts/services-start`, `scripts/update-singbox-rule-sets.sh`.
- Deploy target: `/jffs/scripts/*` and sing-box rule-sets under the configured
  router rule-set directory.
- Related docs: `docs/architecture.md`,
  `docs/stealth-channel-implementation-guide.md`,
  `docs/channel-routing-operations.md`.
- Tests: covered indirectly by `verify.sh`, health fixtures and live Ansible
  verification.
