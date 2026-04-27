# Channel C Shadowrocket Handoff - 2026-04-27

## Context

This repo manages a home router/VPS stealth routing setup.

Current terminology:

- Channel A: primary router-managed `sing-box -> VLESS + Reality + Vision -> VPS`.
- Channel B: manual device-client fallback, `VLESS + XHTTP + TLS` on a standalone Xray service behind Caddy.
- Channel C: manual device-client fallback, Naive/HTTPS forward-proxy style profile on a separate VPS SNI hostname.
- Deprecated WireGuard cold fallback: previously used WireGuard path, disabled in steady state.

Channel A is still healthy according to `./verify.sh`; the only warning is stale blocked-list freshness, not a listener/routing failure.

## What Was Implemented

Channel B:

- New standalone `ansible/roles/xray_xhttp`.
- Xray-core image default: `ghcr.io/xtls/xray-core:26.3.27`.
- XHTTP listens on localhost only.
- Caddy terminates TLS for the Channel B hostname and reverse-proxies only the configured random path.
- Client artifacts are generated under `ansible/out/clients-channel-b/`.

Channel C:

- Extended `ansible/roles/caddy_l4` for Channel C backends.
- Initial Caddy `forward_proxy` backend remains available as `channel_c_naive_backend: caddy_forward_proxy`.
- Tried compatibility backend `stunnel_tinyproxy`.
- Tried compatibility backend `stunnel_squid`.
- Current deployed default is `channel_c_naive_backend: squid_tls`.
- Public `:443` remains owned by system Caddy.
- Caddy layer4 routes Channel C SNI directly to localhost-only Squid `https_port`.
- Squid handles authenticated HTTP CONNECT.
- Client artifacts are generated under `ansible/out/clients-channel-c/`.

Important generated profile for current iPhone testing:

```text
ansible/out/clients-channel-c/iphone-1-shadowrocket-positional.conf
ansible/out/clients-channel-c/iphone-1-shadowrocket-positional-conf.png
```

Do not commit generated `ansible/out` artifacts. They contain live profile secrets.

## Current Symptom

The iPhone Shadowrocket profile still appears not to provide working Internet to the user, even after the server-side backend was changed to Squid.

User-visible behavior:

- Shadowrocket shows `iphone-1-https-proxy` selected.
- Global Routing is set to `Proxy`.
- Shadowrocket Data log shows requests routed through the proxy, for example:
  - `api.ipify.org:443`
  - `www.google.com:443`
  - `clients4.google.com:443`
  - Apple/iCloud endpoints
- Request detail shows `APP: TCP Stream` and rule `ROUTING,PROXY # iphone-1-https-proxy`.
- Browser/app still reports no Internet or target sites do not open.

Earlier screenshots also showed iCloud Private Relay-like endpoints such as `mask.icloud.com` and `gateway.icloud.com`, so iOS Private Relay / Limit IP Address Tracking may still be involved.

## Server-Side Evidence

External curl using the generated HTTPS proxy URL succeeds from the local machine:

```bash
u="$(tr -d '\n' < ansible/out/clients-channel-c/iphone-1-shadowrocket-https.txt)"
curl -fsS --max-time 20 --proxy "$u" https://api.ipify.org
curl -fsS -o /dev/null -w '%{http_code}\n' --max-time 20 --proxy "$u" https://www.google.com/generate_204
curl -sS -o /dev/null --max-time 20 --proxy "$u" -v https://api.ipify.org
```

Observed results after switching to Squid:

```text
api.ipify.org returns the VPS public IP
www.google.com/generate_204 returns HTTP 204
CONNECT response is clean:
HTTP/1.1 200 Connection established
```

Current VPS services after the `squid_tls` switch:

```text
caddy: active
channel-c-squid: active
channel-c-stunnel: inactive
channel-c-tinyproxy: inactive
```

Current listeners after the `squid_tls` switch:

```text
Caddy public :443
Squid 127.0.0.1:18889
```

Current Caddy layer4 route sends Channel C SNI directly to Squid:

```text
@channel_c_naive tls sni <channel-c-host>
proxy 127.0.0.1:18889
```

Squid access log shows successful proxy tunnels for local curl:

```text
TCP_TUNNEL/200 CONNECT api.ipify.org:443
TCP_TUNNEL/200 CONNECT www.google.com:443
```

Earlier tinyproxy/stunnel logs showed that the iPhone did reach the VPS and opened upstream CONNECT tunnels. With Squid, re-check logs during a fresh iPhone attempt:

```bash
ssh deploy@<vps-ip> '
  echo SQUID_ACCESS
  sudo tail -120 /var/log/squid/channel-c-access.log
  echo STUNNEL
  sudo tail -120 /var/log/stunnel4/channel-c.log
  echo SERVICES
  sudo systemctl is-active caddy channel-c-squid channel-c-stunnel
'
```

## Verification Already Run

Static and syntax:

```bash
./tests/test-channel-bc-static.sh
cd ansible
ansible-playbook playbooks/10-stealth-vps.yml --syntax-check
ansible-playbook playbooks/99-verify.yml --syntax-check
```

Deploy and live checks:

```bash
cd ansible
ansible-playbook playbooks/10-stealth-vps.yml
ansible-playbook playbooks/99-verify.yml --limit vps_stealth
./verify.sh
ansible-playbook playbooks/30-generate-client-profiles.yml
```

Results:

- VPS deploy completed.
- `99-verify.yml --limit vps_stealth` passed.
- Channel B XHTTP container is running and localhost-only.
- Channel C Squid/stunnel backend is running and localhost-only.
- Channel A listener and Home Reality listener are OK.
- `./verify.sh` returns Warning only because blocked-list freshness is old.

## Open Questions For Next Debugger

1. Does a fresh iPhone attempt now produce `TCP_TUNNEL/200` entries in `/var/log/squid/channel-c-access.log`?
2. If yes, how many bytes are logged for failed browser requests? Are the tunnels closing immediately?
3. Is iCloud Private Relay or "Limit IP Address Tracking" still active for LTE/Wi-Fi?
4. Does Shadowrocket's built-in connectivity test succeed for the `iphone-1-https-proxy` server?
5. Does plain HTTP work through the profile, for example `http://neverssl.com`?
6. Does a non-Safari app/browser behave differently?
7. Does Shadowrocket need explicit SNI/Server Name for HTTPS proxy mode even when the Address is already the hostname?
8. Does importing the `.conf` profile create a subscription group that is selected but not actually used by the running VPN instance until toggled/restarted?

## Most Likely Remaining Areas

- iOS/Shadowrocket local VPN engine or profile import semantics.
- Private Relay / iCloud path interfering with CONNECT traffic.
- Shadowrocket HTTPS proxy field mapping: username/password may appear present in one import mode but not actually used in the active server.
- Need a packet-level view during one fresh iPhone attempt:

```bash
ssh deploy@<vps-ip> '
  sudo timeout 45 tcpdump -ni any \
    "(tcp port 443 or tcp port 18443 or tcp port 18889)" \
    -w /tmp/channel-c-iphone.pcap
'
```

Keep Channel A untouched while debugging Channel C. Channel C is manual device-client-only and should not alter router REDIRECT/DNS/TUN behavior.

## Update - Squid CONNECT Port 80

Fresh iPhone attempts after the Squid backend change showed many successful
authenticated tunnels, including:

```text
TCP_TUNNEL/200 CONNECT api.ipify.org:443
TCP_TUNNEL/200 CONNECT www.youtube.com:443
TCP_TUNNEL/200 CONNECT www.google.com:443
TCP_TUNNEL/200 CONNECT api.whatsapp.net:443
TCP_TUNNEL/200 CONNECT imap.gmail.com:993
```

The same log also showed `TCP_DENIED/403 CONNECT <ip>:80` for Telegram-like
destinations. Squid was denying `CONNECT` to port `80` before authentication
because the Channel C config allowed CONNECT only to TLS-ish ports. Since
Channel C is already authenticated and hidden behind the TLS/SNI wrapper, port
`80` is now included in the allowed CONNECT ports for compatibility.

## Update - Remove stunnel from Active Channel C Path

Fresh logs showed that Squid was returning many successful authenticated
`TCP_TUNNEL/200` responses with nonzero bytes, but stunnel kept logging
`TIMEOUTclose exceeded` on almost every connection. Local curl tolerated this,
but iOS/Shadowrocket still did not behave as expected.

Squid 6 on the VPS is built with GnuTLS and supports `https_port`, so Channel C
was changed again to remove stunnel from the active path:

```text
client -> Caddy :443 layer4 SNI -> Squid https_port on 127.0.0.1:18889 -> Internet
```

The same public hostname/profile should continue to work. Caddy still owns
public `:443`, and Squid remains localhost-only. The Caddy-managed Channel C
certificate/key are copied to `/etc/squid/channel-c-tls.{crt,key}` during deploy
for Squid TLS termination.

## Update - Plain HTTP Test Result

The `http://neverssl.com` test from iPhone produced `TCP_TUNNEL/200` in Squid
with nonzero byte counts, for example `CONNECT neverssl.com:80` with around
2 KB transferred. This proves:

- Shadowrocket is using the active Channel C profile.
- Basic auth is present and accepted.
- The public hostname/SNI reaches the correct Caddy route.
- Squid can connect upstream and return bytes to the iPhone.

Because the proxy path itself is working, the next applied changes target the
iOS/Shadowrocket profile behavior and app-port compatibility:

- Shadowrocket generated `.conf` profiles now use `bypass-system = false`.
- Shadowrocket generated `.conf` profiles use explicit public DNS instead of
  `system`.
- Squid allows additional common mobile/Cloudflare/FCM CONNECT ports, including
  `5228-5230`, because `mtalk.google.com:5228` was observed as denied.

## Update - Squid Dual-Stack Tuning

Fresh iPhone attempts continued to show authenticated `TCP_TUNNEL/200` entries
with nonzero bytes for `api.ipify.org`, `www.google.com`, `neverssl.com`,
Telegram, Google and Apple endpoints. This rules out missing auth, inactive
profile, Caddy SNI mismatch and local Squid listener failure.

The remaining server-side signal was intermittent `TCP_TUNNEL/503` entries after
long connect waits, including dual-stack/IPv6 upstream selections. Squid 6.14 no
longer supports `dns_v4_first`; a parse test reports the directive as obsolete.
The deployed-compatible mitigation is to keep Happy Eyeballs enabled but race the
spare address family quickly and fail bad upstream connects sooner:

```squid
connect_timeout 15 seconds
happy_eyeballs_connect_timeout 10
happy_eyeballs_connect_gap 10
```

If this still does not make Shadowrocket usable while Squid keeps logging
successful tunnels, the next high-signal path is to stop treating HTTPS proxy as
the long-term Channel C mobile profile and test a first-class mobile protocol:
VLESS+WS+TLS or Trojan on the Channel C hostname.
