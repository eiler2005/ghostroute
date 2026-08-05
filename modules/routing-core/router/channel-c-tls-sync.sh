#!/bin/sh
# Keep Channel C and Channel D TLS material in sync with the router's ASUS ACME
# store.  This script never changes routing, firewall, DNS, or egress state.

RUNTIME_ENV=${GHOSTROUTE_RUNTIME_ENV:-/jffs/scripts/ghostroute-runtime.env}
LOG=${GHOSTROUTE_CHANNEL_C_TLS_SYNC_LOG:-/opt/var/log/ghostroute-channel-c-tls-sync.log}
LOCKDIR=/tmp/ghostroute-channel-c-tls-sync.lock

[ -r "$RUNTIME_ENV" ] && . "$RUNTIME_ENV"

SINGBOX_INIT=${GHOSTROUTE_SINGBOX_INIT:-/opt/etc/init.d/S99sing-box}
CHANNEL_D_INIT=${GHOSTROUTE_CHANNEL_D_NAIVEPROXY_CADDY_INIT:-/opt/etc/init.d/S99caddy-channel-d-naiveproxy}
WARN_SECONDS=${GHOSTROUTE_CHANNEL_C_TLS_WARN_SECONDS:-2592000}

log() {
  mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >>"$LOG" 2>/dev/null || true
  logger -t ghostroute-channel-c-tls-sync "$*" 2>/dev/null || true
}

lock() {
  mkdir "$LOCKDIR" 2>/dev/null
}

unlock() {
  rmdir "$LOCKDIR" 2>/dev/null || true
}

certificate_valid() {
  cert="$1"
  [ -s "$cert" ] && openssl x509 -in "$cert" -noout -checkend 0 >/dev/null 2>&1
}

certificate_expires_soon() {
  cert="$1"
  openssl x509 -in "$cert" -noout -checkend "$WARN_SECONDS" >/dev/null 2>&1
}

copy_atomic() {
  source_file="$1"
  destination="$2"
  mode="$3"
  temporary="${destination}.new.$$"

  mkdir -p "$(dirname "$destination")" 2>/dev/null || return 1
  umask 077
  cp "$source_file" "$temporary" || return 1
  chmod "$mode" "$temporary" || {
    rm -f "$temporary"
    return 1
  }
  mv "$temporary" "$destination"
}

sync_pair() {
  label="$1"
  source_mode="$2"
  source_cert="$3"
  source_key="$4"
  destination_cert="$5"
  destination_key="$6"

  [ "$source_mode" = "asus_acme" ] || return 0
  if ! certificate_valid "$source_cert" || [ ! -s "$source_key" ]; then
    log "$label ACME source certificate or key is missing or invalid; retaining current listener material"
    return 2
  fi
  certificate_expires_soon "$source_cert" || log "$label ACME source certificate expires within ${WARN_SECONDS}s"

  if cmp -s "$source_cert" "$destination_cert" 2>/dev/null && cmp -s "$source_key" "$destination_key" 2>/dev/null; then
    return 0
  fi

  copy_atomic "$source_cert" "$destination_cert" 0644 &&
    copy_atomic "$source_key" "$destination_key" 0600 || {
      log "$label could not install renewed TLS material"
      return 2
    }
  log "$label installed updated ACME TLS material"
  return 1
}

status_pair() {
  label="$1"
  source_mode="$2"
  source_cert="$3"
  source_key="$4"
  destination_cert="$5"
  destination_key="$6"

  if ! certificate_valid "$destination_cert" || [ ! -s "$destination_key" ]; then
    printf '%s=invalid\n' "$label"
    return 1
  fi
  if [ "$source_mode" = "asus_acme" ] && { ! certificate_valid "$source_cert" || [ ! -s "$source_key" ]; }; then
    printf '%s=acme-source-invalid\n' "$label"
    return 1
  fi
  if ! certificate_expires_soon "$destination_cert"; then
    printf '%s=expires-soon\n' "$label"
    return 1
  fi
  printf '%s=ok\n' "$label"
}

status() {
  result=0
  if [ "${GHOSTROUTE_CHANNEL_C_HOME_ENABLED:-0}" = "1" ] || [ "${GHOSTROUTE_CHANNEL_C_SHADOWROCKET_ENABLED:-0}" = "1" ]; then
    status_pair channel_c_tls \
      "${GHOSTROUTE_CHANNEL_C_TLS_SOURCE:-vault}" \
      "${GHOSTROUTE_CHANNEL_C_ACME_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_C_ACME_KEY_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_C_TLS_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_C_TLS_KEY_PATH:-}" || result=1
  else
    printf 'channel_c_tls=disabled\n'
  fi
  if [ "${GHOSTROUTE_CHANNEL_D_NAIVEPROXY_ENABLED:-0}" = "1" ]; then
    status_pair channel_d_tls \
      "${GHOSTROUTE_CHANNEL_D_TLS_SOURCE:-vault}" \
      "${GHOSTROUTE_CHANNEL_D_ACME_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_D_ACME_KEY_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_D_TLS_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_D_TLS_KEY_PATH:-}" || result=1
  else
    printf 'channel_d_tls=disabled\n'
  fi
  return "$result"
}

sync() {
  c_changed=0
  d_changed=0
  failed=0

  if [ "${GHOSTROUTE_CHANNEL_C_HOME_ENABLED:-0}" = "1" ] || [ "${GHOSTROUTE_CHANNEL_C_SHADOWROCKET_ENABLED:-0}" = "1" ]; then
    sync_pair "Channel C" \
      "${GHOSTROUTE_CHANNEL_C_TLS_SOURCE:-vault}" \
      "${GHOSTROUTE_CHANNEL_C_ACME_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_C_ACME_KEY_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_C_TLS_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_C_TLS_KEY_PATH:-}"
    case $? in
      1) c_changed=1 ;;
      2) failed=1 ;;
    esac
  fi

  if [ "${GHOSTROUTE_CHANNEL_D_NAIVEPROXY_ENABLED:-0}" = "1" ]; then
    sync_pair "Channel D" \
      "${GHOSTROUTE_CHANNEL_D_TLS_SOURCE:-vault}" \
      "${GHOSTROUTE_CHANNEL_D_ACME_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_D_ACME_KEY_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_D_TLS_CERT_PATH:-}" \
      "${GHOSTROUTE_CHANNEL_D_TLS_KEY_PATH:-}"
    case $? in
      1) d_changed=1 ;;
      2) failed=1 ;;
    esac
  fi

  [ "$c_changed" = "0" ] || {
    if [ -x "$SINGBOX_INIT" ]; then
      "$SINGBOX_INIT" restart >/dev/null 2>&1 || {
        log "Channel C TLS changed but sing-box restart failed"
        failed=1
      }
    else
      log "Channel C TLS changed but sing-box init is missing"
      failed=1
    fi
  }
  if [ "${GHOSTROUTE_CHANNEL_D_NAIVEPROXY_ENABLED:-0}" = "1" ] && { [ "$c_changed" = "1" ] || [ "$d_changed" = "1" ]; }; then
    if [ -x "$CHANNEL_D_INIT" ]; then
      "$CHANNEL_D_INIT" restart >/dev/null 2>&1 || {
        log "Channel D TLS changed but Caddy restart failed"
        failed=1
      }
    else
      log "Channel D TLS changed but Caddy init is missing"
      failed=1
    fi
  fi
  return "$failed"
}

case "${1:-sync}" in
  sync)
    lock || exit 0
    sync
    result=$?
    unlock
    exit "$result"
    ;;
  status)
    status
    ;;
  *)
    echo "usage: $0 {sync|status}" >&2
    exit 64
    ;;
esac
