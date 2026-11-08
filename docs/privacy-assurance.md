# Managed Routing Privacy and Recovery Checks

This is the stable verification contract for GhostRoute's home-first routing.
Record actual client names, addresses, sites, results and traffic evidence only
in ignored local reports. A successful router health check and an operator's
informal client check are useful signals, but neither proves every browser or
app request followed the intended route.

## Expected observations

| Traffic | Access network sees | Destination sees |
|---|---|---|
| Managed LAN/Wi-Fi | Home ISP sees router-to-VPS traffic | Active managed VPS exit |
| Managed home-first A/B/C/D/Amn | Client network sees the home ingress; home ISP sees router-to-VPS traffic | Active managed VPS exit |
| Sensitive match after ingress, when the mode is enabled | Same as the managed path | `hermes_vps` exit |
| Non-managed traffic after home-first ingress | Client network sees the home ingress; home ISP sees the direct destination | Home WAN exit |
| Channel M service request | VPS-local reverse listener and router-initiated tunnel | Home WAN exit |

An endpoint `DIRECT` decision **before** GhostRoute is different: that request
uses the endpoint's own network and never reaches the router policy. The home ISP
can see the router's VPS connection and any direct home-WAN destinations. A
destination can still correlate an account, browser fingerprint or request
timing across exits; an exit-IP check does not establish anonymity.

## Evidence levels

1. **Static and runtime state:** test the rule-set, first `FORWARD` guard,
   REDIRECT, DNS, listeners and separate channel ownership with local fixtures,
   `live-check --deploy-gate` and router-limited `99-verify.yml`.
2. **Router active probes:** compare managed and direct canaries from the router;
   when sensitive mode is enabled, compare a sensitive canary with
   `hermes_vps`. These do not exercise a LAN device or remote client ingress.
3. **Real client acceptance:** from a selected client, test a direct destination,
   a general managed destination and a sensitive destination through each
   enabled ingress. Confirm exit identity and DNS/IPv6 behavior; test the actual
   app transfer, not only TCP/TLS setup. For M, test the service's own API/media
   path. Store raw observations privately. C1 native Naive remains dependent on
   a compatible client; an idle listener is not a client proof.

For each real-client result record the channel, client app/version, network
(home Wi-Fi or external), policy mode, time, expected and observed exit *roles*,
whether DNS and IPv6 behaved as intended, and whether the app completed a real
request. Mark untested cells as **untested** rather than green. A report that
clients "seem fine" is an operator observation, not a measured leak test.

## What the LAN guard covers

The first `FORWARD` jump blocks direct IPv4 forwarding from `br0` to addresses
already in `STEALTH_DOMAINS` or `VPN_STATIC_NETS` for TCP and UDP/443. TCP is
normally captured earlier by NAT REDIRECT; the guard matters when that rule is
missing. It cannot classify a never-seen address, an app's independent DoH/DoT
answer, a hidden hostname, other UDP protocols or packets sent before Merlin
calls `firewall-start`. IPv6 is disabled/filtered under the current policy and
requires its own live acceptance check. These limits are reasons to verify
sensitive apps on real clients, not to add a blanket router-wide block without
proving its effect on domestic/direct traffic.

`cron-save-ipset` saves the dynamic set to a private temporary file and replaces
the last snapshot only after `ipset save` succeeds, emits the expected set
header and includes at least as many entries as the set held before saving.
A failed or short save leaves the previous snapshot available for boot recovery.
The dynamic set currently has no entry timeout; old addresses can remain after
DNS changes. Automatic expiry or flush is deferred because
removing an address before a client re-resolves it could send a still-managed
connection directly over the home WAN. Review domain/IP provenance and test a
staged policy before changing this behavior.

## Controlled recovery check

Before a router change, keep a verified encrypted local backup and an
independent management path. Run the local fixtures, the active deploy gate and
router-limited `99-verify.yml`. After deployment, repeat those checks and the
real-client acceptance above. The narrow idempotence drill is to invoke the
installed `firewall-start` once, then verify the first `FORWARD` guard, both
managed REDIRECT rules, managed UDP/443 drops, DNS capture, and the A/B/C/D/M
runtime checks. Check Amn separately: it is manually owned and a full Merlin
firewall rebuild requires an explicit Amn refresh.

This narrow drill does not simulate the interval before Merlin's hook or prove
behavior during a full `service restart_firewall`/reboot. A full rebuild needs a
separate maintenance window, a second access path and real-client probes before
and after; do not remove the guard or flush global firewall tables just to
produce a test. Keep the raw transcript and rollback snapshot in ignored local
reports. See [Channel A operations](../modules/routing-core/docs/channel-routing-operations.md#channel-a-redirect)
and [recovery boundaries](../SECURITY.md#recovery-boundaries).
