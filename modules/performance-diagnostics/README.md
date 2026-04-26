# Performance Diagnostics Toolkit Module Overview

## Purpose

Performance Diagnostics separates speed and quality issues from routing
correctness. It covers RTT, retransmits, TCP tuning, MSS clamp, keepalive
behavior and LTE/Home Reality symptoms.

## Features

- Baseline-aware latency and retransmit interpretation.
- Guidance for MSS clamp, TCP and keepalive tuning.
- Symptom-first troubleshooting for slow iPhone, LTE and Home Reality cases.
- Clear split between diagnostics and operator-approved fixes.

## How It Works

This module is documentation-led. Runtime observations come from Health Monitor,
Traffic Observatory and Recovery Verification; the module explains how to read
those signals without confusing performance degradation with routing failure.

## Architecture

- No standalone runtime scripts in v1.
- Health baselines live in the Health Monitor runtime state.
- Verification and traffic reports provide the live evidence.

## Read-only / Mutating Contract

Diagnostics are read-only by default. TCP, MSS, keepalive or runtime tuning
changes require explicit operator approval through deploy or a documented manual
recovery procedure.

## Public Commands

- `./verify.sh`
- `./modules/ghostroute-health-monitor/bin/router-health-report`
- `./modules/traffic-observatory/bin/traffic-report`

## Runtime Storage & Artifacts

- Health monitor baseline samples and summaries.
- Router counters.
- Local operator notes and generated reports.

## Dependencies On Other Modules

- Health Monitor supplies RTT/retransmit status.
- Traffic Observatory supplies throughput and path context.
- Routing Core owns the tunables that may eventually be changed.

## Failure Modes

- RTT degradation after baseline learning.
- TCP retransmit spikes.
- LTE/Home Reality clients slower than LAN clients.
- Performance symptoms incorrectly treated as catalog/routing failures.

## Tests

- Health monitor baseline fixture tests.
- `./verify.sh` live confirmation.
- `./tests/run-all.sh`

## Related Docs

- `docs/routing-performance-troubleshooting.md`
- `docs/traffic-observability.md`
- `docs/stealth-monitor-runbook.md`
