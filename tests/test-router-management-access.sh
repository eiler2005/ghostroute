#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON=python3
if command -v ansible >/dev/null 2>&1; then
  ansible_python="$(head -1 "$(command -v ansible)" | sed -n 's/^#!//p' | awk '{print $1}')"
  [ -x "$ansible_python" ] && PYTHON="$ansible_python"
fi
"$PYTHON" "${PROJECT_ROOT}/tests/test-router-management-access.py"
python3 "${PROJECT_ROOT}/tests/test-router-management-ssh.py"
