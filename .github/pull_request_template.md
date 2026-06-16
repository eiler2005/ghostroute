## Summary

-
-

## Scope

Touched areas:

-

Runtime impact:

- [ ] Docs-only / no runtime behavior changed
- [ ] Console read-only UI/API/read-model change
- [ ] Router data plane / sing-box / dnsmasq / iptables
- [ ] VPS edge / Caddy / Xray / Reality
- [ ] Ansible / deploy / generated artifacts
- [ ] Traffic Observatory / machine contract
- [ ] Secrets / Vault / local operator files

## Tests

Run:

```bash

```

Not run, and why:

-

## Risk and rollback

Blast radius:

-

Rollback path:

-

Safety tag needed before deploy?

- [ ] No
- [ ] Yes: `pre-<change-name>-<YYYY-MM-DD>`

## Secrets and public-safety check

- [ ] No real endpoints, listener ports, credentials, UUIDs, Reality keys, short IDs, admin paths, QR payloads, VLESS URIs, provider details or personal device identifiers are included.
- [ ] Generated artifacts under `ansible/out/`, local reports and private operator notes remain gitignored.
- [ ] Public examples use placeholders only.
