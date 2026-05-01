#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${PROJECT_ROOT}"

if [ "$#" -gt 0 ]; then
  printf '%s\0' "$@"
else
  git ls-files -z
fi | while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    *.j2)
      continue
      ;;
  esac
  first_line="$(head -n 1 "$file" || true)"
  case "$first_line" in
    *bash*)
      bash -n "$file"
      ;;
    *"/sh"*|*" env sh"*)
      sh -n "$file"
      ;;
  esac
done

echo "shell syntax checks passed"
