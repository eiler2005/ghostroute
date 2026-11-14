# Egress qualification before a routing change

A backend is eligible for a client trial only after application-level tests
from the actual router succeed. An open TCP port, a certificate, a generic
TLS handshake or a healthy VPS process is insufficient. The qualification
command never selects a backend or changes a production route.

## Repeatable Telegram comparison

```bash
./modules/ghostroute-health-monitor/bin/telegram-egress-check
./modules/ghostroute-health-monitor/bin/telegram-egress-check --json
```

The control machine needs Ansible Vault access, Python with PyYAML and the
existing operator router SSH profile. The router needs its existing Python,
sing-box and curl. Default: three rounds, five native DC samples per backend,
eight-second socket timeouts. A degraded bank may take a few minutes.

The bank is `primary_vps`, `hermes_vps` and `backup_reality`. Private endpoint,
identity and TLS fields come from Vault. Each backend has a separate diagnostic
loopback SOCKS listener and an explicit route in a temporary sing-box process.
There is no fallback to another backend for a failed request. The binary copy
has a distinct process name; cleanup terminates only that diagnostic process.
No production service, route, firewall, catalog, credentials or client profile
is changed. Temporary files may contain credentials and are private and removed
afterwards. Production config hashes must match before and after the run.

The reserve profile builder supports TCP/Reality and gRPC/Reality. For gRPC it
uses the exported service name and ALPN, and rejects a Vision flow. Keep these
fields aligned with the production renderer; see
[router-only profile rotation](../../routing-core/docs/managed-egress-profile-rotation.md).

Evaluate all layers in this order:

| Layer | Evidence | What it does not prove |
|---|---|---|
| Vantage and control access | Tests originate on the router; administrative access works independently | The Mac/agent may use a different VPN/network |
| TCP and raw TLS | Separate reachability stages; raw TLS is advisory | Reality may legitimately reject generic TLS |
| Authenticated tunnel | Each diagnostic SOCKS inbound routes only to its own backend | Open TCP/TLS alone does not establish authentication |
| Native Telegram | Unauthenticated `req_pq_multi` receives a complete `resPQ` with the requested random nonce and correct frame length | Logged-in sessions, messages, calls or media downloads |
| Complete HTTPS transfer | Full successful bodies from Telegram web endpoints; timeout/partial response fails | Native media or sustained throughput |
| Exit identity | Owned exits must match the configured IPv4; reserve exit must be observed and differ from home WAN | Reserve IP permanence, country or reputation |
| Real client acceptance | iPhone on cellular through the affected channel and home Wi-Fi, including messages and new media from different chats | Multi-day stability after a single successful attempt |

The default native targets are public bootstrap DC endpoints reviewed against
the [official Telegram Desktop source](https://github.com/telegramdesktop/tdesktop/blob/dev/Telegram/SourceFiles/mtproto/mtproto_dc_options.cpp).
The probe follows Telegram's [abridged transport framing](https://core.telegram.org/mtproto/mtproto-transports)
and [unencrypted authorization-key exchange](https://core.telegram.org/mtproto/auth_key).
It does not sign in, obtain an account session or read user content.

Bootstrap DCs are a baseline, not a complete media/CDN inventory. For an actual
incident, supplement with reviewed destination/port pairs observed on the
affected client path. Keep that inventory local and gitignored:

```bash
./modules/ghostroute-health-monitor/bin/telegram-egress-check \
  --targets reports/telegram-targets.private.tsv --rounds 3 --timeout 8
```

The TSV has three whitespace-separated fields: an anonymous label, IPv4 address
and port. Include the baseline DCs as well as relevant observed destinations.
The output exposes only the labels, backend roles and results. It does not print
deployment endpoints, credentials or measured public IPs. A wrong nonce or
truncated response must fail; a successful header followed by a body timeout
must also fail. Native nonces validate response correlation, not server identity
or signed-in application behavior; tunnel identity is checked separately.

## Selection and rollback rule

- `eligible_for_client_trial` requires every native round, both full web
  transfers, the appropriate exit identity check and unchanged production config.
- A nonzero command exit means at least one backend failed. Read per-backend
  results; a healthy active backend does not make a failed inactive backend green.
- Even a green result requires explicit operator authorization for the actual
  routing change, relevant configuration tests and a private rollback snapshot.
- Preserve AI sensitive rules, ordinary managed rules, Channel M exclusion and
  client ingress. Refresh an active Amn projection when the policy changes.
- If a candidate fails, keep the working route. Do not test a failed candidate
  by moving production users onto it. Do not claim a proxy or an ISP is broken
  from a generic TLS probe alone.
- After an authorized change, verify the live policy and exit again, then obtain
  real-client messages/media acceptance. Mark an experiment and record its
  manual review window in private operator notes; a review date is not a timer.

## Distinguishing an endpoint fault from path interference

Use `egress-dpi-probe --from both` for a sanitized control/router comparison,
and read-only server diagnostics when needed. Confirm the actual control
vantage first: a Mac behind another VPN is not the home-router uplink.
Compare the same endpoint, SNI and client settings. A server-local TLS success
with a router-side timeout narrows the fault to the external path or its
handling, but does not by itself prove ISP blocking. A passive header-only TCP
trace can locate incomplete handshakes without recording payloads. Repeat
through an independent uplink before attributing filtering to a specific
network. Preserve both successes and failures in ignored local reports.

## Comparing transports and interpreting DPI signals

Keep an unavailable historical endpoint separate from a working implementation
of its former transport. Compare isolated authenticated routes from the router,
record repeat counts and median complete-response/first-byte times, and verify
production hashes before and after. Treat an expected unauthenticated API 401
as an application response; distinguish it from a tunnel failure.

Different endpoints and exits confound a TCP-versus-gRPC performance comparison.
A causal test needs both transports on a controlled server with the same exit,
paired alternating requests and an independent uplink. A saved endpoint also
failing through a working tunnel weakens a direct-home-path-only hypothesis,
without proving its cause. Raw TLS EOF/reset can occur on a working Reality
endpoint and must not be labelled confirmed DPI. Website HTML probes do not
prove video playback, model-generation latency or signed-in messaging/media.
Keep measured deployment evidence in private reports rather than public docs.

## Local coverage

```bash
python3 modules/ghostroute-health-monitor/tests/test-telegram-egress-check.py
bash -n modules/ghostroute-health-monitor/bin/telegram-egress-check
```

Fixtures cover real SOCKS/MTProto framing, mismatched nonces, truncated replies,
partial HTTP transfers, exit-identity failures and backend preparation. They do
not replace the live router comparison or signed-in iPhone acceptance.
