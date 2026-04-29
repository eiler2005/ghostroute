# STEALTH_DOMAINS Curation Audit

**Status:** advisory-only, current as of 2026-04-25.

This document reviews `configs/dnsmasq-stealth.conf.add` for performance and
operational clarity. It does **not** remove or change any domain. Runtime
catalog changes require a separate decision and smoke test.

## Current Model

`STEALTH_DOMAINS` is the managed domain source for both active paths:

```text
LAN/Wi-Fi client
  -> dnsmasq/ipset STEALTH_DOMAINS
  -> sing-box REDIRECT :<lan-redirect-port>
  -> VPS Reality

Mobile Home Reality client
  -> home ASUS :<home-reality-port>
  -> sing-box reality-in
  -> rule_set generated from STEALTH_DOMAINS
  -> VPS Reality for managed destinations
```

The same catalog affects router CPU, VPS egress volume, and mobile LTE
latency. Over-routing ordinary domains through Reality can reduce throughput,
especially on mobile where the path already has the extra home ingress leg.

## Why This Is Not Auto-Removed On The Router

The router already has useful catalog machinery:

- `domain-auto-add.sh` writes only `STEALTH_DOMAINS` auto entries.
- `update-singbox-rule-sets.sh` mirrors dnsmasq catalogs into sing-box rule-sets.
- DNS forensics, traffic reports, blocked-list checks, and ISP probes provide
  evidence for future decisions.

What the router cannot know safely is user intent:

- whether a domain is needed for work while traveling;
- whether a service is not blocked but should still exit from VPS for
  account/location consistency;
- whether a domain is needed only temporarily;
- whether a false direct route breaks an app in a way that is hard to diagnose.

Therefore future router-side logic should produce advisory scoring, not
automatic removal.

## Keep Likely Managed

These families are likely to remain managed unless a later user decision says
otherwise.

| Domain family | Reason | Action |
|---|---|---|
| YouTube / Google media: `youtube.com`, `youtu.be`, `youtube-nocookie.com`, `youtube.googleapis.com`, `youtubei.googleapis.com`, `googlevideo.com`, `ytimg.com`, `ggpht.com` | Core managed video path and common block/quality-sensitive traffic. | `keep` |
| Telegram: `telegram.org`, `telegram.me`, `telegram.com`, `telegram.dog`, `telegram.space`, `t.me`, `telegra.ph`, `graph.org`, `cdn-telegram.org`, `telegram-cdn.org`, `tdesktop.com`, `telega.one`, `telesco.pe`, `comments.app`, `contest.com`, `fragment.com`, `tg.dev`, `tx.me` | Core messenger/media path. | `keep` |
| Instagram/Facebook/Messenger: `instagram.com`, `cdninstagram.com`, `facebook.com`, `fb.com`, `fbcdn.net`, `fbsbx.com`, `messenger.com` | Social/media access that commonly needs managed routing. | `keep` |
| TikTok/ByteDance: `tiktok.com`, `tiktokcdn.com`, `tiktokcdn-eu.com`, `tiktokcdn-us.com`, `tiktokv.com`, `ttwstatic.com`, `byteimg.com`, `byteoversea.com`, `ibytedtos.com`, `muscdn.com` | Video/social traffic where direct availability and quality vary. | `keep` |
| WhatsApp: `whatsapp.com`, `whatsapp.net`, `wa.me`, `wl.co` | Messenger/media path; static Meta CIDR coverage lives separately. | `keep` |
| AI services in active use: `chatgpt.com`, `claude.ai`, `claude.com`, `openai.com`, `oaistatic.com`, `oaiusercontent.com`, `anthropic.com`, `ai.google.dev`, `aistudio.google.com`, `generativelanguage.googleapis.com`, `notebooklm.google.com`, `jnn-pa.googleapis.com`, `www.googleapis.com`, `google.com` | May be needed for work and account/location consistency. Some are not necessarily blocked, so keep only while user need is confirmed. | `keep`, then periodic review |

## Review Before Changing

These entries might be valid, but they need live evidence before any cleanup.

| Domain | Reason to review | Recommended action |
|---|---|---|
| `github.com`, `api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `githubusercontent.com`, `githubstatus.com` | Developer workflow may work direct from RU, but account/location consistency or occasional blocks may matter. | `needs-live-evidence` |
| `gitlab.com`, `gitlab-static.net` | Similar developer workflow question as GitHub. | `needs-live-evidence` |
| `atlassian.com`, `bitbucket.org` | Usually work SaaS rather than block-specific traffic. | `needs-live-evidence`; possible `move-to-no-vpn` |
| `dev.azure.com`, `visualstudio.com` | Developer tooling; may be direct-capable. | `needs-live-evidence`; possible `move-to-no-vpn` |
| `icloud.com`, `icloud.apple.com`, `icloud.com.cn`, `icloud-content.com`, `apple-cloudkit.com`, `apple-livephotoskit.com`, `apzones.com`, `iwork.apple.com`, `gc.apple.com`, Apple Account hosts (`account.apple.com`, `idmsa.apple.com`, `gsa.apple.com`, `appleid.cdn-apple.com`) | Apple sync may be latency-sensitive and often direct-capable; currently kept managed because iCloud Drive on Mac is poor on direct/RF and works with full VPN. | `needs-live-evidence`; do not remove blindly |
| `aaplimg.com`, `cdn-apple.com`, `apps.apple.com`, `itunes.apple.com`, `mzstatic.com`, `media.apple.com`, `podcasts.apple.com` | App Store/media/CDN traffic can be high-volume and may not need VPS. | `needs-live-evidence`; likely candidate for narrower handling |
| `acast.com`, `acast.cloud`, `omny.fm`, `podtrac.com`, `pscrb.fm`, `tritondigital.com` | Podcast/ad/media delivery domains can add bulk traffic without stealth value. | `needs-live-evidence`; possible `remove-later` |
| `x.com`, `twitter.com`, `twimg.com`, `t.co` | Social path may be desired managed, but not always required for every device. | `needs-live-evidence` |
| `linkedin.com` | Professional network; often direct-capable. | `needs-live-evidence`; possible `move-to-no-vpn` |
| `example-provider.invalid`, `example-provider-cloud.invalid` | Provider/admin domains; not ordinary user traffic. | `needs-live-evidence`; possible `move-to-no-vpn` |
| `cobalt.tools`, `smithery.ai`, `usercontent.dev`, `redshieldvpn.com`, `imo.im`, `livetv.sx` | Specific service entries; keep only if still used. | `needs-live-evidence` |
| `wisprflow.ai`, `api.wisprflow.com`, `wisprflow.onelink.me` | App-specific traffic; may be direct-capable but currently observed/needed. | `needs-live-evidence` |

## Candidate Direct / Remove Later

These are not approved removals. They are the first families to inspect when
performance work resumes.

| Candidate | Why it may be direct | Proposed next step |
|---|---|---|
| Apple media/CDN families | High byte volume, likely direct-capable, low stealth value for many workflows. | Compare `traffic-report` direct/Reality byte contribution and app behavior with one temporary direct rule. |
| Podcast/ad delivery families | Usually content delivery rather than blocked-service control plane. | Test direct on one LAN/mobile device; remove only if playback remains healthy. |
| Developer SaaS families | Often not blocked and can produce large downloads. | Decide per-workflow: keep for account consistency or move to direct. |
| Provider/admin domains | Not user media; likely should not consume Reality path by default. | Move to direct only after confirming no admin workflow expects VPS exit. |

## Future Router-Side Advisory Scoring

Future automation should generate a report, not mutate the catalog. Suggested
score inputs:

- DNS forensics: which clients request the domain, how often, and on how many days.
- Traffic reports: byte volume through Reality versus direct.
- `blocked-domains.lst` membership.
- ISP probe result from `domain-auto-add.sh`.
- Manual labels: `keep-managed`, `candidate-direct`, `temporary`, `do-not-remove`.
- Recent regression notes from `docs/troubleshooting.md` or change logs.

Suggested output:

```text
domain | score | reason | recommendation | evidence window | last seen
```

Allowed recommendations:

- `keep`
- `needs-live-evidence`
- `move-to-no-vpn`
- `remove-later`

Disallowed behavior:

- automatic removal from `configs/dnsmasq-stealth.conf.add`;
- automatic rewrite of `domains-no-vpn.txt`;
- auto-pruning domains only because they are not on a public blocked list.

## Safe Workflow For A Later Curation Pass

1. Run `./modules/traffic-observatory/bin/traffic-report` and `./modules/dns-catalog-intelligence/bin/dns-forensics-report`.
2. Pick one small domain family, not the whole catalog.
3. Test a temporary direct bypass for one device/profile.
4. Confirm app behavior on LAN and mobile Home Reality.
5. Only then edit the catalog and deploy.
6. Run `ROUTER=192.168.50.1 ./verify.sh` and `99-verify.yml`.
7. Save a short decision log in this document or `docs/vpn-domain-journal.md`.
