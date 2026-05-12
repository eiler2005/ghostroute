# Traffic Intelligence

Traffic Intelligence is the local, deterministic interpretation layer above
`traffic-facts`. It classifies destinations for review surfaces and future GUI
grouping, but it does not own byte accounting, route verification, blocking or
router/VPS control-plane changes.

Inputs:

- `traffic_facts` rows from Traffic Observatory / Console ingest.
- `traffic_dns_links` rows and DNS confidence fields.
- Optional `ip_enrichment_cache` rows for local-first IP/provider metadata.

Outputs:

- Coarse `traffic_class`: `client`, `personal_cloud`, `service_background` or
  `unclassified`.
- GUI lane/category axes:
  - `traffic_lane`: `client_observed`, `service_system`, `privacy_risk`,
    `shared_infra` or `unknown_review`;
  - `dns_category`: local purpose/category such as `system_push`,
    `personal_cloud`, `analytics`, `ads_tracking`, `cdn_shared` or
    `unknown_ip_only`.
- Fine category/provider labels such as Apple system, Firebase analytics, CDN,
  personal cloud, hosting/VPS-like or unknown.
- Advisory `decision_hint` values for human review. These are not applied
  firewall/routing actions.
- Console client lane read models:
  - `client_traffic_by_lane` for client/lane totals;
  - `client_destination_by_lane` for destination drilldown;
  - `client_route_evidence_defects` for destination-level route proof defects.

Home Reality encrypted ingress is classified as client-observed counter
evidence only. The module does not invent Apple/iCloud, Google/YouTube or other
destination labels for Home Reality profile bytes without DNS/flow evidence.

IP enrichment is local-first and advisory. The Console can join cached IP/ASN
metadata for IP-only destinations and map clear providers into coarse families
such as `messaging_platform`, `social_platform`, `meeting_platform`,
`cdn_cloud_hosting`, `google_infra`, `apple_infra` or `network_provider`.
ASN/provider evidence alone must not promote traffic to `service_system`,
`privacy_risk` or a blocking action; DNS/domain evidence or an explicit local
rule is required for stronger purpose labels. External OSINT/API adapters, if
added, must be disabled by default, rate-limited and cached, and must send only
IP/prefix values rather than client labels or traffic evidence.

The supported offline bootstrap is iptoasn's `ip2asn-v4-u32.tsv.gz` snapshot.
Console imports it into `ip_prefix_catalog` and refreshes observed IPv4
destinations into `ip_enrichment_cache`; IPv6 and external provider adapters are
future follow-ups.

Unknown-domain review is file-first. Console can export the current review
queue with:

```bash
cd modules/ghostroute-console/app
npm run export:review-queue -- --window today --limit 100
```

The gitignored JSON/Markdown output under
`modules/ghostroute-console/data/review/` contains destination addresses,
current categories, byte weights, sample clients and route evidence defects.
Use it as the LLM/offline-analysis input, then promote only stable findings into
deterministic local rules. The GUI should display and filter this queue, not ask
the operator to classify large traffic volumes one button at a time.

See [`docs/traffic-intelligence-layer-plan.md`](/docs/traffic-intelligence-layer-plan.md)
for the schema boundaries, taxonomy, GUI plan and verification path.
