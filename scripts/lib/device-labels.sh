#!/bin/sh
# Shared local device label handling for reports.
#
# Source format:
#   ip-or-key|friendly alias|device type
#
# Output map format:
#   ip-or-key|display label|device type

device_labels_default_metadata_file() {
  if [ -n "${PROJECT_ROOT:-}" ]; then
    printf '%s\n' "${PROJECT_ROOT}/secrets/device-metadata.local.tsv"
  else
    printf '%s\n' "secrets/device-metadata.local.tsv"
  fi
}

device_labels_build_map() {
  output_file="$1"
  source_file="${2:-${DEVICE_METADATA_FILE:-$(device_labels_default_metadata_file)}}"

  : > "$output_file"
  [ -s "$source_file" ] || return 0

  awk -F'|' '
    BEGIN { OFS = "|" }
    /^[[:space:]]*#/ { next }
    {
      key = $1
      alias = $2
      type = $3
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", alias)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", type)
      if (key == "") next

      label = alias
      if (label == "" || label == "?") label = type
      if (label != "" && type != "" && label != type) label = label " (" type ")"
      if (label == "") next

      print key, label, type
    }
  ' "$source_file" > "$output_file"
}
