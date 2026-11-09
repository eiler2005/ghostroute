# Security decision and acceptance

## Scope and decision

Threat: an operator opens a sensitive site in the wrong browser or continues
browsing after the intended transport fails. Trusted components: the local OS,
Chrome, application code/private profile, authenticated home proxy and selected
egress. Account identification, hostile local processes and compromised browser
code are outside this boundary.

Use a separate browser with a fixed local proxy and a gate with **no unbound
DIRECT adapter**. The normal-browser blocker is a second, explicit installation.
It blocks listed domains even when a third-party VPN appears connected; it does
not try to infer trust from an icon. Sensitive catalog gaps remain catalog gaps.

A macOS Network Extension/content filter could enforce a wider OS boundary, but
requires Apple signing/entitlements and explicit OS installation. This module
does not pretend to provide that boundary. An outer `sandbox-exec` wrapper was
rejected because it conflicts with Chrome's own nested sandbox. Disabling Chrome's
sandbox to make the wrapper run would weaken the design and is not used.

The native shell loads only its loopback dashboard. The dashboard binds to a
literal loopback address without a reverse-DNS lookup. API mutations require a
per-run bearer token, matching Host/Origin and JSON; no remote CORS, command
execution, arbitrary file path endpoint or upstream secret fields in status.
Tokens stay in the bootstrap pipe and URL fragment/session storage, not query logs.
Local processes with the same user's privileges can read the profile/token and
are not isolated by this API boundary. The CONNECT listener is loopback only.

The router remains the owner of the home route's destination policy. A matching
exit canary alone is insufficient: verify the imported allowlist against deployed
rules and repeat that verification when they change. Guard does not monitor
router config drift or guarantee that every future webpage dependency is listed.
This import deliberately reuses the authenticated C HTTPS transport and does not
silently migrate A/B/C/D/M/Amn clients or weaken B's separate certificate debt.

## Local tests

The duplex relay has one I/O owner per tunnel, including TLS reads and writes.
It bounds queued data, handles SSL readiness states and drains buffered output
before closing on peer EOF. A large TLS response fixture covers premature-close
regressions; two independent threads must not operate on the same SSL object.

From the repository root:

```bash
./modules/mac-privacy-guard/tests/run.sh
GUARD_REPORT_DIR=reports/mac-guard-design/browser \
  node modules/mac-privacy-guard/tests/browser.mjs
```

The browser script uses an already installed Playwright (defaults to the Console
dev installation). Alternatively set `GUARD_PLAYWRIGHT` to an isolated installed
Playwright module path. No Console source, lockfile, server or production runtime
is changed. `GUARD_CHROME` may select a test Chrome executable. Fixture certificates,
loopback origins and profiles are temporary. The test-only certificate bypass is
never part of application launch arguments. `chromiumSandbox: true` overrides
Playwright's usual disabled-sandbox default.

| Layer | Required evidence |
|---|---|
| Policy | IDNA and suffix boundaries; private/ambiguous IP, non-HTTPS, CRLF, credentials-in-URL rejected; no DIRECT config; private file ownership/modes |
| Upstream TLS | Wrong pin and untrusted CA receive no credentials; complete inner HTTPS over outer TLS; approved exit succeeds, other/ambiguous exits fail |
| Gate | Locked startup; allowlisted tunnel; unknown destination refusal; no direct retry; Lock drains existing sessions; cancelled qualification/late connect cannot reopen access |
| VPN adapter | Every IPv4/IPv6 socket is bound before connect; missing/recycled index and setsockopt failure produce no unbound retry |
| Dashboard | Token required, cross-origin mutation rejected, Host enforced, traversal denied, public status redacts endpoint/credentials |
| Real Chrome | HTTPS through fixture works; locked/upstream-down/gate-down fail; implicit IPv4/IPv6 loopback bypass absent; no WebRTC UDP or ICE candidates in fixture; netlog contains no DNS transaction |
| UI | Desktop/mobile layout, applied CSS, locked state and disabled launch button |
| Extension | Generated MV3 permission/rule shape; actual profile activation and browser refusal are a separate acceptance step |

Dedicated CI uses fixed Ubuntu/macOS runners, no secrets and no SSH to deployment.
It tests this module independently of the repository-wide existing CI debts.
Do not describe a passing module workflow as a passing whole-repository workflow.

## Live acceptance matrix

Keep dates, endpoint identities, output and screenshots in ignored local reports.
Public docs describe the contract; they do not expose the installed instance.

| Scenario | What proves it | Boundary |
|---|---|---|
| Home sensitive route | Trusted C certificate/identity, deployed catalog coverage, full HTTPS canary matching independently approved sensitive exit, real protected-browser request | One qualified route/network; not all apps or all client channels |
| Ordinary Chrome blocker | Extension enabled in the intended profile; listed main-frame and subresource requests fail before the site; ordinary unlisted page works | Other profiles, Incognito without permission, other browsers excluded |
| VPN application | Correct interface ownership, trusted exit list, real application/page load and DNS/WebRTC checks | A mocked setsockopt test does not qualify Red Shield/Browsec or every OS version |
| Transport failure | Existing and new requests cannot reach a direct tripwire after tunnel/server/gate failure | Use isolated fixtures before a scheduled live failure drill |
| Sleep, Wi-Fi change, reconnect and reboot | Repeat positive and negative checks before/during/after with an independent observer | Do not disrupt the operator's current network to manufacture evidence |
| Upgrade | Repeat module fixtures, browser netlog/WebRTC checks and relevant live acceptance | Browser flags and VPN behavior can change between versions |

Remaining activation/provider/lifecycle acceptance belongs to
[RA-12](../../../docs/routing-assurance-roadmap.md), not a hidden claim in README.

## Primary references

- [Chromium proxy behavior](https://chromium.googlesource.com/chromium/src/+/HEAD/net/docs/proxy.md):
  fixed proxy behavior, explicit DIRECT fallback and implicit-loopback subtraction.
- [Chromium WebRTC IP handling](https://chromium.googlesource.com/chromium/src/+/HEAD/components/policy/resources/templates/policy_definitions/Miscellaneous/WebRtcIPHandling.yaml):
  `disable_non_proxied_udp` policy, verified by real-browser negative tests.
- [Cloudflare DoH API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/):
  JSON DNS requests sent through the bound VPN socket.
- Apple SDK `netinet/in.h` / `netinet6/in6.h`: Darwin socket interface binding
  constants. Behavior still needs live acceptance for the selected VPN driver.
