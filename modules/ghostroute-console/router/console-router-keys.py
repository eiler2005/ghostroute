#!/opt/bin/python3
"""Stage/revoke only the identified router credentials, preserving other keys."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

DIRECTORY = Path('/jffs/addons/ghostroute-console-readonly')
AUTHORIZED = Path('/root/.ssh/authorized_keys')
FORCED = 'command="/opt/bin/python3 -I /jffs/addons/ghostroute-console-readonly/gate.py",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty '


def blob(line):
    match = re.search(r'(?:^|\s)(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+) ([A-Za-z0-9+/=]+)(?:\s|$)', line)
    return match[2] if match else None


def public(value):
    if '\n' in value.strip() or '\r' in value.strip():
        raise ValueError('public key must have one line')
    fields = value.split()
    if len(fields) < 2 or fields[0] not in ('ssh-ed25519', 'ssh-rsa'):
        raise ValueError('invalid public key')
    base64.b64decode(fields[1], validate=True)
    return ' '.join(fields[:2])


def rows(value):
    return [line.strip() for line in value.replace('>', '\n').splitlines() if line.strip()]


def revise(runtime, persistent, operator, console, retired=None):
    operator, console = public(operator), public(console)
    op_blob, console_blob = blob(operator), blob(console)
    retired_blob = blob(public(retired)) if retired else None
    if op_blob == console_blob or retired_blob in (op_blob, console_blob):
        raise ValueError('operator, service and retired keys must differ')
    result, seen = [], set()
    for line in rows(runtime)+rows(persistent):
        identity = blob(line)
        if (identity is not None and identity in (op_blob, console_blob, retired_blob)) or line in seen:
            continue
        if identity and identity in seen:
            continue
        seen.add(identity or line)
        result.append(line)
    result += [operator+' ghostroute-operator', FORCED+console+' ghostroute-console']
    updated = '\n'.join(result)+'\n'
    # Merlin's SSH startup copies this NVRAM field through a 3500-byte buffer.
    if len(updated.encode()) >= 3500:
        raise ValueError('authorized keys exceed the firmware startup limit')
    return updated


def atomic(path, value):
    temporary = path.with_name(path.name+'.pending')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def persistent_read():
    return subprocess.check_output(['nvram', 'get', 'sshd_authkeys'], text=True).rstrip('\n')


def apply(runtime, persistent):
    subprocess.run(['nvram', 'set', 'sshd_authkeys='+persistent], check=True)
    subprocess.run(['nvram', 'commit'], check=True)
    atomic(AUTHORIZED, runtime)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('stage', 'retire', 'confirm', 'rollback'))
    parser.add_argument('--settings', type=Path)
    parser.add_argument('--delayed', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    marker = DIRECTORY/'retirement-confirmed'
    if args.action == 'confirm':
        marker.touch(mode=0o600)
        print('credential_retirement_confirmed')
        return
    if args.action == 'rollback':
        if args.delayed:
            time.sleep(180)
            if marker.exists():
                return
        before = json.loads((DIRECTORY/'before-retirement.json').read_text())
        apply(before['runtime'], before['persistent'])
        print('credential_retirement_rolled_back')
        return
    settings = json.loads(args.settings.read_text())
    runtime, persistent = AUTHORIZED.read_text(), persistent_read()
    if args.action == 'retire':
        retired = blob(public(settings['retired_public_key']))
        if all(blob(line) != retired for line in rows(runtime)+rows(persistent)):
            print('credential_already_retired')
            return
    updated = revise(runtime, persistent, settings['operator_public_key'], settings['console_public_key'],
                     settings['retired_public_key'] if args.action == 'retire' else None)
    backup = DIRECTORY/('before-retirement.json' if args.action == 'retire' else 'before-staging.json')
    if args.action == 'retire' or not backup.exists():
        atomic(backup, json.dumps({'runtime': runtime, 'persistent': persistent}))
    if args.action == 'retire':
        marker.unlink(missing_ok=True)
        subprocess.Popen(['/opt/bin/python3', '-I', str(Path(__file__).resolve()), 'rollback', '--delayed'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
    apply(updated, updated.replace('\n', '>').rstrip('>'))
    print('credential_'+args.action+'_ok')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        print('credential update failed; preserve the existing session and use the private rollback', file=sys.stderr)
        sys.exit(1)
