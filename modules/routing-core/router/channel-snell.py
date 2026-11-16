#!/usr/bin/env python3
"""Experimental Snell/ShadowTLS watcher; owns only its process and INPUT rules."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

BASE = Path('/opt/etc/ghostroute-snell')
RUN = Path('/tmp/ghostroute-snell')
BINARY = BASE / 'sing-box-snell'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def owned_pid():
    try:
        pid = int((RUN / 'watch.pid').read_text())
        argv = Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
        return pid if argv[:3] == [b'/opt/bin/python3', str(BASE / 'channel-snell.py').encode(), b'watch'] else None
    except (OSError, ValueError):
        return None


def select_stats(anyt, listen, stats, child, child_listen, suspended):
    if listen != suspended:
        suspended = None
    same_owner = child and child.poll() is None and child_listen == listen
    if stats and not same_owner and (suspended == listen or not anyt.stats_listener_available(listen)):
        return None, listen
    return stats, suspended


def watch():
    import fcntl
    with (RUN / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        (RUN / 'watch.pid').write_text(str(os.getpid()))
        anyt = load('anyt', '/opt/etc/ghostroute-anytls/channel-anytls-policy.py')
        snell = load('snell', BASE / 'channel-snell-policy.py')
        child = None
        previous = None
        child_stats_listen = None
        suspended_stats_listen = None
        def halt(*_):
            raise SystemExit()
        signal.signal(signal.SIGTERM, halt)
        try:
            while True:
                lease = Path('/tmp/ghostroute-egress-emergency.lock').open('a')
                try:
                    if Path('/opt/etc/ghostroute-egress-emergency/guard.py').exists():
                        fcntl.flock(lease, fcntl.LOCK_SH)
                    source = json.loads(Path('/opt/etc/sing-box/config.json').read_text())
                    settings = json.loads((BASE / 'settings.json').read_text())
                    reference = anyt.project(source, json.loads(Path('/opt/etc/ghostroute-anytls/settings.json').read_text()))
                    config = snell.project(reference, settings['slots'], settings['cover'])
                    observability = BASE / 'observability.json'
                    try:
                        listen = json.loads(observability.read_text())['stats_listen'] if observability.exists() else None
                        stats = anyt.stats_api(listen,
                                                ['snell-lab-' + str(i) for i in range(1, 4)],
                                                ['snell-lab-' + str(i) for i in range(1, 4)],
                                                [o['tag'] for o in config['outbounds']])
                    except (OSError, ValueError, KeyError, TypeError):
                        listen, stats = None, None
                    stats, suspended_stats_listen = select_stats(anyt, listen, stats, child, child_stats_listen, suspended_stats_listen)
                    if stats is not None:
                        config['experimental'] = stats
                    raw = json.dumps(config, sort_keys=True).encode()
                    fingerprint = hashlib.sha256(raw).hexdigest()
                    # Stop stale policy before accepting a changed configuration.
                    if child and (fingerprint != previous or child.poll() is not None):
                        child.terminate(); child.wait(timeout=10); child = None; child_stats_listen = None
                    if child is None:
                        path = BASE / 'policy.json'
                        path.write_bytes(raw)
                        subprocess.run([str(BINARY), 'check', '-c', str(path)], check=True, capture_output=True, timeout=20)
                        with (RUN / 'engine.log').open('ab') as log:
                            child = subprocess.Popen([str(BINARY), 'run', '-c', str(path)], stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                        child_stats_listen = listen if stats else None
                        previous = fingerprint
                    for slot in settings['slots']:
                        subprocess.run(['iptables', '-N', 'GR_SNELL_IN'], capture_output=True)
                        accept = ['GR_SNELL_IN', '-p', 'tcp', '--dport', str(slot['port']), '-j', 'ACCEPT']
                        if subprocess.run(['iptables', '-C'] + accept, capture_output=True).returncode:
                            subprocess.run(['iptables', '-A'] + accept, check=True, capture_output=True)
                        rule = ['INPUT', '-p', 'tcp', '--dport', str(slot['port']), '-j', 'GR_SNELL_IN']
                        if subprocess.run(['iptables', '-C'] + rule, capture_output=True).returncode:
                            subprocess.run(['iptables', '-I'] + rule, check=True, capture_output=True)
                    (RUN / 'healthy').write_text(str(time.time()))
                except Exception:
                    import traceback
                    (RUN / 'last-error.private.log').write_text(traceback.format_exc())
                    if child:
                        child.terminate(); child.wait(timeout=10); child = None
                    (RUN / 'healthy').unlink(missing_ok=True)
                finally:
                    lease.close()
                time.sleep(2)
        finally:
            if child:
                child.terminate(); child.wait(timeout=10)
            (RUN / 'watch.pid').unlink(missing_ok=True)
            (RUN / 'healthy').unlink(missing_ok=True)


def main():
    guard = Path('/opt/etc/ghostroute-egress-emergency/guard.py')
    if guard.exists() and os.environ.get('GR_EGRESS_GUARD_WRAPPED') != '1' and sys.argv[1:2] != ['watch']:
        os.execv('/opt/bin/python3', ['/opt/bin/python3', str(guard), '--', '/opt/bin/python3', __file__, *sys.argv[1:]])
    os.umask(0o077)
    RUN.mkdir(mode=0o700, exist_ok=True)
    action = sys.argv[1]
    pid = owned_pid()
    if action == 'watch':
        watch()
    elif action == 'start':
        if not pid:
            with (RUN / 'watch.log').open('ab') as log:
                subprocess.Popen(['/opt/bin/python3', str(BASE / 'channel-snell.py'), 'watch'], stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    elif action == 'stop':
        if pid:
            os.kill(pid, signal.SIGTERM)
            for _ in range(100):
                if not owned_pid(): break
                time.sleep(.1)
            else: raise RuntimeError('Watcher did not stop')
        for slot in json.loads((BASE / 'settings.json').read_text())['slots']:
            rule = ['INPUT', '-p', 'tcp', '--dport', str(slot['port']), '-j', 'GR_SNELL_IN']
            while subprocess.run(['iptables', '-C'] + rule, capture_output=True).returncode == 0:
                subprocess.run(['iptables', '-D'] + rule, check=True, capture_output=True)
            subprocess.run(['iptables', '-D', 'GR_SNELL_IN', '-p', 'tcp', '--dport', str(slot['port']), '-j', 'ACCEPT'], capture_output=True)
        subprocess.run(['iptables', '-X', 'GR_SNELL_IN'], capture_output=True)
    elif action == 'status':
        healthy = RUN / 'healthy'
        print(json.dumps({'watch_running': bool(pid), 'recent_policy_check': bool(healthy.exists() and time.time()-float(healthy.read_text()) < 10)}))
    else:
        raise ValueError('Expected start/stop/watch/status')


if __name__ == '__main__':
    main()
