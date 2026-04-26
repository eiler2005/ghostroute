# ADR 0003: Health Alerts Are Local-Only

## Context

GhostRoute health monitoring needs to show failures without making the router
depend on external push channels or remediation automation.

## Decision

Health alerts are local runtime artifacts on the router/VPS storage. The module
writes sentinels, JSON status, Markdown summaries, daily digests and alert
ledgers, but does not send ntfy, Telegram, SMS or other external notifications
in the current version.

## Consequences

Monitoring remains read-only relative to production routing state. Operators and
LLM handoffs can inspect local evidence without adding another dependency to the
failure path. External notifications are a separate future phase.
