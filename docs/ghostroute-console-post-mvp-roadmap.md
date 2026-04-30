# GhostRoute Console Post-MVP Roadmap

Этот документ фиксирует будущий roadmap для `modules/ghostroute-console/` и
смежных operational-модулей. Текущий MVP остаётся factual read-only Console:
normal UI строится только на реальных snapshots/SQLite, fixtures и mock-данные
разрешены только в тестах.

## Приоритеты

- **Priority 1** — прямое развитие Console после MVP. Эти пункты идут первыми,
  но не отменяют read-only-by-default и требуют audit/rollback перед любыми
  write-действиями.
- **Priority 2** — broader backlog из общих документов проекта. Эти темы
  рассматриваются отдельными safe-RFC/plan-сессиями и не внедряются
  автоматически только потому, что они зафиксированы здесь.

## Priority 1: Console Post-MVP

Status: implementation slices exist in `modules/ghostroute-console/` and are
summarized in [ghostroute-console-architecture.md](ghostroute-console-architecture.md).
Route explanation, channel badges, SQLite v4 evidence rows, real log-tail event
ingestion, SSE live stream, catalog review/dry-run, notification settings,
budget history, ops actions and audit tables are present. Remaining work is
hardening, real notification delivery/provider integrations and any
router/runtime mutation beyond prepared/audited local actions.

1. **True Live Mode**
   - Server-Sent Events live stream поверх factual snapshots, SQLite events and
     read-only real log-tail ingestion через `live-events-report --json`.
   - Future: long-lived tail/WebSocket transport if cursor polling becomes too
     slow or too lossy.
   - Live topology, active flows, fresh/stale indicators.
   - Без seed/mock данных в production UI.

2. **Route Explanation как на операторском экране**
   - Отдельный route detail/drawer с цепочкой:
     `Client -> Router -> DNS/ipset -> sing-box -> outbound -> VPS/Direct -> Internet`.
   - Evidence cards, timeline, raw evidence toggle, export/share.
   - Confidence explanation для `exact`, `estimated`, `dns-interest`, `unknown`.

3. **Catalog Actions, но безопасно**
   - Review/apply candidates, git diff preview, dry-run, backup, rollback,
     audit log.
   - По умолчанию runtime-safe; current apply prepares a local patch and audit
     record, not a router deploy.

4. **Notifications**
   - Telegram/e-mail alerts для stale snapshots, leaks, quota warnings,
     unusual routing и collector errors.
   - UI для ack/snooze без автоматических runtime-действий.

5. **Budget Provider Integration**
   - Сначала реальные VPS/LTE квоты из config/env.
   - Затем provider APIs для reset date, forecast, overage estimate.

6. **Auth Hardening**
   - Усилить текущий Caddy Basic Auth через Caddy headers/rate-limit.
   - Рассмотреть Caddy forward auth, OIDC/Authelia или Tailnet identity как
     следующий слой, если Console перестанет быть только read-only.

7. **Data Quality**
   - Current source evidence includes client IP, destination IP/port, DNS qname
     and answer, SNI, sing-box outbound, matched rule, egress identity fields
     and source log refs where available.
   - Remaining work: better correlation
     `flow -> DNS query -> catalog entry -> route decision`, device identity,
     historical regressions and richer confidence explanations.

8. **Collector Control**
   - Manual `collect-once`, collector status, job log, last error,
     schedule visibility.
   - Restart/deploy/router runtime actions скрыты до отдельного design review.

9. **Security Hardening**
   - Полностью активировать `ghostroute_readonly`: public key из secrets,
     forced-command tests, SSH timeout/error log.
   - Redaction audit, Caddy access review, SQLite backup/restore drill.

## Priority 2: Broader Project Backlog

1. **Managed Egress Failover**
   - Backup VPS для managed domains, latched switch, dry-run report,
     explicit rollback.
   - Не делать auto-return, не превращать Channel B/C в fallback для Channel A,
     не возвращать WireGuard как normal path.

2. **DNS / Resolver Strategy**
   - Read-only DNS proof сначала.
   - Optional VPS Unbound только для Channel B/VPS-like profile.
   - Policy-based DNS только если появится реальная потребность.

3. **Catalog Curation**
   - Ужесточить auto-discovery, добавить scoring для `STEALTH_DOMAINS`.
   - Widest CIDR review и recommendations-only cleanup до ручного решения.

4. **Channel B/C Maintenance**
   - Поддерживать Channel B production selected-client lane.
   - Channel C native/Shadowrocket compatibility развивать отдельно, без
     влияния на Channel A REDIRECT/DNS/TUN ownership.

5. **Overlay Migration**
   - ZeroTier/NetBird/OpenZiti рассматривать только если понадобится remote LAN
     access beyond mobile Reality egress.

6. **Performance Diagnostics**
   - Latency, retransmits, TCP/MSS/keepalive/LTE/Home Reality diagnostics как
     read-only Console panels.

7. **IPv6 Policy**
   - Явно зафиксировать supported/not-supported сценарии.
   - IPv6 routing делать отдельным проектом с отдельной верификацией.

8. **Repo Polish / Employer-Ready**
   - GitHub Actions, SECURITY.md, README diagram/demo/badges,
     LICENSE/CHANGELOG, Vault offline backup runbook.

9. **x3mRouting**
   - Использовать только как analysis/discovery lane.
   - Не использовать как routing engine без отдельного design review.

10. **Log Naming Cleanup**
    - Channel-aware router log paths с fallback на старые пути.
    - Отдельный router deploy, smoke-check и rollback.

## Safe Implementation Order

Для Priority 1 идти инкрементами:

1. Security/auth/audit foundation.
2. Live data and collector control.
3. Notifications.
4. Catalog write actions with dry-run, backup and rollback.
5. Provider-backed budget.

Для Priority 2 каждый пункт начинать с read-only proof/RFC, затем dry-run, и
только потом делать минимальный runtime change при доказанной необходимости.

Любые write/runtime действия требуют:

- explicit operator approval;
- backup или reversible state;
- rollback path;
- smoke checks;
- redaction review.

## Test And Acceptance Notes

- Docs changes must not expose secrets, private IP/MAC/UUID, local-only aliases
  or raw evidence.
- Console feature work must pass `tests/run-all.sh`, console `npm test`,
  `npm run build`, API smoke and Playwright desktop/mobile checks.
- Runtime/Priority 2 work requires live-state snapshot before/after, dry-run
  output, rollback drill and router/VPS smoke checks.

## Current Deployment Note

Initial MVP deployment is served through the existing Caddy stack with Basic
Auth in front of the read-only Console. Earlier Tailnet-only wording remains a
valid hardening option, but it is no longer the only documented access model.
