function text(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function lower(value) {
  return text(value).trim().toLowerCase().replace(/\.$/, "");
}

function hostFor(input) {
  if (typeof input === "string") return lower(input);
  const row = input || {};
  const value = text(row.dns_qname || row.domain || row.sni || row.destination || row.destination_key || row.destination_label || "");
  return lower(value).replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
}

function hintText(input) {
  if (!input || typeof input !== "object") return "";
  return [
    input.category,
    input.provider,
    input.dns_category,
    input.traffic_lane,
    input.traffic_role,
    input.traffic_purpose,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isIpLiteral(value) {
  const normalized = lower(value);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalized)) return true;
  return normalized.includes(":") && /^[0-9a-f:.]+$/i.test(normalized);
}

function exactOrSuffix(host, pattern) {
  const normalized = lower(pattern);
  return host === normalized || host.endsWith(`.${normalized}`);
}

function rule(family, category, role, confidence, patterns, options = {}) {
  return { family, category, role, confidence, patterns, source: options.source || "app_family_catalog" };
}

const RULES = [
  rule("YouTube", "video_streaming", "client", "high", [
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "youtubei.googleapis.com",
    "youtube.googleapis.com",
    "googlevideo.com",
    "ytimg.com",
    "ggpht.com",
  ]),
  rule("Instagram / Meta", "social_media", "client", "high", [
    "instagram.com",
    "instagram.net",
    "cdninstagram.com",
    "graph.instagram.com",
    "ig.me",
    "threads.net",
    "facebook.com",
    "facebook.net",
    "fb.com",
    "fbcdn.net",
    "fbsbx.com",
    "messenger.com",
    "meta.com",
  ]),
  rule("Telegram", "messenger", "client", "high", [
    "telegram.org",
    "telegram.com",
    "telegram.me",
    "t.me",
    "telegra.ph",
    "telesco.pe",
    "tg.dev",
    "cdn-telegram.org",
    "telegram-cdn.org",
    "fragment.com",
    "graph.org",
    "comments.app",
    "tdesktop.com",
    "tx.me",
  ]),
  rule("Yandex", "search_platform", "client", "medium", [
    "yandex.ru",
    "yandex.com",
    "yandex.by",
    "yandex.kz",
    "yandex.uz",
    "yandex.net",
    "yandex.st",
    "yastatic.net",
    "ya.ru",
    "kinopoisk.ru",
    "kinopoiskapiunofficial.tech",
    "yandexvideo.net",
    "yandexadexchange.net",
    "yandexcloud.net",
    "yandexcloud.com",
    "browser.yandex.ru",
    "disk.yandex.ru",
    "taxi.yandex.ru",
    "music.yandex.ru",
    "api.music.yandex.net",
    "mc.yandex.ru",
    "metrika.yandex.ru",
  ]),
  rule("VK / Mail.ru", "social_messenger", "client", "medium", [
    "vk.com",
    "vk.ru",
    "vkuserlive.net",
    "vkuseraudio.net",
    "vkvideo.ru",
    "vkplay.ru",
    "vkcache.com",
    "userapi.com",
    "vk-cdn.net",
    "mail.ru",
    "imgsmail.ru",
    "mradx.net",
    "my.mail.ru",
    "mycdn.me",
    "ok.ru",
    "vmailru.net",
    "myteam.vmailru.net",
  ]),
  rule("Apple / iCloud", "apple_ecosystem", "mixed_client_system", "medium", [
    "apple.com",
    "icloud.com",
    "icloud-content.com",
    "icloud.apple.com",
    "apple-dns.net",
    "apple-cloudkit.com",
    "app-analytics-services.com",
    "cdn-apple.com",
    "aaplimg.com",
    "mzstatic.com",
    "itunes.apple.com",
    "iosapps.itunes.apple.com",
    "apps.apple.com",
    "podcasts.apple.com",
    "push.apple.com",
    "1-courier.push.apple.com",
    "doh.dns.apple.com",
    "apple-relay.apple.com",
    "configuration.apple.com",
    "gs-loc.apple.com",
    "gs-loc-cn.apple.com",
    "gsp-ssl.ls.apple.com",
    "gspe21-ssl.ls.apple.com",
    "ls-apple.com.akadns.net",
    "xp.apple.com",
  ]),
  rule("Service / system", "service_system", "service_system", "medium", [
    "app-measurement.com",
    "firebaseio.com",
    "firebaseinstallations.googleapis.com",
    "firebaselogging-pa.googleapis.com",
    "crashlytics.com",
    "appsflyer.com",
    "appsflyersdk.com",
    "clarity.ms",
    "connectivitycheck.gstatic.com",
    "clients3.google.com",
    "otel.",
  ]),
  rule("Google", "google_services", "mixed_client_system", "medium", [
    "google.com",
    "googleapis.com",
    "gstatic.com",
    "googleusercontent.com",
    "googleapis.cn",
    "gvt1.com",
    "gvt2.com",
    "gvt3.com",
    "gmail.com",
    "mail.google.com",
    "docs.google.com",
    "drive.google.com",
    "photos.google.com",
  ]),
  rule("WhatsApp", "messenger", "client", "high", [
    "whatsapp.com",
    "whatsapp.net",
    "wa.me",
    "wl.co",
  ]),
  rule("Microsoft", "microsoft_services", "mixed_client_system", "medium", [
    "microsoft.com",
    "windows.com",
    "live.com",
    "office.com",
    "office365.com",
    "msftconnecttest.com",
    "msftncsi.com",
    "sharepoint.com",
    "onedrive.com",
    "xboxlive.com",
    "azureedge.net",
  ]),
  rule("OpenAI / ChatGPT", "ai_assistant", "client", "high", [
    "openai.com",
    "chatgpt.com",
    "oaistatic.com",
    "oaiusercontent.com",
    "searchgpt.com",
    "sora.com",
  ]),
  rule("Anthropic / Claude", "ai_assistant", "client", "high", [
    "anthropic.com",
    "claude.ai",
    "claude.com",
  ]),
  rule("Dropbox / cloud", "personal_cloud", "client", "high", [
    "dropbox.com",
    "dropboxapi.com",
    "dropboxstatic.com",
    "db.tt",
  ]),
  rule("Personal cloud / sync", "personal_cloud", "client", "medium", [
    "syncthing.net",
  ]),
  rule("GitHub / dev", "developer_platform", "client", "high", [
    "github.com",
    "githubusercontent.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
    "codeload.github.com",
    "githubstatus.com",
    "gitlab.com",
    "bitbucket.org",
    "dev.azure.com",
    "visualstudio.com",
  ]),
  rule("Developer / SaaS tools", "developer_saas", "client", "medium", [
    "atlassian.com",
    "datacamp.com",
    "hackernoon.com",
    "harvestapp.com",
    "jetbrains.com",
    "redis.io",
    "redislabs.com",
    "semrush.com",
    "splunkcloud.com",
    "tableau.com",
    "tableausoftware.com",
    "tableauusercontent.com",
  ]),
  rule("Slack", "collaboration", "client", "high", [
    "slack.com",
    "slack-edge.com",
    "slack-imgs.com",
  ]),
  rule("Notion", "productivity", "client", "high", [
    "notion.com",
    "notion.so",
    "notion.site",
    "notionusercontent.com",
  ]),
  rule("Productivity / knowledge tools", "productivity", "client", "high", [
    "canva.com",
    "canva.dev",
    "medium.com",
    "quora.com",
  ]),
  rule("Discord", "messenger", "client", "high", [
    "discord.com",
    "discord.gg",
    "discord.media",
    "discordapp.com",
    "discordapp.net",
    "cdn.discordapp.com",
  ]),
  rule("TikTok / ByteDance", "short_video_social", "client", "high", [
    "tiktok.com",
    "tiktokv.com",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tiktokcdn-eu.com",
    "byteoversea.com",
    "ibytedtos.com",
    "byteimg.com",
    "muscdn.com",
    "ttwstatic.com",
  ]),
  rule("Shopping / marketplaces", "shopping_consumer", "client", "medium", [
    "ozon.ru",
    "ozonusercontent.com",
    "ozone.ru",
    "wildberries.ru",
    "wb.ru",
    "wbbasket.ru",
    "wbstatic.net",
    "avito.ru",
    "avito.st",
    "market.yandex.ru",
    "eda.yandex.ru",
    "lavka.yandex.ru",
    "iherb.com",
    "ikea.com",
    "dyson.com",
  ]),
  rule("Finance / banking", "finance", "client", "medium", [
    "tbank.ru",
    "tinkoff.ru",
    "tcsbank.ru",
    "sberbank.ru",
    "sber.ru",
    "sberbank.com",
    "vtb.ru",
    "alfabank.ru",
    "raiffeisen.ru",
    "gazprombank.ru",
    "moex.com",
    "finam.ru",
    "tradingview.com",
    "tradingview-widget.com",
  ]),
  rule("Travel / maps", "travel_maps", "client", "medium", [
    "2gis.ru",
    "2gis.com",
    "dublgis.com",
    "maps.googleapis.com",
    "maps.apple.com",
    "booking.com",
    "airbnb.com",
    "aviasales.ru",
    "tutu.ru",
    "rzd.ru",
  ]),
  rule("Media / streaming", "media_streaming", "client", "medium", [
    "netflix.com",
    "nflxvideo.net",
    "twitch.tv",
    "ttvnw.net",
    "spotify.com",
    "spotifycdn.com",
    "scdn.co",
    "music.apple.com",
    "rutube.ru",
    "rutube.app",
    "premier.one",
    "okko.tv",
    "ivi.ru",
    "wink.ru",
    "more.tv",
    "amediateka.ru",
    "kinopoisk.ru",
    "hdrezka.ag",
    "rezka.ag",
    "kinozal.tv",
    "rutracker.org",
    "rutor.info",
    "rutor.is",
    "seasonvar.ru",
    "flibusta.is",
    "flibusta.net",
    "flibusta.site",
  ]),
  rule("News / public media", "news_media", "client", "high", [
    "euronews.com",
    "meduza.io",
    "thebell.io",
    "proekt.media",
    "holod.media",
    "novayagazeta.ru",
    "novayagazeta.eu",
    "novaya.no",
    "rbc.ru",
    "kommersant.ru",
    "vedomosti.ru",
    "fontanka.ru",
    "lenta.ru",
    "ria.ru",
  ]),
  rule("Games", "game", "client", "high", [
    "konami.com",
    "konami.net",
    "my.konami.net.edgekey.net",
    "my1.konami.net.edgekey.net",
    "supercell.com",
    "clashofclans.com",
    "game-assets.clashofclans.com",
    "game.boombeachgame.com",
    "gameloft.com",
    "steamcommunity.com",
    "steampowered.com",
    "epicgames.com",
    "roblox.com",
    "rbxcdn.com",
    "minecraft.net",
  ]),
  rule("Diagnostics", "network_diagnostics", "diagnostics", "high", [
    "ipify.org",
    "ifconfig.me",
    "ipinfo.io",
    "browserleaks.com",
    "browserleaks.net",
    "speedtest.net",
    "maxmind.com",
  ]),
  rule("Provider / CDN", "provider_cdn", "provider_fallback", "medium", [
    "cloudflare.com",
    "cloudflare.net",
    "cloudfront.net",
    "akamaihd.net",
    "edgesuite.net",
    "edgekey.net",
    "fastly.net",
    "gcorelabs.com",
    "hetzner.com",
    "digitalocean.com",
    "amazonaws.com",
  ]),
];

function matchRule(host, candidate) {
  if (!host || !candidate) return false;
  if (candidate.endsWith(".")) return host.startsWith(candidate);
  if (candidate.includes("*")) {
    const re = new RegExp(`^${candidate.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return re.test(host);
  }
  return exactOrSuffix(host, candidate);
}

function unknownFamily(host) {
  return {
    app_family: host ? "Other / uncategorized" : "Unknown",
    app_category: host ? "uncategorized" : "unknown",
    traffic_role: "unknown",
    app_confidence: "unknown",
    app_source: isIpLiteral(host) ? "ip_only" : "none",
    matched_pattern: "",
  };
}

function hintedFamily(input, host) {
  const hints = hintText(input);
  if (!hints) return null;
  const make = (family, category, confidence, matched) => ({
    app_family: family,
    app_category: category,
    traffic_role: hints.includes("cdn") || hints.includes("infra") ? "provider_fallback" : "client",
    app_confidence: confidence,
    app_source: hints.includes("ip_asn") || hints.includes("provider") || hints.includes("network") ? "provider_hint" : "category_hint",
    matched_pattern: matched,
  });
  if (/(facebook|meta|instagram|social_platform)/.test(hints)) return make("Instagram / Meta", "social_media", "medium", "provider:meta");
  if (/(telegram|messaging_platform)/.test(hints)) return make("Telegram", "messenger", "medium", "provider:telegram");
  if (/(youtube|googlevideo|client\.google\.youtube)/.test(hints)) return make("YouTube", "video_streaming", "medium", "category:youtube");
  if (/(apple|icloud|apple_infra|personal_cloud\.icloud)/.test(hints)) return make("Apple / iCloud", "apple_ecosystem", "medium", "provider:apple");
  if (/(google|google_infra)/.test(hints)) return make("Google", "google_services", "medium", "provider:google");
  if (/(microsoft|azure|msn|onedrive)/.test(hints)) return make("Microsoft", "microsoft_services", "medium", "provider:microsoft");
  if (/(openai|chatgpt)/.test(hints)) return make("OpenAI / ChatGPT", "ai_assistant", "medium", "provider:openai");
  if (/(anthropic|claude)/.test(hints)) return make("Anthropic / Claude", "ai_assistant", "medium", "provider:anthropic");
  if (/(dropbox)/.test(hints)) return make("Dropbox / cloud", "personal_cloud", "medium", "provider:dropbox");
  if (/(github|developer_tool|developer_platform)/.test(hints)) return make("GitHub / dev", "developer_platform", "medium", "category:developer");
  if (/(yandex)/.test(hints)) return make("Yandex", "search_platform", "medium", "provider:yandex");
  if (/(vk|mail\.ru)/.test(hints)) return make("VK / Mail.ru", "social_messenger", "medium", "provider:vk");
  if (/(ozon|wildberries|wb\.ru|avito|marketplace|ecommerce|shopping)/.test(hints)) return make("Shopping / marketplaces", "shopping_consumer", "medium", "category:shopping");
  if (/(tinkoff|tbank|sber|vtb|alfabank|bank|finance|tradingview)/.test(hints)) return make("Finance / banking", "finance", "medium", "category:finance");
  if (/(rutube|kinopoisk|ivi|okko|spotify|netflix|twitch|streaming|media)/.test(hints)) return make("Media / streaming", "media_streaming", "medium", "category:media");
  if (/(tiktok|bytedance)/.test(hints)) return make("TikTok / ByteDance", "short_video_social", "medium", "provider:bytedance");
  if (/(whatsapp)/.test(hints)) return make("WhatsApp", "messenger", "medium", "provider:whatsapp");
  if (/(cdn|cloudflare|cloudfront|akamai|fastly|gcore|hetzner|amazon|aws|leaseweb|hosting|vps|shared_infra|cloud_hosting)/.test(hints)) {
    return make("Provider / CDN", "provider_cdn", "low", "provider:cdn-hosting");
  }
  if (/(system|service|analytics|tracker|firebase)/.test(hints)) return make("Service / system", "service_system", "low", "category:service");
  return null;
}

export function classifyAppFamily(input) {
  const host = hostFor(input);
  if (host && !isIpLiteral(host)) {
    for (const entry of RULES) {
      const matched = entry.patterns.find((pattern) => matchRule(host, pattern));
      if (!matched) continue;
      return {
        app_family: entry.family,
        app_category: entry.category,
        traffic_role: entry.role,
        app_confidence: entry.confidence,
        app_source: entry.source,
        matched_pattern: matched,
      };
    }
  }
  const hinted = hintedFamily(input, host);
  if (hinted) return hinted;
  return unknownFamily(host);
}

export function isClientFacingAppFamily(input) {
  const family = typeof input === "string" ? classifyAppFamily(input) : (input || {});
  const role = lower(family.traffic_role || family.app_role);
  if (role === "client" || role === "mixed_client_system") return true;
  return false;
}

export function appFamilyRules() {
  return RULES.map((entry) => ({ ...entry, patterns: [...entry.patterns] }));
}
