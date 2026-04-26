# DNS & Catalog Intelligence Module Overview

## Purpose

DNS & Catalog Intelligence observes DNS lookup evidence, discovers candidate
domains, maintains managed catalog reviews and keeps manual rules separate from
auto-discovered entries.

## Architecture

- `router/` contains the router-side discovery and blocklist refresh scripts.
- `bin/` contains local report and forensics entrypoints.
- `fixtures/` and `tests/` capture catalog review and DNS forensics contracts.

## Contract

Router discovery may update the router auto catalog according to its configured
rules. Public repo catalog changes remain manual. The local
`docs/vpn-domain-journal.md` journal is intentionally gitignored.

## Commands And Storage

- Public wrappers: `scripts/domain-auto-add.sh`, `scripts/domain-report`,
  `scripts/catalog-review-report`, `scripts/dns-forensics-report`,
  `scripts/update-blocked-list.sh`.
- Catalog files: `configs/dnsmasq-stealth.conf.add`,
  `configs/static-networks.txt`, router auto-discovered dnsmasq files.
- Related docs: `docs/domain-management.md`, `docs/x3mrouting-roadmap.md`,
  `docs/stealth-domains-curation-audit.md`, `docs/ai-tooling-domains.md`.
- Tests: `modules/dns-catalog-intelligence/tests/*`, also exposed through
  `tests/test-catalog-review.sh` and `tests/test-dns-forensics.sh`.
