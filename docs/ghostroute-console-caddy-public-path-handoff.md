# GhostRoute Console Public Caddy Path Handoff

Date: 2026-04-30

This note is for the next agent/debugging pass. The Console application and
SQLite selectors are now fast; the remaining blocker is the public Caddy path
for larger HTML/JSON responses.

## Current Status

- Local prod-like test data was generated with roughly:
  - 120k normalized flow rows.
  - 80k event rows.
  - 40k route decision rows.
  - 20k snapshot files.
- Local production-mode smoke on that dataset passed:
  - `/traffic` around 0.3s.
  - `/clients` around 0.1s.
  - `/live` around 0.5s.
  - `/reports` and LLM-safe export respond.
  - route export now works with stable `flow:<rowid>` ids.
- On the VPS, direct Console upstream is also fast:
  - direct Console HTTP upstream `/traffic` around 0.7s.
  - `/clients` around 0.2s.
  - `/live` around 0.6s.
  - `/reports` around 0.5s.
- The Console container is healthy.
- The old malformed SQLite database was quarantined/reset during deploy.
- Small public API responses through Caddy work:
  - `/api/health`
  - `/api/flows?page=1&pageSize=3`
  - `/api/clients?page=1&pageSize=3`
  - `/api/live?page=1&pageSize=3`

## Remaining Blocker

The public HTTPS Console route through Caddy returns HTTP 200 and the first
roughly 16 KiB of larger responses, then the connection hangs until client
timeout. This affects larger responses such as:

- `/traffic`
- `/clients`
- `/live`
- `/reports`
- `/api/reports/llm-safe`

The same routes complete quickly when called directly against the local Console
upstream on the VPS. This points away from SQLite/Next selectors and toward the
Caddy public transport path for chunked or larger responses.

## Caddy Context

The global Caddy config currently has a `:443` server with `listener_wrappers`
for Reality/layer4 traffic:

```caddy
{
    servers :443 {
        protocols h1 h2
        listener_wrappers {
            layer4 {
                matching_timeout 15s
                @reality tls sni gateway.icloud.com
                route @reality {
                    proxy 127.0.0.1:8443
                }
            }
            tls
        }
    }
}
```

The Console route lives in `/etc/caddy/Caddyfile` under the managed block:

```caddy
# BEGIN GHOSTROUTE CONSOLE READONLY
https://<console-host> {
    log ghostroute_console {
        output stdout
        format json
    }

    basic_auth {
        <user> <bcrypt-hash>
    }

    header {
        X-Robots-Tag "noindex, nofollow"
        Referrer-Policy "no-referrer"
    }

    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
        header_up Connection close
        transport http {
            keepalive off
        }
    }
}
# END GHOSTROUTE CONSOLE READONLY
```

The actual public host and Basic Auth credentials are intentionally not tracked
in git. Use the ignored runtime/auth note or vault-managed deployment variables.

## Tried Already

These Caddy route changes were tried and did not fix the public hang:

- Removed `encode zstd gzip`.
- Added `reverse_proxy { flush_interval -1 }`.
- Added `transport http { keepalive off }`.
- Added `header_up Connection close`.

The symptom stayed the same: public clients receive the first chunk of a larger
response and then wait until timeout.

## Suggested Next Debug Steps

1. Confirm whether the issue reproduces from the VPS itself through the public
   Caddy host and through `--resolve <console-host>:443:127.0.0.1`.
2. Compare with direct upstream on the VPS:
   - direct upstream should finish quickly and return the full body.
   - public Caddy path currently hangs on larger responses.
3. Test a temporary separate clean listener or host route for Console without
   the global `listener_wrappers` interaction.
4. If that fixes it, move Console to a clean dedicated listener/sidecar or
   restructure the Caddy config so Console public HTTPS is not affected by the
   Reality/layer4 wrapper.
5. After any Caddy change, smoke-test both Console and neighboring services.

## Do Not Break Neighboring Projects

The VPS hosts other production-ish services. Do not restart or reconfigure them
unless absolutely necessary:

- OpenClaw gateway.
- Omniroute.
- maxtg/maxgram bridge.
- AgentMail bridges.
- Signals bridge.
- Wiki import.
- LightRAG.
- Xray/Reality services.
- Integration Redis.

Constraints:

- Do not make router runtime changes.
- Do not change router firewall or routing.
- Do not touch Channel A/B/Reality routing semantics.
- Do not restart the whole Docker host.
- Do not run broad `docker compose down` against shared projects.
- Do not change global Caddy listener behavior unless the effect on
  Reality/Channel B is understood and verified.
- Prefer changing only the Console Caddy route, or isolating Console behind a
  dedicated clean listener/sidecar.
- After any Caddy change, verify that Console, OpenClaw, maxtg/maxgram, Xray,
  and Xray-XHTTP containers are still running.
- Console must remain read-only relative to router runtime.

## Safety Notes

- Do not commit public credentials, router keys, private endpoints, private IPs,
  generated profiles, QR payloads, UUIDs, or secrets.
- The router remote key is stored outside git and should remain runtime
  secret/vault-managed.
- The current task is only to fix the public proxy path for GhostRoute Console.
  Backend Console performance has already been verified.
