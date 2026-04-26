#!/bin/sh

HEALTH_MONITOR_VERSION=1
HEALTH_MONITOR_TITLE="${HEALTH_MONITOR_TITLE:-GhostRoute VPS Observer}"
VPS_HEALTH_ENV="${VPS_HEALTH_ENV:-/opt/stealth/health-monitor/env}"
[ -r "$VPS_HEALTH_ENV" ] && . "$VPS_HEALTH_ENV"

LOG_DIR="${HEALTH_MONITOR_LOG_DIR:-${VPS_HEALTH_LOG_DIR:-/var/log/ghostroute/health-monitor}}"
RAW_DIR="$LOG_DIR/raw"
ALERT_DIR="$LOG_DIR/alerts"
DAILY_DIR="$LOG_DIR/daily"
STATE_DIR="$LOG_DIR/state"

hm_init_dirs() {
  mkdir -p "$RAW_DIR" "$ALERT_DIR" "$DAILY_DIR" "$STATE_DIR"
}

hm_today() {
  date +%F
}

hm_now_epoch() {
  date +%s
}

hm_ts() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

hm_json_escape() {
  printf '%s' "${1:-}" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/ /g; s/[[:cntrl:]]/ /g'
}

hm_raw_file() {
  printf '%s/raw/%s.jsonl\n' "$LOG_DIR" "$(hm_today)"
}

hm_alert_jsonl_file() {
  printf '%s/alerts/%s.jsonl\n' "$LOG_DIR" "$(hm_today)"
}

hm_alert_md_file() {
  printf '%s/alerts/%s.md\n' "$LOG_DIR" "$(hm_today)"
}

hm_daily_file() {
  printf '%s/daily/%s.md\n' "$LOG_DIR" "$(hm_today)"
}

hm_emit() {
  probe="$1"
  status="$2"
  risk="$3"
  message="$4"
  evidence="$5"
  action="$6"
  ts="$(hm_ts)"
  raw_file="$(hm_raw_file)"

  hm_init_dirs
  printf '{"ts":"%s","probe":"%s","status":"%s","risk":"%s","message":"%s","evidence":"%s","action":"%s","version":%s}\n' \
    "$(hm_json_escape "$ts")" \
    "$(hm_json_escape "$probe")" \
    "$(hm_json_escape "$status")" \
    "$(hm_json_escape "$risk")" \
    "$(hm_json_escape "$message")" \
    "$(hm_json_escape "$evidence")" \
    "$(hm_json_escape "$action")" \
    "$HEALTH_MONITOR_VERSION" >> "$raw_file"
}

hm_curl() {
  if command -v curl >/dev/null 2>&1; then
    command curl "$@"
  else
    return 127
  fi
}

hm_ss() {
  if command -v ss >/dev/null 2>&1; then
    command ss "$@"
  else
    return 127
  fi
}

hm_docker() {
  if command -v docker >/dev/null 2>&1; then
    command docker "$@"
  else
    return 127
  fi
}
