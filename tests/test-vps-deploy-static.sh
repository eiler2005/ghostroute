#!/bin/bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_TASK="${PROJECT_ROOT}/ansible/tasks/vps-last-good-backup.yml"

fail() {
  echo "vps deploy static test: $*" >&2
  exit 1
}

grep -Fq 'ansible.builtin.shell:' "$BACKUP_TASK" || fail "VPS backup must run through Bash shell"
grep -Fq 'relative_path="$(printf' "$BACKUP_TASK" || fail "VPS backup must normalize paths without Bash parameter expansion"
grep -Fq "sed 's#^/##'" "$BACKUP_TASK" || fail "VPS backup must strip the leading slash safely"
grep -Fq 'tar -czf "$bundle" -C / $paths' "$BACKUP_TASK" || fail "VPS backup must archive the normalized path list"
! grep -Fq '${#paths' "$BACKUP_TASK" || fail "VPS backup must not use Bash array length syntax that collides with Jinja comments"
! grep -Fq '${path#/' "$BACKUP_TASK" || fail "VPS backup must not use Bash prefix expansion that collides with Jinja comments"

echo "vps deploy static tests passed"
