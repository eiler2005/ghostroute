#!/bin/sh
# Downloads the list of domains blocked in Russia (community-curated).
# Runs daily via cron. Downloads through VPN (antifilter.download may be blocked).
#
# Source: community.antifilter.download — curated list of ~500 key blocked domains.
# Note: YouTube, Telegram, GitHub etc. are not in this list because they're blocked
# via DPI/IP, not through the RKN domain registry. Those services are covered by
# manually curated rules in dnsmasq.conf.add.
#
# Cron: 0 5 * * * /jffs/addons/x3mRouting/update-blocked-list.sh

CACHE="/opt/tmp/blocked-domains.lst"
CACHE_TMP="${CACHE}.tmp"
URL="https://community.antifilter.download/list/domains.lst"
VPN_IFACE="wgc1"
MAX_TIME=120

# Get VPN interface IP for binding (download must go through VPN)
VPN_IP=$(ip -4 addr show "$VPN_IFACE" 2>/dev/null \
         | awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}')

if [ -z "$VPN_IP" ]; then
  logger -t blocked-list "VPN interface $VPN_IFACE has no IP, skipping update"
  exit 1
fi

# Download via VPN (use which — BusyBox ash lacks 'command -v')
if which curl >/dev/null 2>&1; then
  curl -sf --interface "$VPN_IP" --max-time "$MAX_TIME" "$URL" -o "$CACHE_TMP"
elif which wget >/dev/null 2>&1; then
  wget -q --bind-address="$VPN_IP" -O "$CACHE_TMP" "$URL" 2>/dev/null
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
