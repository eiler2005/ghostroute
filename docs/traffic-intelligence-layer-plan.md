# Traffic Intelligence Layer Plan

> **Status: planning / future direction — not current runtime state.**

## Summary

The v3 traffic accounting and evidence pipeline is the foundation for facts:
`traffic-facts --json` is the machine contract, `traffic-evidence --json` is
the raw read-only evidence layer, and `traffic-report` remains legacy/debug for
operators. Routing, DNS evidence collection, rollups and Console ingestion are
stable enough to stop expanding routing behavior here.

The next layer is `traffic-intelligence`: a local deterministic rules engine
that explains destinations, separates client/service/personal-cloud/unknown
traffic for the GUI, and emits advisory decision candidates. It never changes
bytes, route split, DNS confidence, router rules, blocking, deploy hooks or
VPS/router state.

This implementation also fixes the Home Reality coverage gap before expanding
GUI review surfaces: encrypted Home Reality profile counters are brought into
trusted v3 evidence as `home_reality_samples`, then represented in
`traffic_facts` as `Home Reality ingress` with no manufactured per-destination
labels.

The attached PDF/image material for this pass rendered as a blank black page in
the local tools, so this plan is based on the repo state and the explicit
operator requirements from the discussion.

## Boundaries

- No new routing behavior, active blocking, router rule mutation or Console
  control-plane actions.
- `traffic_facts` remains authoritative for bytes, route split and evidence
  confidence.
- Intelligence may add labels, explanations and review candidates only.
- `traffic-report` remains available for human/debug rollback context, but new
  machine consumers must use `traffic-facts`.
- Optional enrichment such as IPinfo, Shodan, AbuseIPDB, VirusTotal or MCP is
  future work, disabled by default, manual/privacy-aware and advisory only.

## Fact Schema Clarification

Keep fact fields factual and separate:

- `intended_route`: `VPS | Direct | Unknown`; route intent from policy/ipset.
- `route_verification`: `verified_vps | verified_direct |
  counter_allocated | ingress_route_allocated | intent_only | mismatch |
  unknown`; compatibility field from the v3 contract.
- `route_status`: `verified | counter_allocated | intent_only | mismatch |
  unknown`; GUI-friendly status for badges and filters.
- `accounting_status`: only `ok | accounting_error`.
- `dns_status`: `exact | shared | no_match | approximate_ts`.
- `dns_ts_source`: `parsed_log | snapshot_approx`.

If DNS time is `snapshot_approx`, confidence is capped and explanations must
remain conservative. DNS TSV/JSON uses `event_type` for query/answer semantics;
do not rename it to `rcode`.

## Module Layout

Shared engine:

- `modules/traffic-intelligence/lib/classification.mjs`
- `modules/traffic-intelligence/lib/classification.d.ts`
- `modules/traffic-intelligence/README.md`

Console adapters:

- `modules/ghostroute-console/app/src/lib/intelligence/*` re-export or call the
  shared engine.
- `domain-attribution.mjs` and `traffic-classification.mjs` remain thin
  compatibility surfaces.
- Console selectors read `destination_enrichment` / `decision_candidates`; they
  do not duplicate classification rules.

Core input/output:

```ts
type TrafficIntelligenceInput = {
  destination?: string;
  destination_ip?: string;
  domain?: string;
  dns_qname?: string;
  dns_link_confidence?: string;
  route?: string;
  route_verification?: string;
  protocol?: string;
  destination_port?: number;
  traffic_class?: string;
};

type TrafficIntelligenceResult = {
  traffic_class: "client" | "personal_cloud" | "service_background" | "unclassified";
  traffic_lane:
    | "client_observed"
    | "service_system"
    | "privacy_risk"
    | "shared_infra"
    | "unknown_review";
  dns_category:
    | "user_content"
    | "messaging"
    | "personal_cloud"
    | "media_streaming"
    | "system_push"
    | "system_appstore"
    | "system_connectivity"
    | "system_auth_security"
    | "system_maintenance"
    | "app_background"
    | "crash_reporting"
    | "analytics"
    | "ads_tracking"
    | "telemetry"
    | "cdn_shared"
    | "cloud_hosting"
    | "unknown_ip_only"
    | "unknown_shared_answer"
    | "unknown_domain";
  category: string;
  provider: string;
  traffic_role:
    | "client_interactive"
    | "client_bulk_sync"
    | "service_background"
    | "system_maintenance"
    | "analytics_tracker"
    | "cdn_delivery"
    | "infra_hosting"
    | "unknown";
  traffic_purpose: string;
  decision_hint:
    | "allow"
    | "block_candidate"
    | "monitor"
    | "route_vps_candidate"
    | "direct_candidate"
    | "investigate"
    | "ask_user";
  confidence: "high" | "medium" | "low" | "unknown";
  reason_code: string;
  human_explanation: string;
  evidence_sources: string[];
};
```

## Taxonomy

Coarse GUI filter values stay stable:

- `client`
- `personal_cloud`
- `service_background`
- `unclassified`
- `all`

GUI lanes:

- `client_observed`
- `service_system`
- `privacy_risk`
- `shared_infra`
- `unknown_review`

Fine categories:

- `system.apple.push`, `system.apple.maintenance`
- `system.google.connectivity`, `system.google.background`
- `analytics.firebase`
- `tracker.ads`
- `cdn.cloudflare`, `cdn.fastly`, `cdn.akamai`, `cdn.cloudfront`,
  `cdn.gcore`, `cdn.unknown`
- `personal_cloud.icloud`, `personal_cloud.dropbox`,
  `personal_cloud.google_drive`, `personal_cloud.onedrive`
- `vps.hosting`, `vps.provider_unknown`
- `unknown.ip_only`, `unknown.no_dns_match`, `unknown.shared_dns_answer`,
  `unknown.domain`

Default rules:

- Apple/Google system traffic: `allow`.
- Firebase, ads and trackers: `block_candidate`.
- Personal cloud: `monitor`.
- Known CDN domain/provider: `monitor`.
- CDN IP-only/shared DNS: low confidence, `unclassified`, `ask_user`.
- IP-only/no DNS/unknown domain: `unclassified`, `ask_user`.
- VPS/hosting: `unclassified`, `ask_user` or `monitor`; never auto-route.

`unknown.domain` must not become `client_interactive` by default.

CDN is treated as infrastructure, not behavior. A known domain may carry the
domain's meaning; an IP-only/shared CDN answer stays `shared_infra` or
`unknown_review` and must not become a confident block rule.

## Read Model

Do not store intelligence authority in `traffic_facts`. Use
`destination_enrichment` for stable per-destination classification:

- `destination_key`
- `domain`/`ip` through `kind`, `value`, `normalized_value`
- `category`
- `provider`
- `traffic_class`
- `traffic_lane`
- `dns_category`
- `traffic_role`
- `traffic_purpose`
- `decision_hint`
- `confidence`
- `reason_code`
- `human_explanation`
- `sources_json`
- `evidence_sources_json`
- `evidence_json`
- `first_seen`
- `last_seen`

Use `decision_candidates` for advisory review items:

- `destination_key`
- optional `client_key` / `client_ip`
- `proposed_action`
- `confidence`
- `reason_code`
- `explanation`
- `status`: `pending | accepted | rejected | snoozed`
- `applied`: always `0` unless a future, separately designed control-plane
  deliberately changes this.

`filter_rules` and `filter_decisions` stay dry-run in this phase.

## GUI Plan

Keep existing `trafficClass` filters working. Add a read-only
Traffic Intelligence view with:

- Service vs client split.
- Personal cloud and unknown/needs-review counts.
- Fine category and traffic role.
- Advisory action hint.
- Confidence.
- Human explanation.
- Evidence/source chips where useful.
- Recent advisory candidates, explicitly dry-run/unapplied.

Future GUI refinements can add dedicated review tabs:

- Client traffic.
- Service/background.
- Analytics & trackers.
- CDN/shared infrastructure.
- Unknown / needs review.

Examples:

- Firebase Analytics: “Можно блокировать; это аналитика приложения.”
- Apple Push: “Лучше оставить; системные push-уведомления.”
- G-Core/CDN IP: “CDN/shared IP; без домена не блокировать.”

## Optional Enrichment Policy

Optional enrichment can help only with ambiguous cases:

- IP-only destinations.
- Unknown VPS/hosting.
- High-byte unknown destinations.
- CDN/provider naming.
- Abuse/reputation hints.

It must not be the primary client-vs-service classifier. It must not
automatically decide `BLOCK`, `ALLOW` or route changes. It should be manual or
disabled by default, cached, privacy-aware and easy to audit.

## Tests

- Unit tests for local intelligence:
  `app-measurement.com`, ad/tracker domains, `push.apple.com`, iCloud,
  Dropbox, Drive, OneDrive, known CDNs, shared CDN/IP-only, no DNS match and
  unknown domains.
- Regression tests that intelligence never changes `bytes`, `via_vps_bytes`,
  `direct_bytes`, `unknown_bytes` or `route_verification`.
- Schema/read-model tests that intelligence fields live outside
  `traffic_facts`.
- GUI tests/build that the `trafficClass` filter still works with the new
  Intelligence page.
- Existing `traffic-evidence` / `traffic-facts` tests to prove routing and data
  collection did not regress.

## Verification Path

Run the narrow checks first:

```bash
bash -n modules/traffic-observatory/bin/traffic-evidence modules/traffic-observatory/bin/traffic-facts modules/traffic-observatory/router/dns-query-snapshot
tests/test-traffic-evidence-v3.sh
cd modules/ghostroute-console/app && npm test && npm run build
```

Then run the broader checks before commit/deploy:

```bash
./tests/run-fast.sh
cd modules/ghostroute-console/app && npm run verify:aggregates && npm run verify:timezone && npm run bench:dashboard && npm run report:db-size
```

Deploy is allowed only after local checks pass. Post-deploy checks should stay
read-only: `./verify.sh`, deploy gate, live `traffic-evidence`, live
`traffic-facts`, and one collector run.
