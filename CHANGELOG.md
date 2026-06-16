# Changelog

All notable changes to this repository are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This is a
single-operator platform without published release tags, so changes are grouped
by date under **Unreleased** as they land on `master`.

## [Unreleased]

### Added
- Owned **Hermes** managed-egress backend and a Channel A/B/C egress switcher
  (`managed-egress-mode`) behind the stable `reality-out` contract.
- Independent **Channel D** managed-egress selector (`reality-out-d`) with
  operator command parity (`managed-egress-mode --channel d`,
  `live-check channel-d`, `managed-egress-check` Channel D reporting).
- **`egress-backend-health`** read-only tool: role-only backend bank resolved
  from Vault, router-side TCP/TLS probes plus application canaries through the
  active managed SOCKS path, with a mock-driven fixture test.
- Product and contributor docs: `docs/prd.md`, `docs/testing.md`,
  `docs/repo-presentation-roadmap.md`; `CODE_OF_CONDUCT.md`, `CODEOWNERS`,
  `.editorconfig`, issue/PR templates and Dependabot config.
- README "Engineering Highlights" section and a Mermaid architecture diagram.

### Changed
- Refined the Telegram managed-domain and static-CIDR coverage.
- Refreshed the contributor review gate and repository conventions framing.

### Security
- Introduced a policy keeping role-to-country/provider metadata in a gitignored
  `docs/private/` note and Vault only; tooling output stays role-only and
  sanitized.

[Unreleased]: https://github.com/eiler2005/ghostroute/commits/master
