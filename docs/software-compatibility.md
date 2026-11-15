# Software compatibility and qualification

Reviewed baseline: 2026-11-15. Read this together with the
[version policy](runtime-inventory.md), [source target registry](../configs/software-versions.json)
and [per-role deployed inventory](../configs/vps-software-versions.json).
An installed version, successful configuration check and authenticated application
test are separate facts. A successful path does not qualify every backend.

| Combination | Evidence and status | Upgrade decision |
|---|---|---|
| Router sing-box 1.14.4 → `hermes_vps` Xray 26.6.1 | Existing sensitive HTTPS and native application probes passed after recovery; Caddy 2.11.9 also passed with this core | Retain qualified panel/core digest |
| Router sing-box 1.14.4 → candidate panel 3.11.0 / Xray 26.11.9 on `hermes_vps` | Sensitive HTTPS failed across A/B/C/D while ordinary and managed destinations worked. Returning the previous panel/core restored it; generated Xray configuration was identical | Not qualified for this path; do not promote based on syntax or process health |
| `primary_vps` panel 3.11.0 / Xray 26.11.9 and standalone XHTTP Xray 26.11.9 | Installed runtime and service checks passed. This does not qualify the primary REALITY backend as a replacement for the active managed backend | Keep role-specific qualification; no inferred failover approval |
| Owned VPS Caddy 2.11.9 with the retained sensitive core | Authenticated application checks passed after independent edge promotion | Edge and core may be upgraded independently |
| Router Snell lab sing-box 1.14.4, Snell v4 client semantics, ShadowTLS v3 strict | Isolated authenticated probes and QR payload round trips; physical-phone QR import and cellular acceptance remain pending | Experimental only; preserve separate production anyT |
| anyT production with current selected-client policy | Eight approved identities and native application probes passed | Preserve all issued imports and scoped recovery |
| Native Naive clients versus HTTPS CONNECT compatibility clients | HTTPS CONNECT success does not prove native Naive compatibility | Record client implementation/version and test separately |

The sensitive-path regression is consistent with the upstream
[REALITY ClientHello compatibility report](https://github.com/SagerNet/sing-box/issues/4520).
The report describes rejection of clients missing the expected hybrid key share.
Local rollback evidence identifies the failing panel/core combination; it does
not establish the precise handshake cause or prove all clients fail with that
Xray version. It is not evidence of provider DPI blocking.

## Reading the inventory

- `build_target` is the version a recipe would build; it is not deployment proof.
- `deployed_qualified` is scoped to the recorded role and tested path.
- A compatibility hold deliberately retains a working version. Review upstream
  fixes and security advisories before the next isolated qualification.
- `null` means the collector did not establish a version. In particular, do not
  infer the sensitive role's panel version from its bundled Xray version; the
  exact qualified image digest is private Vault material.
- Ubuntu OpenSSL/Python package revisions follow the distribution's security
  updates. Comparing only upstream major/minor numbers is insufficient.
- Application-owned Caddy images and persistent BuildKit workers are observed
  exclusions. A Docker Engine upgrade does not upgrade those containers.

The source registry is validated by `software-inventory --check`; per-role
observations are collected separately and reconciled with `vps_management`.
Neither file is an automatic updater. Preserve older dated evidence privately;
update a review date only after the corresponding review.

## Promotion and rollback

Test the candidate on an isolated listener using the actual router client engine
and its existing transport parameters. Exercise ordinary, managed and sensitive
HTTPS plus the application-native protocol; preserve authenticated identity and
TLS validation. Compare generated runtime configuration as well as stored panel
settings. Before promotion, retain the prior exact image and consistent database.
After promotion, repeat the same probes and the protected anyT checks. If they
regress, restore the compatible image/database pair and retain the failed
candidate as unqualified. Do not rotate issued QR profiles to conceal a regression.

Host reboot recovery, client data-plane acceptance and Console browser/performance
acceptance are independent gates. A green routing gate does not clear a failed
Console performance test or an interrupted host-management verification.
