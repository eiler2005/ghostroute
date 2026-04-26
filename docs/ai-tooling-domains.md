# Domain Families Reference: AI & Dev Tools

This document explains which domains each service uses and why they need to be routed through VPN. Useful when diagnosing issues or adding similar services.

All domains listed here belong in `configs/dnsmasq-stealth.conf.add`
(`STEALTH_DOMAINS`). That catalog feeds both LAN Channel B and mobile Home
Reality split routing. Legacy `VPN_DOMAINS` and per-domain VPN DNS upstream
rules are retired.

---

## How subdomain coverage works

A single `ipset=/github.com/VPN_DOMAINS` rule covers `github.com` **and all its subdomains** (`*.github.com`). You don't need to enumerate subdomains manually — dnsmasq handles this automatically.

Each service below lists only the **registrable domains** needed, not individual subdomains.

---

## GitHub

```
github.com          — web, git operations, OAuth, device flow
api.github.com      — REST/GraphQL API, GitHub CLI
githubstatus.com    — status page (appears in GitHub CLI errors)
githubusercontent.com     — raw files, release assets
raw.githubusercontent.com    — direct raw file access
objects.githubusercontent.com — LFS, release binary downloads
codeload.github.com — repository archive downloads (zip/tar.gz)
```

**Why separate `api.github.com`?** GitHub CLI uses `api.github.com` for all API calls. Without it, `gh` commands fail even if the web UI works.

---

## GitLab / Bitbucket / Azure DevOps

```
gitlab.com          — web, git operations
gitlab-static.net   — GitLab web UI static assets (CSS, JS, images)
bitbucket.org       — Bitbucket Cloud web and git operations
dev.azure.com       — Azure DevOps repos and pipelines
visualstudio.com    — legacy VSTS URLs, still used by some Azure DevOps links
```

---

## Anthropic / Claude

```
anthropic.com   — API (api.anthropic.com), console, docs
claude.ai       — Claude web app
claude.com      — claude.com redirect and assets
```

All subdomains of each domain are covered automatically.

---

## OpenAI / ChatGPT

```
openai.com        — API (api.openai.com), platform, auth
chatgpt.com       — ChatGPT web app
oaistatic.com     — OpenAI static assets and CDN
oaiusercontent.com — user-uploaded content (images in chats, file uploads)
```

---

## Google AI Studio / Gemini API / NotebookLM

```
google.com                          — Google sign-in, base domain
aistudio.google.com                 — AI Studio web app
notebooklm.google.com               — NotebookLM web app
ai.google.dev                       — Google AI developer docs and tools
generativelanguage.googleapis.com   — Gemini API endpoint
```

**Note**: `aistudio.google.com` and `notebooklm.google.com` are subdomains of `google.com`, so technically covered by the `google.com` rule. They are listed separately in the config for explicitness. `generativelanguage.googleapis.com` requires its own rule because `google.com` does not cover `googleapis.com`.

---

## YouTube

```
youtube.com             — main site
youtu.be                — short URL redirects
googlevideo.com         — video stream delivery (primary CDN)
ytimg.com               — thumbnails, images, UI assets
ggpht.com               — legacy image CDN (still used for some thumbnails)
youtubei.googleapis.com — YouTube internal API (used by the player)
youtube.googleapis.com  — YouTube Data/API calls used by apps
jnn-pa.googleapis.com   — YouTube playback/network assistant endpoint
www.googleapis.com      — generic Google API host used by iOS YouTube flows
youtube-nocookie.com    — embedded/privacy-enhanced player variant
```

**Why so many domains?** YouTube's video delivery is split across several CDNs. Without `googlevideo.com`, the page loads but videos won't play. Without `youtubei.googleapis.com`, the player won't initialize in some clients.

---

## Telegram

Telegram is a special case — see [telegram-deep-dive.md](telegram-deep-dive.md) for full details.

**Domain routing:**
```
telegram.org / telegram.com / t.me / telegram.me
telegra.ph / telesco.pe / tg.dev
cdn-telegram.org / telegram-cdn.org
fragment.com / graph.org / contest.com / comments.app
usercontent.dev / tdesktop.com
```

**Static IP routing** (Telegram uses direct IP connections, bypassing DNS):
ASN-based CIDR ranges in `configs/static-networks.txt` → `VPN_STATIC_NETS` ipset.

---

## Smithery (MCP Registry)

```
smithery.ai — MCP (Model Context Protocol) server registry
```

Smithery is the main registry for Claude MCP servers — discovery and installation happen through `smithery.ai`.

---

## Adding a New Service

When a service doesn't work after adding its main domain, diagnose with:

```bash
# Check dnsmasq log for what domains the service queries
tail -f /opt/var/log/dnsmasq.log | grep 'query\[A\]'

# Then check if those IPs made it into the ipset
ipset list VPN_DOMAINS | grep <IP>

# Check current paths
iptables -t nat -vnL PREROUTING | grep 'redir ports <lan-redirect-port>'
ip route get <IP> mark 0x1000
```

Common patterns:
- **App loads but content fails** → missing CDN domain (check for `*.cdn-*` or `*.static.*` queries)
- **Auth fails** → missing auth subdomain (often `accounts.`, `auth.`, or `sso.` + main domain)
- **API works, web UI fails** → missing static asset CDN (often a separate domain like `oaistatic.com`)
- **DNS resolves but connection fails** → service may be blocked at IP level, not DNS → check if service needs static IP routing

## Operational validation after adding AI/dev domains

После добавления нового AI/dev service-family полезно проверить не только `ipset`, но и общий operational picture:

```bash
./verify.sh
./modules/traffic-observatory/bin/traffic-report
./modules/ghostroute-health-monitor/bin/router-health-report
```

Что смотреть:

- `Routing Health`
  - на месте ли `STEALTH_DOMAINS`, REDIRECT `:<lan-redirect-port>`, home Reality `:<home-reality-port>`, DNS через `127.0.0.1:<dnscrypt-port>`
  - отсутствуют ли legacy `VPN_DOMAINS`, `RC_VPN_ROUTE` и `0x1000`
- `Catalog Capacity`
  - не вырос ли `STEALTH_DOMAINS` неожиданно сильно после нового семейства
  - что пишет `Growth Trends` / `Growth note`
- `Traffic Snapshot`
  - начал ли сервис реально давать Reality-managed трафик
- `Device Traffic Mix`
  - не ушёл ли тестируемый клиент в direct `WAN`

Если нужно сохранить понятный snapshot для следующего агента/LLM:

```bash
./modules/ghostroute-health-monitor/bin/router-health-report --save
```

Это обновит local `reports/router-health-latest.md` и одновременно сохранит sanitised copy на USB-backed storage роутера.
