#!/bin/sh
set -eu
module_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$module_dir"
exec python3 -B -m unittest discover -s tests -p 'test_*.py' -v
