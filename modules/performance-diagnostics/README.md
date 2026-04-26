# Performance Diagnostics Toolkit Module Overview

## Purpose

Performance Diagnostics separates speed and quality issues from routing
correctness. It covers RTT, retransmits, TCP tuning, MSS clamp, keepalive
behavior and LTE/Home Reality symptoms.

## Architecture

This module is currently documentation-led. Its checks are surfaced through
Routing Core, Health Monitor and Recovery Verification rather than standalone
scripts.

## Contract

Diagnostics are read-only by default. Applying TCP, MSS, keepalive or runtime
tuning changes requires explicit operator approval through the normal deploy or
manual recovery workflow.

## Commands And Storage

- Public entrypoints: `verify.sh`, `scripts/router-health-report`, targeted
  router diagnostics documented in the runbooks.
- Artifacts: health reports, router counters and local operator notes.
- Related docs: `docs/routing-performance-troubleshooting.md`,
  `docs/traffic-observability.md`, `docs/stealth-monitor-runbook.md`.
- Tests: covered by health monitor baseline fixtures and router verification.
