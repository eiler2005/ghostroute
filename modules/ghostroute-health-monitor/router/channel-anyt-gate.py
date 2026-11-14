#!/usr/bin/env python3
"""Read-only production admission evidence; temporary loopback probe only."""
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time


def run():
    os.umask(0o077)
    base = Path('/opt/etc/ghostroute-anytls')
    if not (base / 'settings.json').exists():
        print(json.dumps({'installed': False}))
        return
    settings = json.loads((base / 'settings.json').read_text())
    status = json.loads(subprocess.check_output(['/opt/bin/python3', str(base / 'channel-anytls.py'), 'status']))
    if not all(status[k] for k in ('boot_persistent', 'policy_running', 'watch_running', 'source_current')) or status['contained']:
        raise ValueError('Production anyT is not ready')
    cron = subprocess.check_output(['cru', 'l'], text=True)
    if 'ChannelAnyT' not in cron:
        raise ValueError('Recovery cron missing')
    for name in ('services-start', 'firewall-start'):
        if 'channel-anytls.py' not in Path('/jffs/scripts/' + ('ghostroute-runtime-supervisor.sh' if name == 'services-start' else name)).read_text():
            raise ValueError('Recovery hook missing')
    subprocess.run(['iptables', '-C', 'INPUT', '-p', 'tcp', '--dport', str(settings['port']), '-j', 'GR_ATLS_IN'], check=True, capture_output=True)
    rules = subprocess.check_output(['iptables', '-S', 'GR_ATLS_IN'], text=True)
    if [r for r in rules.splitlines() if r.startswith('-A ')] != [
        '-A GR_ATLS_IN -j ACCEPT', '-A GR_ATLS_IN -i lo -j ACCEPT', '-A GR_ATLS_IN -j DROP']:
        raise ValueError('Unexpected admission rules')
    with tempfile.TemporaryDirectory(prefix='anyt-gate-', dir='/tmp') as tmp:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        config = {'log': {'level': 'error'},
                  'inbounds': [{'type': 'socks', 'listen': '127.0.0.1', 'listen_port': port}],
                  'outbounds': [{'type': 'anytls', 'server': '127.0.0.1', 'server_port': settings['port'],
                      'password': next(u['password'] for u in settings['users'] if u['name'] == 'lab-probe'),
                      'tls': {'enabled': True, 'server_name': settings['server_name']}}]}
        path = Path(tmp) / 'config.json'
        path.write_text(json.dumps(config))
        binary = str(base / 'sing-box-atls')
        subprocess.run([binary, 'check', '-c', str(path)], check=True, capture_output=True)
        with (Path(tmp) / 'log').open('wb') as log:
            process = subprocess.Popen([binary, 'run', '-c', str(path)], stdout=log, stderr=log)
            try:
                for _ in range(30):
                    if process.poll() is not None:
                        raise ValueError('Probe startup failed')
                    try:
                        with socket.create_connection(('127.0.0.1', port), timeout=.1):
                            break
                    except OSError:
                        time.sleep(.1)
                subprocess.run(['/opt/bin/curl', '-4', '-fsS', '--connect-timeout', '5', '--max-time', '15',
                                '--max-filesize', '1048576', '--proxy', 'socks5h://127.0.0.1:' + str(port),
                                'https://example.com/'], check=True, capture_output=True, timeout=18)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    # Private output consumed locally, never printed by the public command.
    print(json.dumps({'installed': True, 'settings': settings}))


if __name__ == '__main__':
    try:
        run()
    except Exception:
        raise SystemExit('anyT gate failed: inspect private runtime evidence') from None
