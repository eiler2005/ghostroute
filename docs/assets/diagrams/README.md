# Architecture diagram assets

Architecture images are embedded in Markdown as PNG files, following the existing
GhostRoute architecture maps in this directory. The Channel Amn figures also have
an editable, self-contained HTML source with inline SVG:

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

Edit the corresponding SVG in `channel-amn-architecture.html` (RU) and
`channel-amn-architecture-en.html` (EN), then export only that SVG's bounding box
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

## Project visual convention

The visual reference is the existing `ghostroute-architecture-concept.png`:
white paper, navy titles, pale blue layer zones, outlined rounded rectangles,
sans-serif names, monospaced technical labels and orthogonal connectors.
Raster references do not identify exact original font families; the editable
Amn source uses intentional local Arial/Helvetica and Menlo/Consolas fallbacks,
with no remote fonts or assets.

| Role | Amn token |
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

The figures describe the current manual Amn lab. They must not imply production
boot ownership, automatic failover, AWG 3.1 client compatibility or proven
eight-client throughput.
