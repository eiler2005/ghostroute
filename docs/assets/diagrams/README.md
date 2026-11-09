# Architecture diagram assets

Architecture images are embedded in Markdown as PNG files, following the existing
GhostRoute architecture maps in this directory. Current topology diagrams have
editable, self-contained HTML sources with inline SVG. The raster cover is a
conceptual illustration; routing details come from the SVG sources and runbooks.

## Platform diagrams

[English source](ghostroute-platform-en.html) ·
[Русский исходник](ghostroute-platform-ru.html)

| Figure | Русский PNG | English PNG | Meaning |
|---|---|---|---|
| Routing | [RU](ghostroute-routing-ru.png) | [EN](ghostroute-routing-en.png) | Home-first ingress, sensitive precedence, general managed exit and home-WAN direct exit; isolated Amn projection and separate M service path. |
| Lifecycle | [RU](ghostroute-lifecycle-ru.png) | [EN](ghostroute-lifecycle-en.png) | Merlin, supervisor and deploy ownership; control arrows are distinct from packet paths; manual Amn and read-only Console boundaries. |
| Recovery | [RU](ghostroute-recovery-ru.png) | [EN](ghostroute-recovery-en.png) | Public code, private configuration, encrypted archives and independent download/hash/decrypt verification; no standby-router claim. |

These describe implemented mechanisms and their supported scope, not a live
deployment snapshot. Remaining acceptance work is tracked separately in the
[engineering register](../../routing-assurance-roadmap.md).

## Channel Amn diagrams

The detailed manual-lab figures have their own source pages:

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

The older `ghostroute-routing-en.png`,
`ghostroute-lifecycle-en.png` and `ghostroute-routing-ru.png` remain
historical illustrations for earlier review references. They are not current
topology specifications; use the platform figures above for current docs.

## Project visual convention

The style reference is the historical `ghostroute-routing-en.png`:
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
