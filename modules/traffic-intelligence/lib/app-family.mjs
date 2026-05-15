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
    "yandex.net",
    "yastatic.net",
    "ya.ru",
    "kinopoisk.ru",
    "music.yandex.ru",
    "mc.yandex.ru",
    "metrika.yandex.ru",
  ]),
  rule("VK / Mail.ru", "social_messenger", "client", "medium", [
    "vk.com",
    "vk.ru",
    "vkuseraudio.net",
    "userapi.com",
    "vk-cdn.net",
    "mail.ru",
    "mycdn.me",
    "ok.ru",
    "vmailru.net",
    "myteam.vmailru.net",
  ]),
  rule("Apple / iCloud", "apple_ecosystem", "mixed_client_system", "medium", [
    "icloud.com",
    "icloud-content.com",
    "icloud.apple.com",
    "apple-cloudkit.com",
    "cdn-apple.com",
    "aaplimg.com",
    "mzstatic.com",
    "itunes.apple.com",
    "apps.apple.com",
    "podcasts.apple.com",
    "push.apple.com",
    "1-courier.push.apple.com",
    "doh.dns.apple.com",
    "apple-relay.apple.com",
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
  ]),
  rule("Media / streaming", "media_streaming", "client", "medium", [
    "netflix.com",
    "nflxvideo.net",
    "twitch.tv",
    "ttvnw.net",
    "spotify.com",
    "spotifycdn.com",
    "scdn.co",
    "hdrezka.ag",
    "rezka.ag",
    "kinozal.tv",
    "rutracker.org",
  ]),
  rule("Games", "game", "client", "high", [
    "konami.com",
    "konami.net",
    "supercell.com",
    "clashofclans.com",
    "gameloft.com",
    "steamcommunity.com",
    "steampowered.com",
    "epicgames.com",
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
  rule("Service / system", "service_system", "service_system", "medium", [
    "app-measurement.com",
    "firebaseio.com",
    "firebaseinstallations.googleapis.com",
    "crashlytics.com",
    "connectivitycheck.gstatic.com",
    "clients3.google.com",
    "otel.",
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
    app_source: "none",
    matched_pattern: "",
  };
}

export function classifyAppFamily(input) {
  const host = hostFor(input);
  if (!host) return unknownFamily(host);
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
