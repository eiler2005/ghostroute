# Managed Domain App-Family Draft

Status: draft / operator review; the first machine-readable runtime catalog now
lives in `modules/traffic-intelligence/lib/app-family.mjs`.

Source: `configs/dnsmasq-stealth.conf.add`, active `STEALTH_DOMAINS` entries.
Scope: classify the current managed domain catalog into app families and traffic
roles for Console attribution. The markdown remains the human review surface;
the runtime catalog is intentionally small, conservative and explanatory only.
It does not change routing.

The intent is to keep routing policy separate from traffic explanation:

- `app_family`: user-visible product or ecosystem.
- `app_category`: broad usage class.
- `traffic_role`: whether the domain usually represents user-facing traffic,
  background/system traffic, analytics/tracker traffic, shared CDN/provider
  fallback, or diagnostics.
- `confidence`: how safe the attribution is from the domain alone.

The draft covers 243 managed domains from the active catalog. Runtime app-family
classification keeps factual byte rows separate from DNS popularity. Console may
also build an explicitly inferred attribution layer for selected-client
aggregate residual bytes, but those rows must carry estimated/inferred metadata
and must not be presented as exact per-domain byte accounting.

## Families

| App family | App category | Traffic role | Confidence | Domains / patterns |
| --- | --- | --- | --- | --- |
| Managed split diagnostics | network_diagnostics | diagnostics | high | `ipify.org`, `browserleaks.com`, `browserleaks.net`, `browserleaks.org`, `ifconfig.me`, `ipinfo.io`, `maxmind.com`, `speedtest.net` |
| YouTube | video_streaming | client | high | `youtube.com`, `youtu.be`, `googlevideo.com`, `ytimg.com`, `ggpht.com`, `youtubei.googleapis.com`, `youtube.googleapis.com`, `youtube-nocookie.com` |
| YouTube / Google media support | video_streaming_support | client | medium | `jnn-pa.googleapis.com`, `www.googleapis.com`, `googleusercontent.com`, `gstatic.com` |
| Google / Google AI | ai_search_platform | client | medium | `google.com`, `googleapis.com`, `aistudio.google.com`, `notebooklm.google.com`, `ai.google.dev`, `generativelanguage.googleapis.com` |
| OpenAI / ChatGPT | ai_assistant | client | high | `openai.com`, `chatgpt.com`, `oaistatic.com`, `oaiusercontent.com`, `searchgpt.com`, `sora.com` |
| Anthropic / Claude | ai_assistant | client | high | `anthropic.com`, `claude.ai`, `claude.com` |
| Other AI tools | ai_assistant | client | high | `copilot.microsoft.com`, `deepl.com`, `elevenlabs.io`, `grok.com`, `manus.im`, `x.ai`, `composer.opera-api.com` |
| AI / MCP tooling | developer_ai_tools | client | medium | `smithery.ai`, `cobalt.tools`, `wisprflow.ai`, `api.wisprflow.com`, `wisprflow.onelink.me` |
| GitHub | developer_platform | client | high | `github.com`, `api.github.com`, `githubstatus.com`, `raw.githubusercontent.com`, `objects.githubusercontent.com`, `githubusercontent.com`, `codeload.github.com` |
| GitLab / Bitbucket / Azure DevOps | developer_platform | client | high | `gitlab.com`, `gitlab-static.net`, `bitbucket.org`, `dev.azure.com`, `visualstudio.com` |
| Developer / SaaS tools | developer_saas | client | medium | `atlassian.com`, `bintray.com`, `datacamp.com`, `hackernoon.com`, `harvestapp.com`, `jetbrains.com`, `netpeaksoftware.com`, `redis.io`, `redislabs.com`, `semrush.com`, `splunkcloud.com`, `tableau.com`, `tableausoftware.com`, `tableauusercontent.com` |
| Hosting / cloud providers | provider_or_admin | provider_fallback | medium | `cloudflare.com`, `digitalocean.com`, `hetzner.com`, `console.hetzner.com`, `hetzner.cloud`, `hostinger.com` |
| Telegram | messenger | client | high | `telegram.org`, `telegram.com`, `t.me`, `telegram.me`, `telegra.ph`, `telesco.pe`, `tg.dev`, `cdn-telegram.org`, `telegram-cdn.org`, `fragment.com`, `graph.org`, `contest.com`, `comments.app`, `usercontent.dev`, `tdesktop.com`, `tx.me`, `telega.one`, `telegram.dog`, `telegram.space` |
| WhatsApp | messenger | client | high | `whatsapp.com`, `whatsapp.net`, `wa.me`, `wl.co` |
| imo Messenger | messenger | client | high | `imo.im` |
| Discord | messenger_voice | client | high | `discord.com`, `discord.gg`, `discord.media`, `discordapp.com`, `discordapp.net` |
| Instagram / Meta | social_media | client | high | `instagram.com`, `instagram.net`, `ig.me`, `cdninstagram.com`, `fbcdn.net`, `fbsbx.com`, `facebook.com`, `facebook.net`, `fb.com`, `messenger.com`, `meta.com`, `threads.net` |
| X / Twitter | social_media | client | high | `twitter.com`, `x.com`, `twimg.com`, `t.co` |
| TikTok / ByteDance | short_video_social | client | high | `tiktok.com`, `tiktokv.com`, `tiktokcdn.com`, `tiktokcdn-us.com`, `tiktokcdn-eu.com`, `byteoversea.com`, `ibytedtos.com`, `byteimg.com`, `muscdn.com`, `ttwstatic.com` |
| LinkedIn | social_professional | client | high | `linkedin.com` |
| Twitch | live_streaming | client | high | `twitch.tv`, `ttvnw.net` |
| Apple media / iCloud | apple_ecosystem | mixed_client_system | medium | `podcasts.apple.com`, `apps.apple.com`, `mzstatic.com`, `itunes.apple.com`, `aaplimg.com`, `media.apple.com`, `account.apple.com`, `appleid.cdn-apple.com`, `idmsa.apple.com`, `gsa.apple.com`, `icloud.com`, `icloud.apple.com`, `icloud.com.cn`, `icloud-content.com`, `apple-cloudkit.com`, `apple-livephotoskit.com`, `apzones.com`, `cdn-apple.com`, `gc.apple.com`, `iwork.apple.com` |
| Apple DNS / relay | apple_system_privacy | service_system | high | `doh.dns.apple.com`, `apple-relay.apple.com` |
| Podcasts / audio distribution | podcast_audio | client | medium | `acast.com`, `acast.cloud`, `omny.fm`, `tritondigital.com`, `podtrac.com`, `pscrb.fm` |
| Spotify | audio_streaming | client | medium | `scdn.co`, `spotifycdn.com` |
| Microsoft / Xbox | microsoft_services | mixed_client_system | medium | `user.auth.xboxlive.com`, `xsts.auth.xboxlive.com` |
| Productivity / knowledge tools | productivity | client | high | `canva.com`, `canva.dev`, `notion.com`, `notion.site`, `notion.so`, `notionusercontent.com`, `medium.com`, `quora.com`, `kahoot.com`, `kahoot.it` |
| Forums / communities | community_forum | client | medium | `4pda.ru`, `4pda.to`, `patreon.com`, `skladchik.com`, `skladchina.biz`, `tronlink.org`, `strava.com` |
| Books / torrents / media sites | media_content | client | medium | `flibusta.is`, `flibusta.net`, `flibusta.site`, `hdrezka.ag`, `kinozal.tv`, `rezka.ag`, `rutor.info`, `rutor.is`, `rutracker.org`, `seasonvar.ru`, `x-minus.pro`, `livetv.sx`, `mixcloud.com`, `ign.com`, `premierleague.com` |
| News / public-interest media | news_media | client | high | `euronews.com`, `grani.ru`, `gulagu.net`, `holod.media`, `meduza.io`, `navalny.com`, `novaya.no`, `novayagazeta.eu`, `novayagazeta.ru`, `ntc.party`, `proekt.media`, `thebell.io` |
| Shopping / consumer services | shopping_consumer | client | medium | `aol.com`, `api2.support-kp.com`, `cub.red`, `dyson.com`, `iherb.com`, `ikea.com`, `intel.com`, `proton.me`, `realguide.com`, `setapp.com` |
| VPN / network app | network_app | client | medium | `<provider-site-domain>` |
| KONAMI / eFootball | game | client | high | `konami.com`, `konami.net`, `my.konami.net.edgekey.net`, `my1.konami.net.edgekey.net`, `account-applb-1040330410.ap-northeast-1.elb.amazonaws.com`, `pes22-prd-lb-1361062069.us-west-2.elb.amazonaws.com`, `efootball-prod-frontdoor-endpoint-user-b9fpgxfschepghg7.z01.azurefd.net`, `efootball-prod-frontdoor-endpoint-user-api-eseddha0a8esekda.z01.azurefd.net`, `efootball-prod-cdn-ms.azureedge.net`, `efootball-prod-cdn-ms.afd.azureedge.net`, `d2fbzftqq66qjv.cloudfront.net`, `eu-irl-00001.s3.dualstack.eu-west-1.amazonaws.com` |
| Mobile / casual games | game | client | high | `anzu-us.com`, `clashofclans.com`, `game-assets.clashofclans.com`, `game.boombeachgame.com`, `game.clashofclans.com`, `gameloft.com`, `supercell.com` |

## Review Notes

- `googleapis.com`, `googleusercontent.com`, and `gstatic.com` are broad
  support domains. They should not be blindly labeled as YouTube unless the
  observed hostname or DNS-linked evidence matches a YouTube-specific pattern.
- `facebook.com`, `facebook.net`, `fbcdn.net`, `fbsbx.com`, and `meta.com` can
  represent Instagram, Facebook, Messenger, Threads, WhatsApp-adjacent media, or
  Meta shared infra. Treat the family as `Instagram / Meta` unless a more
  specific domain is available.
- imo Messenger media can use direct PageBites IP ranges in addition to
  `imo.im` DNS names. Keep those as static managed CIDRs in
  `configs/static-networks.txt`; do not split `cdn*.imo.im` into separate
  managed-domain entries.
- Apple domains mix user-facing media/iCloud and service/system behavior.
  `doh.dns.apple.com` and `apple-relay.apple.com` should stay service/privacy
  signals; `podcasts.apple.com`, `apps.apple.com`, and iCloud content are more
  user-facing.
- Provider/admin domains such as `cloudflare.com`, `digitalocean.com`,
  `hetzner.com`, and exact cloud hostnames should remain provider fallback or
  app-specific only when the catalog comment identifies a concrete product.
- The KONAMI/eFootball exact cloud hostnames are app-specific despite being
  hosted under AWS/Azure/Akamai/CloudFront-style names because the managed
  catalog already documents them as exact game endpoints.
- `mc.yandex.ru`, VK/Mail.ru, Ozon, Wildberries, Avito, and similar ecosystems
  are not present in the active managed domain catalog as of this draft. They
  may still appear in DNS telemetry and should be handled by a separate
  observed-domain/app-family catalog if needed.

## Candidate Machine Schema

```yaml
- pattern: googlevideo.com
  match: suffix
  app_family: YouTube
  app_category: video_streaming
  traffic_role: client
  confidence: high
  source: managed_domain_catalog

- pattern: doh.dns.apple.com
  match: exact_or_suffix
  app_family: Apple
  app_category: private_dns
  traffic_role: service_system
  confidence: high
  source: managed_domain_catalog
```
