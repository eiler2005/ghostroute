#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOC_PATHS=(
  "README.md"
  "README-ru.md"
  "docs"
  "modules/client-profile-factory/docs"
  "modules/ghostroute-console/docs"
  "modules/routing-core/docs"
  "modules/traffic-observatory/docs"
)

forbidden_pattern='(:4443|:4444|:41955|:41956|:18057|:18443|:18889|127\.0\.0\.1:3000|localhost:3000|\b4443\b|\b4444\b|\b41955\b|\b41956\b|\b18057\b|\b18443\b|\b18889\b)'

if rg -n --pcre2 "${forbidden_pattern}" "${DOC_PATHS[@]/#/${PROJECT_ROOT}/}" >/tmp/ghostroute-doc-port-leaks.$$; then
  cat /tmp/ghostroute-doc-port-leaks.$$ >&2
  rm -f /tmp/ghostroute-doc-port-leaks.$$
  echo "Documentation must use mnemonic port placeholders instead of concrete deployment ports." >&2
  exit 1
fi

rm -f /tmp/ghostroute-doc-port-leaks.$$

echo "documentation port sanitization tests passed"
