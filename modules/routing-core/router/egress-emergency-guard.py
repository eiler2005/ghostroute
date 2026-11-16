#!/opt/bin/python3
"""Serialize egress changes with recovery owners; never retain locks in daemons."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

BASE = Path('/opt/etc/ghostroute-egress-emergency')
LOCK = Path('/tmp/ghostroute-egress-emergency.lock')

def inherited():
    try:
        fd = int(os.environ['GR_EGRESS_LOCK_FD'])
        return fd if os.fstat(fd).st_ino == LOCK.stat().st_ino else None
    except (KeyError, ValueError, OSError):
        return None

def shared():
    handle = LOCK.open('a')
    fcntl.flock(handle, fcntl.LOCK_SH)
    return handle

def main():
    command = sys.argv[1:]
    if command[:1] == ['--']: command = command[1:]
    bank = command[:1] == ['--bank-probe']
    if bank: command = command[1:]
    borrowed = inherited()
    handle = None
    if borrowed is None:
        # Recover an interrupted transition before any ordinary recovery starts.
        if (BASE / 'transition.json').exists():
            subprocess.run(['/opt/bin/python3', str(BASE / 'controller.py'), 'recover'], check=True)
        handle = shared()
        if (BASE / 'transition.json').exists():
            handle.close()
            raise SystemExit(1)
    if bank and (BASE/'state.json').exists():
        import json
        if json.loads((BASE/'state.json').read_text()).get('selected')=='emergency':
            raise SystemExit('Inactive primary profile probes are blocked while emergency is selected')
    env = dict(os.environ, GR_EGRESS_GUARD_WRAPPED='1')
    # Parent owns the lease; background daemons must not inherit its fd.
    result = subprocess.run(command, env=env, close_fds=True)
    if handle: handle.close()
    raise SystemExit(result.returncode)

if __name__ == '__main__': main()
