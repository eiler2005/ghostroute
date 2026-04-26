# ADR 0005: Secrets Stay Outside Git

## Context

GhostRoute contains router, VPS, Reality, QR profile and monitoring workflows.
Those workflows require real endpoints, ports, UUIDs, keys and generated client
artifacts.

## Decision

Tracked files must not contain real secrets or production literals. Secrets live
in Ansible Vault, ignored generated artifacts or local private journals. Public
documentation uses placeholders such as `<home-reality-port>` and
`example.invalid`.

## Consequences

The repo can be reviewed and shared more safely. `secret-scan` and architecture
audits should fail when real values are accidentally introduced into tracked
files.
