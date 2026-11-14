#!/opt/bin/python3
"""Channel anyT lifecycle: isolated AnyTLS process, policy and INPUT ownership."""
import argparse
import fcntl
import hashlib
import importlib.util
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
INPUT_CACHE = {}


def call(*args, check=True):
    p = subprocess.run(args, capture_output=True, text=True, timeout=20)
    if check and p.returncode:
        (RUN / 'last-error.private.json').write_text(json.dumps({'command': args, 'stderr': p.stderr}))
        raise RuntimeError('Lab command failed; inspect private error file')
    return p


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def input_signature():
    """Content fingerprint: ignore identical rewrites of shared catalog files."""
    source = json.loads(SOURCE.read_text())
    settings = json.loads((BASE / 'settings.json').read_text())
    files = [SOURCE, BASE / 'settings.json', Path(settings['certificate_path']), Path(settings['key_path'])]
    for item in source['route'].get('rule_set', []):
        if item.get('type') != 'local' or not item.get('path'):
            raise ValueError('Channel anyT requires explicit local rule-set ownership')
        files.append(Path(item['path']))
    values = []
    for path in files:
        stat = path.stat()
        key = (stat.st_ino, stat.st_mtime_ns, stat.st_size)
        if path not in INPUT_CACHE or INPUT_CACHE[path][0] != key:
            INPUT_CACHE[path] = (key, digest(path))
        values.append((str(path), INPUT_CACHE[path][1]))
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()


def refresh_policy():
    spec = importlib.util.spec_from_file_location('anyt_policy', BASE / 'channel-anytls-policy.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raw = SOURCE.read_bytes()
    config = module.project(json.loads(raw), json.loads((BASE / 'settings.json').read_text()))
    temporary = BASE / 'policy.next.json'
    temporary.write_text(json.dumps(config, indent=2) + '\n')
    try:
        call(str(BASE / 'sing-box-atls'), 'check', '-c', str(temporary))
        if SOURCE.read_bytes() != raw:
            raise ValueError('Production policy changed during projection')
        os.replace(temporary, BASE / 'policy.json')
        (BASE / 'policy.source.sha256').write_text(hashlib.sha256(raw).hexdigest() + '\n')
    finally:
        temporary.unlink(missing_ok=True)


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
    (BASE / 'inputs.sha256').write_text(input_signature() + '\n')
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
            changed = input_signature() != (BASE / 'inputs.sha256').read_text().strip()
            oversized = any(p.stat().st_size > 4 * 1024 * 1024 for p in RUN.glob('*.log'))
            if changed or oversized:
                (RUN / 'contained.txt').write_text('Source policy changed' if changed else 'Lab log budget exceeded')
                break
    finally:
        # Close stale policy first. The separate recovery owner may reconcile it.
        terminate('policy')


def firewall_present(port):
    return call('iptables', '-C', 'INPUT', '-p', 'tcp', '--dport', str(port), '-j', CHAIN, check=False).returncode == 0


def repair_firewall(s):
    """Restore only our port-scoped chain after firmware firewall rebuilds."""
    existing = call('iptables', '-S', CHAIN, check=False)
    if existing.returncode:
        call('iptables', '-N', CHAIN)
        call('iptables', '-A', CHAIN, '-i', 'lo', '-j', 'ACCEPT')
        call('iptables', '-A', CHAIN, '-j', 'DROP')
        call('iptables', '-I', CHAIN, '1', '-j', 'ACCEPT')
    else:
        rules = [line for line in existing.stdout.splitlines() if line.startswith('-A ')]
        expected = ['-A ' + CHAIN + ' -j ACCEPT', '-A ' + CHAIN + ' -i lo -j ACCEPT', '-A ' + CHAIN + ' -j DROP']
        if rules != expected:
            raise ValueError('Unexpected Channel anyT chain contents require review')
    if not firewall_present(s['port']):
        call('iptables', '-I', 'INPUT', '1', '-p', 'tcp', '--dport', str(s['port']), '-j', CHAIN)


def reconcile():
    if not (BASE / 'enabled').is_file():
        return {'enabled': False}
    s = json.loads((BASE / 'settings.json').read_text())
    try:
        current = (BASE / 'inputs.sha256').is_file() and input_signature() == (BASE / 'inputs.sha256').read_text().strip()
    except Exception:
        stop()
        raise
    if current and owned_pid('policy') and owned_pid('watch') and ready(s['port']):
        repair_firewall(s)
        return {'enabled': True, 'restarted': False}
    # Contain first, then project the current policy. Never revive a stale exit.
    stop()
    refresh_policy()
    (RUN / 'contained.txt').unlink(missing_ok=True)
    start()
    return {'enabled': True, 'restarted': True}


def status():
    current = (BASE / 'policy.source.sha256').exists() and digest(SOURCE) == (BASE / 'policy.source.sha256').read_text().strip()
    users = json.loads((BASE / 'settings.json').read_text())['users'] if (BASE / 'settings.json').is_file() else []
    return {'policy_running': bool(owned_pid('policy')), 'watch_running': bool(owned_pid('watch')),
            'source_current': current, 'boot_persistent': (BASE / 'enabled').is_file(),
            'channel': 'Channel anyT', 'clients_configured': sum(u['name'] != 'lab-probe' for u in users),
            'contained': (RUN / 'contained.txt').exists()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', 'preflight', 'watch', 'enable', 'disable', 'reconcile'])
    args = parser.parse_args()
    os.umask(0o077)
    RUN.mkdir(parents=True, mode=0o700, exist_ok=True)
    if args.action == 'watch':
        watch()
        return
    lock = (RUN / 'lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == 'status':
            print(json.dumps(status()))
        else:
            if args.action == 'start':
                (RUN / 'contained.txt').unlink(missing_ok=True)
                start()
            elif args.action == 'stop':
                stop()
            elif args.action == 'disable':
                (BASE / 'enabled').unlink(missing_ok=True)
                call('cru', 'd', 'ChannelAnyT', check=False)
                stop()
            elif args.action in ('enable', 'reconcile'):
                if args.action == 'enable':
                    (BASE / 'enabled').write_text('enabled\n')
                    call('cru', 'd', 'ChannelAnyT', check=False)
                    call('cru', 'a', 'ChannelAnyT', '* * * * * /opt/bin/python3 /opt/etc/ghostroute-anytls/channel-anytls.py reconcile')
                reconcile()
            else:
                preflight()
            print(json.dumps({'ok': True, 'action': args.action}))
    except BlockingIOError:
        if args.action == 'reconcile':
            return
        print('Channel anyT operation is already running', file=sys.stderr)
        sys.exit(1)
    except Exception as exc:
        (RUN / 'operation-error.private.json').write_text(json.dumps({'action': args.action, 'error': str(exc)}))
        print('Channel anyT operation failed; inspect private runtime evidence', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
