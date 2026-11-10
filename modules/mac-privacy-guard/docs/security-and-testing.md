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

The SwiftUI app uses a typed client over its child process's loopback API. There
is no HTML, JavaScript or WKWebView in the application window. The API binds to a
literal loopback address without a reverse-DNS lookup. API reads and mutations require a
per-run bearer token, matching Host/Origin and JSON; no remote CORS, command
execution, arbitrary file path endpoint or upstream secret fields in status.
The bootstrap token stays in the private pipe and native process memory, not query logs.
The native client removes the bootstrap fragment before making requests and
keeps the credential only in memory. The API serves no browser dashboard.
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

The bounded in-memory journal records validated destination hosts, fixed reason
codes, timestamps and tunnel byte totals. It excludes URL paths/queries, request
headers, payloads and raw upstream exception text. Lock intentionally closes
tunnels without counting those closures as new refusals or network failures.
Clearing events does not reset session counters. Chrome reports only this
extension's DNR matches. The native bridge is restricted to the unpacked
extension's path-derived ID and a private Unix socket; its schema accepts only
validated heartbeat/block metadata, scoped HTTP data and solicited preview; it
cannot activate a route or invoke the control API. Commands back to Chrome are
fixed, expire after 5 seconds and never contain arbitrary JS/CDP/URL actions.
No general host access, webRequest, cookies, debugger or content-script permission
is requested. Block rules explicitly include main-frame requests; omitting
resourceTypes would exclude that type under Chrome's defaults.

Browser-open preflight refuses locked or uncatalogued destinations before spawning
Chrome. Tests cover safe launch-result journaling, early process exit, inherited
AppKit identity removal and the owned browser PID. A real browser fixture launches
Chrome through the actual browser owner with an injected parent bundle identity
and requires an origin request; a successful API response alone is insufficient.
Startup fixtures prove a second engine cannot acquire the existing lock and that
the fixed gate port can be rebound after shutdown but not over a live listener.
Swift checks also cover typed startup errors, local failure events/retry, recovery
after API loss and reset of filters that hide blocked events.

From the repository root:

```bash
./modules/mac-privacy-guard/tests/run.sh
swift run --package-path modules/mac-privacy-guard/native GuardNativeChecks
node modules/mac-privacy-guard/tests/diagnostics.mjs
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

Install the test Chromium for the selected Playwright version before the browser
check (`node <playwright_dir>/cli.js install chromium`). Extension testing runs
in a temporary profile with its own NativeMessagingHosts registration, not the
operator's profile or native-host registry. It proves actual main-frame and POST
subresource refusal, domain boundaries, native message delivery and continuing
block enforcement when the event receiver is unavailable. Fixture evidence
contains fake destinations only. Native controls are checked by the Swift store
suite; the built macOS window additionally requires visual/operator acceptance.

Ordinary-profile Open access uses a session allow rule with the static deny
ruleset still enabled. It permits the browser's current network/proxy without
checking the exit IP/country. Native replies renew a 15-second lease; there is no
one-minute user limit. Browser fixtures prove allow/block in the same tab while
the optional gateway stays locked, renewal beyond one minute, reporting toggles
and restoration on detected app loss. Browser scheduling
remains a boundary; no instantaneous OS kill-switch claim is made.

DevTools callback fixtures exercise the real extension runtime/native bridge/app
command path, including response preview, state acknowledgement and erasure. They
do not substitute for visual acceptance of Chrome's own DevTools container.
Separate JS fixtures reject unsolicited bodies, stale/hidden sessions, oversized
previews and late content after Stop. The diagnostic store is separate from the
activity journal and never qualifies a route. See [agent contract](chrome-agent.md).

The browser fixture waits for its full lifetime with an Event, not a single
signal.pause(). An explicit SIGCHLD handler exercises child-process exit without
ending the fixture. Close-browser control acknowledges asynchronously; a separate
poll proves the owned process has exited before the test continues.

| Layer | Required evidence |
|---|---|
| Policy | IDNA and suffix boundaries; private/ambiguous IP, non-HTTPS, CRLF, credentials-in-URL rejected; no DIRECT config; private file ownership/modes |
| Upstream TLS | Wrong pin and untrusted CA receive no credentials; complete inner HTTPS over outer TLS; approved exit succeeds, other/ambiguous exits fail |
| Gate | Locked startup; allowlisted tunnel; unknown destination refusal; no direct retry; Lock drains existing sessions; cancelled qualification/late connect cannot reopen access |
| VPN adapter | Every IPv4/IPv6 socket is bound before connect; missing/recycled index and setsockopt failure produce no unbound retry |
| Control API | Token required, cross-origin mutation rejected, Host enforced, traversal denied, status redacts endpoint/credentials; no HTML assets |
| Real Chrome | HTTPS through fixture works; locked/upstream-down/gate-down fail; implicit IPv4/IPv6 loopback bypass absent; no WebRTC UDP or ICE candidates in fixture; netlog contains no DNS transaction |
| Native app | Swift package build; typed client, strict bootstrap/startup errors, bearer/Origin, locked startup, stale activation cannot overwrite Lock, lost API disables controls, retry/local error journal and filter reset; visual acceptance of the built SwiftUI window |
| Extension | Actual temporary Chrome main-frame/subresource blocks, no substring false positive, native bridge to Guard, URL redaction, independent enforcement without receiver; operator-profile activation remains separate |

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
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging):
  fixed host origins, stdio framing and user-data-directory registration.
- [Chrome DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest):
  main-frame resource scope and unpacked-only rule-match feedback.
