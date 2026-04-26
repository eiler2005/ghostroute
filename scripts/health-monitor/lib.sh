#!/bin/sh

HEALTH_MONITOR_VERSION=1
HEALTH_MONITOR_TITLE="${HEALTH_MONITOR_TITLE:-Модуль мониторинга работоспособности GhostRoute}"
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
BASELINE_DIR="$STATE_DIR/baselines"

hm_init_dirs() {
  mkdir -p "$RAW_DIR" "$ALERT_DIR" "$DAILY_DIR" "$STATE_DIR" "$BASELINE_DIR"
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

hm_baseline_file() {
  metric="$1"
  printf '%s/%s.tsv\n' "$BASELINE_DIR" "$metric"
}

hm_baseline_observe() {
  metric="$1"
  value="$2"
  now="${3:-$(hm_now_epoch)}"
  file="$(hm_baseline_file "$metric")"
  tmp="$file.tmp.$$"
  cutoff=$((now - 604800))

  hm_init_dirs
  if [ -r "$file" ]; then
    awk -v cutoff="$cutoff" 'NF >= 2 && ($1 + 0) >= cutoff { print $1 "\t" $2 }' "$file" > "$tmp"
  else
    : > "$tmp"
  fi
  printf '%s\t%s\n' "$now" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

hm_baseline_stats() {
  metric="$1"
  file="$(hm_baseline_file "$metric")"
  values="$file.values.$$"

  if [ ! -s "$file" ]; then
    printf '0 0\n'
    return 0
  fi

  awk 'NF >= 2 { print $2 }' "$file" | sort -n > "$values"
  count="$(wc -l < "$values" | tr -d ' ')"
  case "$count" in ''|*[!0-9]*) count=0 ;; esac
  if [ "$count" -le 0 ]; then
    rm -f "$values"
    printf '0 0\n'
    return 0
  fi

  idx="$(awk -v count="$count" 'BEGIN { i = int(count * 0.95); if (i < count * 0.95) i++; if (i < 1) i = 1; print i }')"
  p95="$(awk -v idx="$idx" 'NR == idx { print $1; found = 1; exit } END { if (!found) print 0 }' "$values")"
  rm -f "$values"
  printf '%s %s\n' "$count" "$p95"
}

hm_thresholds_from_p95() {
  p95="$1"
  min_warn="$2"
  min_crit="$3"
  warn_mult="$4"
  crit_mult="$5"
  awk -v p95="$p95" -v min_warn="$min_warn" -v min_crit="$min_crit" \
    -v warn_mult="$warn_mult" -v crit_mult="$crit_mult" '
    BEGIN {
      warn = p95 * warn_mult
      crit = p95 * crit_mult
      if (warn < min_warn) warn = min_warn
      if (crit < min_crit) crit = min_crit
      printf "%.2f %.2f\n", warn, crit
    }'
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
