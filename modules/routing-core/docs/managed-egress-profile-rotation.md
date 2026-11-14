# Router-only managed egress profile rotation

An external backend profile belongs to the router's outbound connection. It is
separate from the Home Reality, B/C/D and Amn client ingress identities. Replacing
this profile must preserve client endpoints, credentials, QR artifacts, routing
rules, DNS ownership and the dedicated sensitive/service paths.

## Supported reserve transports

The `backup_reality` role supports VLESS/Reality over either TCP or gRPC. The
role name and `reality-out` / `reality-out-d` tags remain stable. Owned backends
retain their existing TCP/Reality/Vision configuration.

| Vault field suffix after `vault_router_backup_reality_` | TCP | gRPC |
|---|---|---|
| `transport` | `tcp` (default) | `grpc` |
| `flow` | `xtls-rprx-vision` by default; use the reviewed profile | Empty string; no Vision |
| `grpc_service_name` | Unused | Exact exported service name |
| `alpn` | Empty list by default | Exported list including `h2` |

Both variants require the exported server, port, UUID, SNI, Reality public key
and short ID. Do not reinterpret a TLS-only export as Reality or assume every
gRPC profile uses TLS-only security. Transport and authentication must follow the
actual profile. These settings do not enable TLS-only or other VLESS transports.

## Preserve an inactive profile for a future return

Keep the reviewed TCP/Reality/Vision implementation and its regression fixtures
alongside the gRPC variant. Store each real outbound profile as a separate
encrypted, named operator artifact under ignored `secrets/`; include these files
and the staging instructions in the encrypted control-machine backup.

Restoration must merge only `vault_router_backup_reality_*` fields into the
current Vault. Restoring an entire old Vault could revert newer client keys,
management access and unrelated routing settings. Stage a new encrypted candidate,
verify all unrelated values remain equal, qualify the saved endpoint from the
router, then deploy the outbound and refresh any active Amn projection. Preserve
the currently working profile for rollback. Client QR regeneration is unnecessary.

A saved profile is recoverable configuration, not proof of an available service.
A retired or failing endpoint must pass qualification again before carrying traffic.

## TCP/Reality/Vision versus gRPC/Reality

| Layer | TCP profile | gRPC profile |
|---|---|---|
| Proxy protocol | VLESS | VLESS |
| Stream transport | Raw TCP | gRPC streams over HTTP/2 over TCP |
| Tunnel security | Reality | Reality in the supported external profile |
| Flow | Vision | No Vision |
| Transport-specific settings | No gRPC service name | Matching service name and `h2` ALPN |

gRPC adds HTTP/2 framing and stream multiplexing. It is not a replacement for
Reality and does not move the routing decision into HTTP. Sites still observe
the selected exit; the home ISP still sees the outer connection and its metadata.
This change alone proves neither improved DPI resistance nor better performance.
Measure latency, throughput and reconnection from the actual client network.
Additional framing and HTTP/2 stream management have a cost; losses on the
underlying TCP connection can delay its streams. Application HTTPS remains a
separate encrypted layer inside the tunnel.

See the official [gRPC transport documentation](https://xtls.github.io/config/transports/grpc.html)
and [sing-box transport fields](https://sing-box.sagernet.org/configuration/shared/v2ray-transport/).

## Qualification and deployment

1. Decode the new profile locally into private ignored storage. Validate its
   structure and keep an encrypted copy of the previous Vault. Do not publish
   the QR, URI, endpoint or a mapping from a backend role to its provider.
2. Stage the new Vault fields without changing ingress identities or selectors.
   Render the production template locally. Compare it with the live configuration;
   the intended runtime change is limited to the selected outbound. Preserve the
   sensitive outbound and Channel M exclusion.
3. Run the narrow routing/template tests, Telegram qualification fixtures and
   relevant Ansible syntax checks. The installed router binary must accept the
   candidate; version numbers alone do not prove transport compatibility.
4. Follow the [application egress qualification rule](../../ghostroute-health-monitor/docs/egress-qualification.md).
   Run an isolated authenticated candidate from the router before switching any
   client traffic. Verify complete HTTPS transfers, native application responses
   and an exit distinct from home WAN. A TCP or raw TLS handshake is insufficient.
5. Inspect the pre-deploy live report. An unavailable old backend needs a scoped
   recovery, not unrelated firewall or DNS changes. Save the runtime configuration,
   validate the staged replacement and atomically install only the reviewed change.
   Restarting sing-box interrupts its existing connections; retain a rollback copy
   and verify the service immediately.
6. If Amn is active, preserve its settings and client artifacts, regenerate its
   policy projection and perform the documented Amn stop/start. Verify its TUN,
   peer identities and the first LAN managed guard after restart.
7. Verify managed, direct and sensitive paths separately, as well as client
   ingress and DNS. Compare ingress and QR artifacts before/after. Refresh opted-in
   recovery snapshots and keep raw acceptance evidence in private reports. Real
   phone messages, media and reconnection remain a separate client acceptance step.

Rollback restores the saved outbound and matching Vault values, then refreshes
an active Amn projection. If the former backend has been retired, its saved
profile is not a working fallback: qualify another backend explicitly. Never
restore availability by falling through to direct for protected destinations.

## Four-channel acceptance boundaries

After a rotation, test the existing imports through their client-facing ingress,
not only the shared router SOCKS listener. For each lane, fetch a reviewed direct
IP checker, a managed IP checker and an unauthenticated sensitive API endpoint.
Compare direct and managed identities against independent router baselines.
An expected HTTP 401 proves an unauthenticated API response, not account access.

| Lane | Client-facing diagnostic | Additional acceptance |
|---|---|---|
| A | Existing Home Reality profile through a compatible VLESS/Reality client | LAN/Wi-Fi REDIRECT and actual mobile connection |
| B | Existing XHTTP profile with a certificate pinned from trusted router access | Imported-client certificate behavior remains a separate security boundary |
| C | Existing C1-Shadowrocket HTTPS CONNECT credentials with normal TLS validation | Native Naive requires its own compatible client; compatibility proof does not cover it |
| D | Existing HTTPS CONNECT profile, validated from an external network | Karing/Naive behavior, messages/media and reconnection on the real phone |

Record the test vantage. A working router-local relay does not prove that the
public ingress accepts clients. Conversely, failure from a home Mac against the
public endpoint is not proof of external failure: compare an external vantage
before attributing the issue to DNS, NAT loopback, client policy or ingress.
Keep exact endpoint and incident evidence private. Do not regenerate QR artifacts
as a diagnostic step.

## Local regression checks

```bash
bash tests/test-sensitive-sites.sh
python3 modules/ghostroute-health-monitor/tests/test-telegram-egress-check.py
bash tests/test-channel-a-deploy-static.sh
bash tests/test-channel-d-static.sh
bash tests/test-channel-amn.sh
cd ansible && ansible-playbook --syntax-check playbooks/20-stealth-router.yml
```

Fixtures cover legacy TCP defaults, gRPC without Vision, escaped service names,
ALPN requirements, pinned Channel D, unchanged ingress/routing and unchanged
owned/sensitive outbounds. The diagnostic profile builder uses the same transport
fields as production so qualification does not accidentally test the old transport.
