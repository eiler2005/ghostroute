#!/opt/bin/python3
"""Atomically merge a private username/label inventory into stable D slots."""
import json
import os
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
from channel_d_log import validate_profiles
from channel_d_profiles import merge_profiles


def main():
    target, source = map(Path, sys.argv[1:3])
    existing = json.loads(target.read_text()) if target.exists() else {}
    result = validate_profiles(merge_profiles(existing, json.loads(source.read_text())))
    fd, temporary = tempfile.mkstemp(prefix='.channel-d-map-', dir=target.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    main()
