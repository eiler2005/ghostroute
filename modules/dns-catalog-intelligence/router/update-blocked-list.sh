#!/bin/sh
# Downloads the list of domains blocked in Russia (community-curated).
# Runs daily via cron. Downloads through sing-box SOCKS because the source may
# be blocked on the direct ISP path.
#
# Source: community.antifilter.download — curated list of ~500 key blocked domains.
# Note: YouTube, Telegram, GitHub etc. are not in this list because they're blocked
# via DPI/IP, not through the RKN domain registry. Those services are covered by
# manually curated rules in dnsmasq-stealth.conf.add.
#
# Cron: 0 5 * * * /jffs/addons/x3mRouting/update-blocked-list.sh

CACHE="/opt/tmp/blocked-domains.lst"
CACHE_TMP="${CACHE}.tmp"
URL="https://community.antifilter.download/list/domains.lst"
GHOSTROUTE_RUNTIME_ENV="${GHOSTROUTE_RUNTIME_ENV:-/jffs/scripts/ghostroute-runtime.env}"
[ -r "$GHOSTROUTE_RUNTIME_ENV" ] && . "$GHOSTROUTE_RUNTIME_ENV"
if [ -n "${BLOCKED_LIST_SOCKS_PROXY:-}" ]; then
  SOCKS_PROXY="$BLOCKED_LIST_SOCKS_PROXY"
elif [ -n "${GHOSTROUTE_DNSCRYPT_SOCKS_PORT:-}" ]; then
  SOCKS_PROXY="socks5h://127.0.0.1:${GHOSTROUTE_DNSCRYPT_SOCKS_PORT}"
else
  logger -t blocked-list "Missing SOCKS proxy port; set BLOCKED_LIST_SOCKS_PROXY or GHOSTROUTE_DNSCRYPT_SOCKS_PORT"
  exit 1
fi
MAX_TIME=120

# Download through Channel A SOCKS (use which — BusyBox ash lacks 'command -v').
if which curl >/dev/null 2>&1; then
  curl -sf --proxy "$SOCKS_PROXY" --max-time "$MAX_TIME" "$URL" -o "$CACHE_TMP" \
    || curl -sf --max-time "$MAX_TIME" "$URL" -o "$CACHE_TMP"
elif which wget >/dev/null 2>&1; then
  wget -q -O "$CACHE_TMP" "$URL" 2>/dev/null
else
  logger -t blocked-list "Neither curl nor wget available"
  exit 1
fi

if [ -s "$CACHE_TMP" ]; then
  mv "$CACHE_TMP" "$CACHE"
  COUNT=$(wc -l < "$CACHE" | tr -d ' ')
  logger -t blocked-list "Updated blocked-domains.lst: $COUNT domains"
else
  rm -f "$CACHE_TMP"
  if [ -f "$CACHE" ]; then
    logger -t blocked-list "Download failed, using cached version"
  else
    logger -t blocked-list "Download failed, no cache — domain-auto-add.sh will use fallback mode"
  fi
  exit 1
fi
