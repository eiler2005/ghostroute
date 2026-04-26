#!/bin/sh

HEALTH_MONITOR_VERSION=1
HEALTH_MONITOR_DIR="${HEALTH_MONITOR_DIR:-/jffs/scripts/health-monitor}"

health_monitor_default_log_dir() {
  if [ -x /opt/bin/opkg ] || [ -d /opt/var/log ]; then
    printf '%s\n' /opt/var/log/router_configuration/health-monitor
  else
    printf '%s\n' /jffs/addons/router_configuration/health-monitor
  fi
}

LOG_DIR="${HEALTH_MONITOR_LOG_DIR:-$(health_monitor_default_log_dir)}"
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

hm_status_rank() {
  case "${1:-UNKNOWN}" in
    CRIT) printf '4\n' ;;
    WARN) printf '3\n' ;;
    UNKNOWN) printf '2\n' ;;
    SKIP) printf '1\n' ;;
    OK) printf '0\n' ;;
    *) printf '2\n' ;;
  esac
}

hm_human_age() {
  age="${1:-0}"
  awk -v age="$age" '
    BEGIN {
      if (age < 0) print "n/a";
      else if (age < 60) printf "%ds", age;
      else if (age < 3600) printf "%dm", int(age / 60);
      else if (age < 86400) printf "%dh %dm", int(age / 3600), int((age % 3600) / 60);
      else printf "%dd %dh", int(age / 86400), int((age % 86400) / 3600);
    }'
}

hm_file_epoch() {
  file="$1"
  if [ -e "$file" ]; then
    date -r "$file" +%s 2>/dev/null || printf '0\n'
  else
    printf '0\n'
  fi
}

hm_command() {
  name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return 0
  fi
  if [ -x "/opt/bin/$name" ]; then
    printf '/opt/bin/%s\n' "$name"
    return 0
  fi
  return 1
}

hm_curl() {
  if [ -x /opt/bin/curl ]; then
    /opt/bin/curl "$@"
  elif command -v curl >/dev/null 2>&1; then
    command curl "$@"
  else
    curl "$@"
  fi
}

hm_nc() {
  if [ -x /opt/bin/nc ]; then
    /opt/bin/nc "$@"
  elif command -v nc >/dev/null 2>&1; then
    command nc "$@"
  else
    return 127
  fi
}

hm_tcp_open() {
  host="$1"
  port="$2"
  if [ -x /opt/bin/nc ]; then
    /opt/bin/nc -z -w 5 "$host" "$port" >/dev/null 2>&1
    return $?
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 5 "$host" "$port" >/dev/null 2>&1 && return 0
    printf '\n' | nc -w 5 "$host" "$port" >/dev/null 2>&1
    return $?
  fi
  return 127
}

hm_timeout() {
  seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif [ -x /opt/bin/timeout ]; then
    /opt/bin/timeout "$seconds" "$@"
  else
    "$@"
  fi
}

hm_wan_if() {
  nvram get wan0_ifname 2>/dev/null || printf 'wan0\n'
}

hm_singbox_config() {
  printf '%s\n' "${SINGBOX_CONFIG_PATH:-/opt/etc/sing-box/config.json}"
}

hm_singbox_log() {
  printf '%s\n' "${SINGBOX_LOG_PATH:-/opt/var/log/sing-box.log}"
}

hm_extract_reality_server() {
  config="$(hm_singbox_config)"
  [ -r "$config" ] || return 1
  awk '
    /"tag"[[:space:]]*:[[:space:]]*"reality-out"/ { in_reality = 1 }
    in_reality && /"server"[[:space:]]*:/ {
      line = $0
      sub(/^.*"server"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      print line
      exit
    }' "$config"
}
