#!/bin/sh
# Renew the shared Channel C/D ASUS ACME certificate only when it is close to
# expiry.  WAN TCP/80 is opened solely for the bounded HTTP-01 transaction.

RUNTIME_ENV=${GHOSTROUTE_RUNTIME_ENV:-/jffs/scripts/ghostroute-runtime.env}
LOG=${GHOSTROUTE_CHANNEL_C_ACME_RENEW_LOG:-/opt/var/log/ghostroute-channel-c-acme-renew.log}
LOCKDIR=/tmp/ghostroute-channel-c-acme-renew.lock

[ -r "$RUNTIME_ENV" ] && . "$RUNTIME_ENV"

ACME=${GHOSTROUTE_ACME_BIN:-/usr/sbin/acme.sh}
ACME_HOME=${GHOSTROUTE_CHANNEL_C_ACME_HOME:-/jffs/.le}
DOMAIN=${GHOSTROUTE_CHANNEL_C_ACME_DOMAIN:-}
CERT=${GHOSTROUTE_CHANNEL_C_ACME_CERT_PATH:-}
KEY=${GHOSTROUTE_CHANNEL_C_ACME_KEY_PATH:-}
SYNC=${GHOSTROUTE_CHANNEL_C_TLS_SYNC:-/jffs/scripts/channel-c-tls-sync.sh}
RENEW_SECONDS=${GHOSTROUTE_CHANNEL_C_ACME_RENEW_SECONDS:-3024000}
CHALLENGE_PORT=${GHOSTROUTE_CHANNEL_C_ACME_CHALLENGE_PORT:-51539}

log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG" 2>/dev/null || true
  logger -t ghostroute-channel-c-acme-renew "$*" 2>/dev/null || true
}

lock() {
  mkdir "$LOCKDIR" 2>/dev/null
}

unlock() {
  rmdir "$LOCKDIR" 2>/dev/null || true
}

acme_required() {
  [ "${GHOSTROUTE_CHANNEL_C_TLS_SOURCE:-vault}" = "asus_acme" ] ||
    [ "${GHOSTROUTE_CHANNEL_D_TLS_SOURCE:-vault}" = "asus_acme" ]
}

certificate_needs_renewal() {
  [ -s "$CERT" ] && [ -s "$KEY" ] || return 0
  ! openssl x509 -in "$CERT" -noout -checkend "$RENEW_SECONDS" >/dev/null 2>&1
}

wan_if=""
cleanup() {
  [ -n "$wan_if" ] || return 0
  iptables -t nat -D PREROUTING -i "$wan_if" -p tcp --dport 80 -j REDIRECT --to-ports "$CHALLENGE_PORT" 2>/dev/null || true
  iptables -D INPUT -i "$wan_if" -p tcp --dport "$CHALLENGE_PORT" -j ACCEPT 2>/dev/null || true
}

renew() {
  acme_required || return 0
  certificate_needs_renewal || return 0
  [ -n "$DOMAIN" ] && [ -x "$ACME" ] || {
    log "ACME renewal configuration is incomplete"
    return 1
  }
  wan_if="$(nvram get wan0_ifname 2>/dev/null || true)"
  [ -n "$wan_if" ] || {
    log "ACME renewal cannot determine WAN interface"
    return 1
  }
  trap 'cleanup; unlock' EXIT INT TERM
  iptables -t nat -I PREROUTING 1 -i "$wan_if" -p tcp --dport 80 -j REDIRECT --to-ports "$CHALLENGE_PORT" || return 1
  iptables -I INPUT 1 -i "$wan_if" -p tcp --dport "$CHALLENGE_PORT" -j ACCEPT || return 1
  "$ACME" --home "$ACME_HOME" --config-home "$ACME_HOME" --cert-home "$ACME_HOME" \
    --renew -d "$DOMAIN" --ecc --standalone --httpport "$CHALLENGE_PORT" >/dev/null 2>&1 || {
      log "ACME renewal command failed"
      return 1
    }
  cleanup
  wan_if=""
  [ -x "$SYNC" ] && "$SYNC" sync >/dev/null 2>&1 || {
    log "ACME renewal completed but Channel C/D TLS sync failed"
    return 1
  }
  log "ACME renewal check completed"
}

case "${1:-renew}" in
  renew)
    lock || exit 0
    renew
    result=$?
    unlock
    exit "$result"
    ;;
  status)
    if acme_required; then
      certificate_needs_renewal && printf 'channel_c_acme_renewal=due\n' || printf 'channel_c_acme_renewal=scheduled\n'
    else
      printf 'channel_c_acme_renewal=disabled\n'
    fi
    ;;
  *)
    echo "usage: $0 {renew|status}" >&2
    exit 64
    ;;
esac
