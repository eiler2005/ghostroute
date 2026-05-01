#!/bin/sh

traffic_report_exec_daily_period() {
  project_root="$1"
  json_mode="$2"
  period_arg="$3"

  case "$period_arg" in
    ""|today|current|current-day)
      return 1
      ;;
    yesterday|week|month|[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      if [ "$json_mode" = "1" ]; then
        exec "${project_root}/modules/traffic-observatory/bin/traffic-daily-report" --json "$period_arg"
      else
        exec "${project_root}/modules/traffic-observatory/bin/traffic-daily-report" "$period_arg"
      fi
      ;;
    *)
      return 2
      ;;
  esac
}
