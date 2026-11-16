#!/opt/bin/python3
"""Add reviewed report bodies without removing the running collector's policy."""
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def merge(old, new):
    for policy in (old, new):
        if policy.get('schema_version') != 1 or not isinstance(policy.get('scripts'), dict) or not isinstance(policy.get('commands'), dict):
            raise ValueError('Invalid router policy')
        for digest, entry in policy['scripts'].items():
            if hashlib.sha256(entry['body'].encode()).hexdigest() != digest:
                raise ValueError('Invalid approved script digest')
        if any(key != value for key, value in policy['commands'].items()):
            raise ValueError('Invalid literal command policy')
    scripts = dict(old['scripts'])
    for digest, entry in new['scripts'].items():
        if digest in scripts and scripts[digest] != entry:
            raise ValueError('Conflicting approved script metadata')
        scripts[digest] = entry
    return {'schema_version': 1, 'scripts': scripts, 'commands': dict(old['commands'], **new['commands'])}


def main():
    old_path, new_path = map(Path, sys.argv[1:3])
    result = merge(json.loads(old_path.read_text()), json.loads(new_path.read_text()))
    fd, temp = tempfile.mkstemp(prefix='.policy-', dir=old_path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(result, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, old_path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


if __name__ == '__main__':
    main()
