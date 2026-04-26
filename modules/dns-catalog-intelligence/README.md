# DNS & Catalog Intelligence Module Overview

## Purpose

DNS & Catalog Intelligence observes DNS lookup evidence, discovers candidate
domains, reviews managed catalogs and keeps manual rules separate from
auto-discovered entries.

## Features

- Router-side DNS observation and optional auto-add workflow.
- Catalog review for domain suffixes and static network coverage.
- DNS forensics snapshots for "who looked up what" investigations.
- Local gitignored domain journal for operational notes and capacity snapshots.

## How It Works

Router-side discovery reads dnsmasq evidence, validates candidates against the
configured policy and writes auto-discovered catalog state on the router. Local
report commands review repo catalogs and DNS snapshots without changing runtime
state.

## Architecture

- `router/` contains router-side discovery and blocklist refresh scripts.
- `bin/` contains local report commands.
- `fixtures/` and `tests/` capture catalog and DNS-forensics contracts.

## Read-only / Mutating Contract

Local reports are advisory and read-only. Router discovery can update only the
router auto catalog according to configured rules. Public repo catalog changes
remain manual and explicit.

## Public Commands

- `./modules/dns-catalog-intelligence/bin/domain-report`
- `./modules/dns-catalog-intelligence/bin/catalog-review-report`
- `./modules/dns-catalog-intelligence/bin/catalog-review-report --save`
- `./modules/dns-catalog-intelligence/bin/dns-forensics-report`
- Runtime-only router script: `/jffs/addons/x3mRouting/domain-auto-add.sh`

## Runtime Storage & Artifacts

- `configs/dnsmasq-stealth.conf.add`
- `configs/static-networks.txt`
- Router auto-discovered dnsmasq files.
- Local ignored journal: `docs/vpn-domain-journal.md`
- Local generated reports: `reports/`

## Dependencies On Other Modules

- Routing Core consumes generated rule-set inputs.
- Traffic Observatory and DNS forensics share device-label metadata.
- Secrets Management protects local/private metadata.

## Failure Modes

- Catalog drift between manual and router auto-discovered rules.
- Broad static CIDR rules that should be split or reviewed.
- DNS evidence missing because dnsmasq logs or snapshots are stale.
- Auto-discovered child domains already covered by broader suffixes.

## Tests

- `./modules/dns-catalog-intelligence/tests/test-catalog-review.sh`
- `./modules/dns-catalog-intelligence/tests/test-dns-forensics.sh`
- `./tests/run-all.sh`

## Related Docs

- `docs/domain-management.md`
- `docs/x3mrouting-roadmap.md`
- `docs/stealth-domains-curation-audit.md`
- `docs/ai-tooling-domains.md`
