#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON=python3
if command -v ansible >/dev/null 2>&1; then
  ansible_python="$(head -1 "$(command -v ansible)" | sed -n 's/^#!//p' | awk '{print $1}')"
  [ -x "$ansible_python" ] && PYTHON="$ansible_python"
fi
"$PYTHON" "$ROOT/tests/test-channel-amn.py"
bash -n "$ROOT/modules/routing-core/bin/build-channel-amn"
