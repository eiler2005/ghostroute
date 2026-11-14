#!/opt/bin/python3
"""Manual AnyTLS lab: own only its process and GR_ATLS_IN INPUT chain."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

BASE = Path('/opt/etc/ghostroute-anytls')
RUN = Path('/tmp/ghostroute-anytls')
SOURCE = Path('/opt/etc/sing-box/config.json')
CHAIN = 'GR_ATLS_IN'


def call(*args, check=True):
    p = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if check and p.returncode:
        (RUN / 'last-error.private.json').write_text(json.dumps({'command': args, 'stderr': p.stderr}))
        raise RuntimeError('Lab command failed; inspect private error file')
    return p


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def owned_pid(name):
    try:
        pid = int((RUN / (name + '.pid')).read_text())
        argv = Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
        expected = ([str(BASE / 'sing-box-atls'), 'run', '-c', str(BASE / 'policy.json')]
                    if name == 'policy' else ['/opt/bin/python3', str(BASE / 'channel-anytls.py'), 'watch'])
        return pid if argv[:len(expected)] == [v.encode() for v in expected] else None
    except (OSError, ValueError):
        return None


def terminate(name):
    pid = owned_pid(name)
    if pid:
        os.kill(pid, signal.SIGTERM)
        for _ in range(30):
            if not owned_pid(name):
                break
            time.sleep(.1)
        if owned_pid(name) == pid:
            os.kill(pid, signal.SIGKILL)
    (RUN / (name + '.pid')).unlink(missing_ok=True)


def check_port(port):
    with socket.socket() as sock:
        # Match Go's listener reuse semantics: old accepted TCP connections can
        # remain in TIME_WAIT after a lab stop. An active listener still rejects.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(('0.0.0.0', port))


def preflight():
    if (RUN / 'owned.json').exists() or owned_pid('policy') or owned_pid('watch'):
        raise ValueError('Stop existing lab before replacing or starting it')
    s = json.loads((BASE / 'settings.json').read_text())
    cfg = json.loads((BASE / 'policy.json').read_text())
    inbound = cfg['inbounds']
    if len(inbound) != 1 or inbound[0]['type'] != 'anytls' or inbound[0]['listen'] != '0.0.0.0' or inbound[0]['listen_port'] != s['port']:
        raise ValueError('Unexpected listener ownership')
    if digest(SOURCE) != (BASE / 'policy.source.sha256').read_text().strip():
        raise ValueError('Production policy changed; regenerate isolated projection')
    for key in ('certificate_path', 'key_path'):
        if not Path(inbound[0]['tls'][key]).is_file():
            raise ValueError('TLS file is absent')
    firewall = call('iptables-save').stdout
    if CHAIN in firewall or '--dport ' + str(s['port']) + ' ' in firewall:
        raise ValueError('Candidate firewall resource is already occupied')
    check_port(s['port'])
    memory = dict((line.split(':')[0], int(line.split()[1])) for line in Path('/proc/meminfo').read_text().splitlines())
    if memory['MemAvailable'] < 150 * 1024:
        raise ValueError('Insufficient memory for isolated lab')
    call(str(BASE / 'sing-box-atls'), 'check', '-c', str(BASE / 'policy.json'))
    return s


def stop():
    if not (RUN / 'owned.json').exists():
        return
    s = json.loads((RUN / 'owned.json').read_text())
    # Contain only this ingress before terminating its owners.
    call('iptables', '-I', CHAIN, '1', '-j', 'DROP', check=False)
    terminate('watch')
    terminate('policy')
    hook = ['INPUT', '-p', 'tcp', '--dport', str(s['port']), '-j', CHAIN]
    if call('iptables', '-C', *hook, check=False).returncode == 0:
        call('iptables', '-D', *hook)
    if call('iptables', '-S', CHAIN, check=False).returncode == 0:
        call('iptables', '-F', CHAIN)
        call('iptables', '-X', CHAIN)
    (RUN / 'owned.json').unlink()


def spawn(name, argv):
    with (RUN / (name + '.log')).open('wb') as log:
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             env=dict(os.environ, GOMAXPROCS='2', GOMEMLIMIT='64MiB'), start_new_session=True)
    (RUN / (name + '.pid')).write_text(str(p.pid))
    return p


def ready(port):
    with socket.socket() as sock:
        sock.settimeout(.2)
        return sock.connect_ex(('127.0.0.1', port)) == 0


def start():
    s = preflight()
    # ownership journal is written before the first scoped mutation for rollback.
    (RUN / 'owned.json').write_text(json.dumps({'port': s['port']}))
    try:
        call('iptables', '-N', CHAIN)
        call('iptables', '-A', CHAIN, '-i', 'lo', '-j', 'ACCEPT')
        call('iptables', '-A', CHAIN, '-j', 'DROP')
        call('iptables', '-I', 'INPUT', '1', '-p', 'tcp', '--dport', str(s['port']), '-j', CHAIN)
        (RUN / 'policy.log').write_text('')
        spawn('policy', [str(BASE / 'sing-box-atls'), 'run', '-c', str(BASE / 'policy.json')])
        for _ in range(40):
            if not owned_pid('policy'):
                raise RuntimeError('AnyTLS process exited before readiness')
            if ready(s['port']):
                break
            time.sleep(.2)
        else:
            raise RuntimeError('AnyTLS listener readiness timed out')
        spawn('watch', ['/opt/bin/python3', str(BASE / 'channel-anytls.py'), 'watch'])
        if not owned_pid('watch'):
            raise RuntimeError('Lab containment watcher did not start')
        call('iptables', '-I', CHAIN, '1', '-j', 'ACCEPT')
    except BaseException:
        stop()
        raise


def watch():
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        while owned_pid('policy'):
            time.sleep(2)
            changed = digest(SOURCE) != (BASE / 'policy.source.sha256').read_text().strip()
            oversized = any(p.stat().st_size > 4 * 1024 * 1024 for p in RUN.glob('*.log'))
            if changed or oversized:
                (RUN / 'contained.txt').write_text('Source policy changed' if changed else 'Lab log budget exceeded')
                break
    finally:
        # No restart or direct fallback. An explicit stop/start is required.
        terminate('policy')


def status():
    current = (BASE / 'policy.source.sha256').exists() and digest(SOURCE) == (BASE / 'policy.source.sha256').read_text().strip()
    return {'policy_running': bool(owned_pid('policy')), 'watch_running': bool(owned_pid('watch')),
            'source_current': current, 'boot_persistent': False,
            'contained': (RUN / 'contained.txt').exists()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', 'preflight', 'watch'])
    args = parser.parse_args()
    os.umask(0o077)
    RUN.mkdir(parents=True, mode=0o700, exist_ok=True)
    if args.action == 'watch':
        watch()
        return
    lock = (RUN / 'lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        if args.action == 'status':
            print(json.dumps(status()))
        else:
            if args.action == 'start':
                (RUN / 'contained.txt').unlink(missing_ok=True)
                start()
            elif args.action == 'stop':
                stop()
            else:
                preflight()
            print(json.dumps({'ok': True, 'action': args.action}))
    except Exception:
        print('AnyTLS lab operation failed; inspect private runtime evidence', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
