# Catalog Review Latest

- Generated: 2026-04-17T12:21:23+03:00
- Mode: advisory only — no runtime changes, no deploy side effects, no automatic cleanup

## Summary

- Manual domain rules in repo: 99
- Auto-discovered rules on router: 60
- Live `VPN_DOMAINS`: 7134 / 65536 (10.9%)
- Live `VPN_STATIC_NETS`: 67
- Static CIDR lines in repo: 70
- Broad static review candidates (`/18` or broader): 10
- Parent-covered child domain candidates: 6
- Largest static section by estimated IPv4 space: Apple Podcasts / Apple services (4 CIDR, 17,858,560 IP)

## Static Coverage Review

### Section summary

| Section | CIDR count | Estimated IPv4 space |
|---|---:|---:|
| Apple Podcasts / Apple services | 4 | 17,858,560 |
| WhatsApp / Meta Platforms (AS32934) | 25 | 4,389,120 |
| Telegram IPv4 prefixes | 14 | 24,576 |
| imo Messenger / PageBites (AS36131) | 27 | 12,800 |

### Broad CIDR review candidates

- High: `17.0.0.0/8` in **Apple Podcasts / Apple services** — 16,777,216 IPv4 addresses
- High: `57.144.0.0/10` in **WhatsApp / Meta Platforms (AS32934)** — 4,194,304 IPv4 addresses
- High: `57.112.0.0/12` in **Apple Podcasts / Apple services** — 1,048,576 IPv4 addresses
- Low: `129.134.0.0/17` in **WhatsApp / Meta Platforms (AS32934)** — 32,768 IPv4 addresses
- Low: `157.240.0.0/17` in **WhatsApp / Meta Platforms (AS32934)** — 32,768 IPv4 addresses
- Low: `163.70.128.0/17` in **WhatsApp / Meta Platforms (AS32934)** — 32,768 IPv4 addresses
- Low: `139.178.128.0/18` in **Apple Podcasts / Apple services** — 16,384 IPv4 addresses
- Low: `144.178.0.0/18` in **Apple Podcasts / Apple services** — 16,384 IPv4 addresses
- Low: `157.240.192.0/18` in **WhatsApp / Meta Platforms (AS32934)** — 16,384 IPv4 addresses
- Low: `31.13.64.0/18` in **WhatsApp / Meta Platforms (AS32934)** — 16,384 IPv4 addresses

## Domain Coverage Review

### Largest explicit domain families

- `apple.com` — 4 explicit rules
- `github.com` — 3 explicit rules
- `githubusercontent.com` — 3 explicit rules
- `google.com` — 3 explicit rules
- `googleapis.com` — 2 explicit rules
- `aaplimg.com` — 1 explicit rule
- `acast.cloud` — 1 explicit rule
- `acast.com` — 1 explicit rule

### Parent-covered child domain candidates

- `aistudio.google.com` is already covered by `google.com`
- `notebooklm.google.com` is already covered by `google.com`
- `api.github.com` is already covered by `github.com`
- `raw.githubusercontent.com` is already covered by `githubusercontent.com`
- `objects.githubusercontent.com` is already covered by `githubusercontent.com`
- `codeload.github.com` is already covered by `github.com`

Recommendation note: these are **cleanup candidates only**. Keep explicit child rules if they improve readability, document intent, or protect against future family splits.

## Recommendation Mode

1. Review the widest static CIDRs first and confirm they still solve a real non-DNS traffic problem.
2. Treat parent-covered child domains as readability-vs-minimalism decisions, not automatic removals.
3. Prefer narrowing static coverage only after a live smoke test proves DNS-based coverage is enough.
4. Make any future cleanup behind `deploy -> verify.sh -> router-health-report --save`.
