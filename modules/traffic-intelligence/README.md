# Traffic Intelligence

Traffic Intelligence is the local, deterministic interpretation layer above
`traffic-facts`. It classifies destinations for review surfaces and future GUI
grouping, but it does not own byte accounting, route verification, blocking or
router/VPS control-plane changes.

Inputs:

- `traffic_facts` rows from Traffic Observatory / Console ingest.
- `traffic_dns_links` rows and DNS confidence fields.
- Future optional enrichment cache rows, only when explicitly enabled.

Outputs:

- Coarse `traffic_class`: `client`, `personal_cloud`, `service_background` or
  `unclassified`.
- Fine category/provider labels such as Apple system, Firebase analytics, CDN,
  personal cloud, hosting/VPS-like or unknown.
- Advisory `decision_hint` values for human review. These are not applied
  firewall/routing actions.

External OSINT/API providers are intentionally not called by this module. Future
IPinfo/Shodan/AbuseIPDB/VirusTotal/MCP adapters should be manual,
disabled-by-default and cached.

See [`docs/traffic-intelligence-layer-plan.md`](/docs/traffic-intelligence-layer-plan.md)
for the schema boundaries, taxonomy, GUI plan and verification path.
