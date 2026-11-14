# Architecture diagram assets

Architecture images are embedded in Markdown as PNG files, following the existing
GhostRoute architecture maps in this directory. Current topology diagrams have
editable, self-contained HTML sources with inline SVG. The raster cover is a
conceptual illustration; routing details come from the SVG sources and runbooks.

## Platform diagrams

The Mac application has its own [visual guide](ghostroute-guard-en.html)
([на русском](ghostroute-guard-ru.html)); it complements the platform maps below.

[English source](ghostroute-platform-en.html) ·
[Русский исходник](ghostroute-platform-ru.html)

| Figure | Русский PNG | English PNG | Meaning |
|---|---|---|---|
| Routing | [RU](ghostroute-routing-ru.png) | [EN](ghostroute-routing-en.png) | Home-first ingress including eight approved anyT imports; separate main/anyT processes, sensitive precedence, managed and home-WAN exits. Amn/legacy WireGuard are retained but disabled; M is separate. |
| Lifecycle | [RU](ghostroute-lifecycle-ru.png) | [EN](ghostroute-lifecycle-en.png) | Merlin/supervisor ownership and anyT's own boot/firewall/minute reconciliation; control arrows are distinct from packet paths; manual Amn and read-only Console boundaries. |
| Recovery | [RU](ghostroute-recovery-ru.png) | [EN](ghostroute-recovery-en.png) | Public code, private settings/issued QR/approval manifest, encrypted archives and independent download/hash/decrypt verification; client ZIP is not server recovery. |

These describe implemented mechanisms and their supported scope, not a live
deployment snapshot. Remaining acceptance work is tracked separately in the
[engineering register](../../routing-assurance-roadmap.md).

anyT is production for the issued profiles, with a
[protected compatibility contract](../../../AGENTS.md#channel-anyt-protected-production-contract).
The lifecycle figure shows bounded polling, not uninterrupted sessions or an
automatic backend switch. Its controller repairs missing known firewall rules;
unexpected owned-chain contents require review. See the
[runbook](../../../modules/routing-core/docs/channel-anytls-lab.md) for the exact
status and maintenance checks. The diagrams never contain real QR or fingerprints.

Managed Reality egress is transport-specific: owned profiles use TCP/Vision;
the external role also supports gRPC/Reality without Vision. The general routing
and Amn traffic figures show this distinction; the sensitive owned path retains
Vision. See the [transport comparison](../../../modules/routing-core/docs/managed-egress-profile-rotation.md).
The legacy `ghostroute-architecture.png` filename is an alias of the current
English routing figure, replacing the retired single-egress illustration.

## Mac Guard diagrams and cover

[Русские исходники](ghostroute-guard-ru.html) · [English sources](ghostroute-guard-en.html)

| Figure | Русский PNG | English PNG | Meaning |
|---|---|---|---|
| Chrome routing | [RU](ghostroute-guard-routing-ru.png) | [EN](ghostroute-guard-routing-en.png) | Catalog-first mandatory Guard path and preserved external PAC/ordinary path for other destinations. |
| Components | [RU](ghostroute-guard-components-ru.png) | [EN](ghostroute-guard-components-en.png) | SwiftUI, local engine, Native Messaging, extension, private profile and bounded memory journal; control arrows are not packet paths. |
| Access states | [RU](ghostroute-guard-states-ru.png) | [EN](ghostroute-guard-states-en.png) | Blocked, checking, protected and paused states; failure/expiry closes admission and Resume requires qualification. |

These are `1280 × 720` editable HTML/SVG figures with `2560 × 1440` PNG exports.
They use the existing project palette and intentional offline Arial/Helvetica
and Menlo/Consolas typography, not downloaded fonts. Rebuild and check with:

```bash
python3 modules/mac-privacy-guard/tools/build-diagrams.py
node modules/mac-privacy-guard/tools/render-diagrams.cjs
```

The renderer reuses an existing Playwright installation; `GUARD_PLAYWRIGHT`
can point to an isolated one and `GUARD_DIAGRAM_BROWSER=chromium` selects its
installed Chromium instead of local Chrome. It does not install dependencies.
It checks accessible titles, label bounds, connector clearance, label masks,
complexity, mobile-local scrolling and print layout. The module CI runs this
check and preserves its geometry report; fixture results contain no live data.

Fidelity: router transport/policy/backend detail is combined into one qualified
path on the routing figure. Optional-browser and prepared-DevTools details are
summarized in captions on the component figure; they remain in the module docs.
Periodic renewal is a note on the state figure, not a separate state. None of
the figures claims whole-tab/OS isolation or a live provider-country sync.

[`guard-cover.png`](../../../modules/mac-privacy-guard/assets/guard-cover.png)
is a new conceptual illustration generated with the **built-in GPT Image tool**,
copied into the module assets without modifying the generated original. It is
decorative artwork, not a screenshot or routing specification. Existing project
covers and the application's icon remain separate assets.

Final cover prompt:

> Use case: stylized-concept. Asset type: wide GitHub documentation cover for the existing GhostRoute Guard Mac application. Create a polished editorial technical illustration, landscape roughly 3:1. Bright white paper background, navy ink, pale-blue surfaces, restrained cobalt accents, a small mint shield accent. Main subject: elegant generic aluminum Mac laptop with a minimal native desktop window and a simple shield symbol; a small home router and abstract remote server form around it, joined only by fine visual threads without arrowheads. Ample whitespace, precise soft 3D geometry combined with clean flat vector-like details, subtle tactile shadows, premium macOS application feel. The sole text is exactly 'GhostRoute Guard', large, crisp, dark navy sans serif. No other text, no browser logos, no real UI screenshot, no IP addresses, ports, providers, flags, country names, credentials, maps or identifiable devices. Do not imply absolute security or system-wide protection. This is a conceptual cover illustration, not a technical routing diagram. Balanced composition suitable for a README banner and coordinated with white/navy/cobalt architecture diagrams.

## Channel Amn diagrams

The detailed manual-lab figures describe the retained optional Amn runtime when
explicitly enabled. Amn is disabled in steady state and is not an anyT dependency.
They have their own source pages:

[Русские схемы](channel-amn-architecture.html) ·
[English diagrams](channel-amn-architecture-en.html)

Each figure has a complete Russian and English version, including its labels,
legend, accessible title/description and explanatory caption. The two source
pages link to each other. Technical identifiers stay identical in both languages.

| Figure | Русский PNG | English PNG | Meaning |
|---|---|---|---|
| Traffic | [RU](channel-amn-traffic-ru.png) | [EN](channel-amn-traffic-en.png) | iPhone enters home over AmneziaWG; sensitive, managed and direct exits remain distinct. |
| Runtime | [RU](channel-amn-runtime-ru.png) | [EN](channel-amn-runtime-en.png) | Entware/RAM storage, separate processes and interface-scoped rules, policy-process failure containment. |
| Profiles | [RU](channel-amn-profiles-ru.png) | [EN](channel-amn-profiles-en.png) | Eight named imports, preserved bootstrap identity, explicit additive peer sync and private backup. |

## Source and rendering

Edit the corresponding SVG in both language sources, then export only its bounding box
to its matching language-suffixed PNG. Keep topology, status and limitations
equivalent across languages. Each figure uses a `1280 × 720`
viewBox; the committed PNGs are rendered at device scale factor 2
(`2560 × 1440`). The source SVG IDs match the PNG filename stems.

For Playwright export, copy the selected SVG and page styles into an isolated
browser page. Set its CSS size to `1280px × 720px`, place it at the page origin,
wait for `document.fonts.ready`, and capture an exact `1280 × 720` CSS-pixel clip
at scale factor 2. This avoids subpixel rounding from the source page's scrolling
containers. Keep normal horizontal scrolling in the source page.
The repository's existing Playwright dependency and a compatible local browser
are sufficient. No router/VPS access is required.

For the six platform figures, run from the repository root after the Console's
existing development dependencies and local Chrome are available:

```bash
node docs/assets/diagrams/render-platform.cjs
```

The renderer exports the PNGs and checks label bounds, connector clearance,
legend overlap, complexity budgets, mobile scrolling and print sizing. Its
local report is ignored under `reports/diagram-checks/`. Visually inspect the
rendered figures as well; geometry checks do not establish routing correctness.

## Generated cover

[`ghostroute-cover.png`](ghostroute-cover.png) was generated with the built-in
GPT Image tool and saved into this directory. It is decorative artwork, with no
protocol labels or arrows that could be mistaken for a routing specification.
The composition uses the same project palette as the technical diagrams.

Prompt brief used for the cover:

> A polished wide 3:1 GitHub project hero for GhostRoute, on white paper with
> navy ink, pale blue surfaces and restrained cobalt accents. A home router
> inside a simple house, laptop and phone on the left, two abstract cloud/server
> forms on the right, connected by subtle threads without arrowheads. Clean
> editorial technical illustration with generous whitespace. The only text is
> "GhostRoute". No protocols, IP addresses, ports, flags, keys, security seals,
> or claims of absolute protection.

Legacy raster snapshots have been retired; the editable platform sources and
matching exports above are the maintained public illustrations.

## Project visual convention

The project visual convention follows `ghostroute-routing-en.png`:
white paper, navy titles, pale blue layer zones, outlined rounded rectangles,
sans-serif names, monospaced technical labels and orthogonal connectors.
Raster references do not identify exact original font families; the editable
diagram sources use intentional local Arial/Helvetica and Menlo/Consolas fallbacks,
with no remote fonts or assets.

| Role | Diagram token |
|---|---|
| Paper | `#ffffff` |
| Zone surface | `#f8fbff` |
| Ink | `#0b172a` |
| Secondary text/connectors | `#475569` |
| Borders | `#cbd5e1` |
| Focal integration/policy | `#1d4ed8` |
| Focal fill | `#eff6ff` |

Keep the image and source synchronized. Check text bounds, connector clearance,
accessible SVG titles/descriptions, readable mobile scrolling and print clipping
after editing. Use role names and generic runtime paths only; never put real
endpoints, provider identities, ports, keys, QR payloads or traffic evidence in
these public assets.

The Amn figures describe the current manual lab. They must not imply production
boot ownership, automatic failover, AWG 3.1 client compatibility or proven
eight-client throughput.
