#!/opt/bin/python3
"""Explicit, non-boot-persistent Amn lab. Own only gr-amn* interfaces and GR_AMN* chains."""
import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

BASE = Path('/opt/etc/ghostroute-amn')
RUN = Path('/tmp/ghostroute-amn')
IFACE, TUN = 'gr-amn', 'gr-amn-tun'
SOURCE = Path('/opt/etc/sing-box/config.json')


def call(*args, check=True):
    p = subprocess.run(args, capture_output=True, text=True, timeout=15)
    if check and p.returncode:
        if RUN.exists():
            (RUN / 'last-error.private.json').write_text(json.dumps({'argv': args, 'stderr': p.stderr, 'returncode': p.returncode}))
        raise RuntimeError('Amn command failed: ' + args[0])
    return p


def ipt(family, *args, check=True):
    # Merlin's built-in iptables predates -w; the controller has its own lock.
    return call(family, *args, check=check)


def validate_settings(s):
    net = ipaddress.ip_network(s['subnet'])
    address = ipaddress.ip_interface(s['server_address'])
    policy = ipaddress.ip_interface(s['policy_address'])
    assert net.version == 4 and net.is_private and net.prefixlen == 24
    assert address.network == net and policy.network.subnet_of(net) and policy.network.prefixlen == 30
    assert 1024 < s['port'] <= 65535 and 200 <= s['table'] < 30000 and 1000 <= s['priority'] < 30000
    assert 1180 <= s['mtu'] <= 1380 and 1 <= len(s['peers']) <= 9
    reserved = {net[0], net[1], net[53]} | set(policy.network)
    for peer in s['peers']:
        address = ipaddress.ip_address(peer['address'])
        if address not in net or address in reserved:
            raise ValueError('Peer address is outside the usable client slots')
        keyhex(peer['public_key'])
        keyhex(peer['preshared_key'])
    keyhex(s['private_key'])
    for field in ('address', 'public_key', 'preshared_key'):
        if len({p[field] for p in s['peers']}) != len(s['peers']):
            raise ValueError('Peer addresses and credentials must be unique')
    return s


def settings():
    return validate_settings(json.loads((BASE / 'settings.json').read_text()))


def uapi(payload):
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect('/var/run/amneziawg/' + IFACE + '.sock')
        sock.sendall(payload.encode())
        data = b''
        while not data.endswith(b'\n\n'):
            part = sock.recv(8192)
            if not part:
                break
            data += part
    if 'errno=0\n' not in data.decode():
        raise RuntimeError('Amn control request failed')
    return data.decode()


def keyhex(value):
    data = base64.b64decode(value, validate=True)
    assert len(data) == 32
    return data.hex()


def configure(s):
    lines = ['set=1', 'private_key=' + keyhex(s['private_key']), 'listen_port=' + str(s['port'])]
    for k, v in s['obfuscation'].items():
        assert k in {'jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4'}
        assert str(v).isdigit()
        lines.append(k + '=' + str(v))
    for peer in s['peers']:
        lines += ['public_key=' + keyhex(peer['public_key']), 'preshared_key=' + keyhex(peer['preshared_key']), 'replace_allowed_ips=true', 'allowed_ip=' + peer['address'] + '/32']
    uapi('\n'.join(lines) + '\n\n')


def peer_state(raw):
    result = {}
    current = None
    for line in raw.splitlines():
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key == 'public_key':
            current = value
            result[current] = {'allowed_ip': []}
        elif current is not None:
            if key == 'allowed_ip':
                result[current]['allowed_ip'].append(value)
            else:
                result[current][key] = value
    return result


def verify_peer_state(s, live, exact=True):
    expected = {keyhex(p['public_key']): p for p in s['peers']}
    if (exact and set(live) != set(expected)) or (not exact and not set(live) <= set(expected)):
        raise ValueError('Live peers do not match the reviewed settings')
    for key, state in live.items():
        peer = expected[key]
        if state.get('preshared_key') != keyhex(peer['preshared_key']) or state['allowed_ip'] != [peer['address'] + '/32']:
            raise ValueError('Live peer credentials or AllowedIPs differ')


def verify_transport(s, raw):
    device = {}
    for line in raw.splitlines():
        if line.startswith('public_key='):
            break
        if '=' in line:
            key, value = line.split('=', 1)
            device[key] = value
    expected = dict(s['obfuscation'])
    expected['private_key'] = keyhex(s['private_key'])
    expected['listen_port'] = s['port']
    if any(device.get(key) != str(value) for key, value in expected.items()):
        raise ValueError('Running server identity or transport differs from settings')


def sync_peers(s):
    """Add reviewed peers live; existing identities and transport cannot change."""
    if not owned_pid('engine') or not owned_pid('policy'):
        raise ValueError('Amn must be running before adding peers')
    old = validate_settings(json.loads((RUN / 'owned.json').read_text()))
    if {k: v for k, v in old.items() if k != 'peers'} != {k: v for k, v in s.items() if k != 'peers'}:
        raise ValueError('Live peer sync cannot change server identity, transport or routing')
    previous = {p['public_key']: p for p in old['peers']}
    proposed = {p['public_key']: p for p in s['peers']}
    if not set(previous) <= set(proposed) or any(proposed[k] != p for k, p in previous.items()):
        raise ValueError('Live peer sync cannot remove or rotate existing clients')
    raw = uapi('get=1\n\n')
    verify_transport(s, raw)
    before = peer_state(raw)
    verify_peer_state(s, before, exact=False)
    if not {keyhex(k) for k in previous} <= set(before):
        raise ValueError('An existing client is absent from the running engine')
    additions = [p for p in s['peers'] if keyhex(p['public_key']) not in before]
    try:
        if additions:
            lines = ['set=1']
            for peer in additions:
                lines += ['public_key=' + keyhex(peer['public_key']), 'preshared_key=' + keyhex(peer['preshared_key']),
                          'replace_allowed_ips=true', 'allowed_ip=' + peer['address'] + '/32']
            uapi('\n'.join(lines) + '\n\n')
        verify_peer_state(s, peer_state(uapi('get=1\n\n')))
        temporary = RUN / '.owned.new'
        temporary.write_text(json.dumps(s))
        os.replace(temporary, RUN / 'owned.json')
    except Exception:
        # Remove only this operation's new keys; never replace the whole peer set.
        try:
            if additions:
                lines = ['set=1']
                for peer in additions:
                    lines += ['public_key=' + keyhex(peer['public_key']), 'remove=true']
                uapi('\n'.join(lines) + '\n\n')
        finally:
            temporary = BASE / '.settings.rollback'
            temporary.write_text(json.dumps(old, indent=2) + '\n')
            os.replace(temporary, BASE / 'settings.json')
        raise
    return {'added_peers': len(additions), 'configured_peers': len(s['peers'])}


def preflight(s):
    assert Path('/dev/net/tun').is_char_device()
    assert (BASE / 'amneziawg-go').is_file()
    assert hashlib.sha256(SOURCE.read_bytes()).hexdigest() == (BASE / 'policy.source.sha256').read_text().strip(), 'Production policy changed; refresh the lab projection'
    call(str(BASE / 'sing-box-amn'), 'check', '-c', str(BASE / 'policy.json'))
    for iface in (IFACE, TUN):
        assert call('ip', 'link', 'show', iface, check=False).returncode != 0, 'Amn interface already exists'
    assert not any(line.startswith(str(s['priority']) + ':') for line in call('ip', 'rule', 'show').stdout.splitlines()), 'Routing priority occupied'
    table = call('ip', 'route', 'show', 'table', str(s['table']), check=False)
    assert table.returncode == 0 or 'FIB table does not exist' in table.stderr, 'Cannot inspect candidate routing table'
    assert not table.stdout.strip(), 'Routing table occupied'
    net = ipaddress.ip_network(s['subnet'])
    for line in call('ip', '-4', 'route', 'show', 'table', 'all').stdout.splitlines():
        for token in line.split()[:2]:
            try:
                candidate = ipaddress.ip_network(token, strict=False)
            except ValueError:
                continue
            assert candidate.prefixlen == 0 or not candidate.overlaps(net), 'Peer subnet overlaps a current route'
    for family in ('iptables', 'ip6tables'):
        rules = call(family + '-save').stdout
        assert 'GR_AMN_' not in rules, 'Amn chain name already occupied'
        assert '--dport ' + str(s['port']) + ' ' not in rules, 'Port already referenced by firewall'
    for line in call('netstat', '-ln').stdout.splitlines():
        if line.startswith(('tcp', 'udp')):
            assert line.split()[3].rsplit(':', 1)[-1] != str(s['port']), 'Listener already occupied'
    memory = {line.split(':')[0]: line.split(':')[1].strip().split()[0] for line in Path('/proc/meminfo').read_text().splitlines()}
    assert int(memory['MemAvailable']) >= 150 * 1024, 'Insufficient free memory for lab'


def guards(s):
    for family in ('iptables', 'ip6tables'):
        for chain in ('GR_AMN_LOCAL', 'GR_AMN_FWD', 'GR_AMN_UDP'):
            ipt(family, '-N', chain)
        ipt(family, '-A', 'GR_AMN_LOCAL', '-j', 'DROP')
        if family == 'iptables':
            ipt(family, '-A', 'GR_AMN_FWD', '-i', IFACE, '-o', TUN, '-s', s['subnet'], '-j', 'ACCEPT')
            ipt(family, '-A', 'GR_AMN_FWD', '-i', TUN, '-o', IFACE, '-d', s['subnet'], '-j', 'ACCEPT')
        ipt(family, '-A', 'GR_AMN_FWD', '-j', 'DROP')
        ipt(family, '-A', 'GR_AMN_UDP', '-j', 'DROP')
        ipt(family, '-I', 'INPUT', '1', '-i', IFACE, '-j', 'GR_AMN_LOCAL')
        ipt(family, '-I', 'INPUT', '1', '-p', 'udp', '--dport', str(s['port']), '-j', 'GR_AMN_UDP')
        for iface in (IFACE, TUN):
            ipt(family, '-I', 'FORWARD', '1', '-i', iface, '-j', 'GR_AMN_FWD')


def spawn(name, argv):
    path = RUN / (name + '.log')
    if path.exists() and path.stat().st_size > 1024 * 1024:
        path.unlink()
    with path.open('ab') as log:
        env = dict(os.environ, GOMAXPROCS='2', GOMEMLIMIT='64MiB', LOG_LEVEL='error')
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True)
    (RUN / (name + '.pid')).write_text(str(proc.pid))
    return proc


def wait_for(predicate):
    for _ in range(40):
        if predicate():
            return
        time.sleep(.2)
    raise RuntimeError('Amn startup timed out')


def owned_pid(name):
    try:
        pid = int((RUN / (name + '.pid')).read_text())
        cmd = Path('/proc/' + str(pid) + '/cmdline').read_bytes()
        needle = str(BASE / ('amneziawg-go' if name == 'engine' else 'policy.json')).encode()
        return pid if needle in cmd else None
    except (OSError, ValueError):
        return None


def stop(s):
    # Close the new public ingress before dismantling its processing path.
    for family in ('iptables', 'ip6tables'):
        ipt(family, '-I', 'GR_AMN_UDP', '1', '-j', 'DROP', check=False)
    for name in ('engine', 'policy'):
        pid = owned_pid(name)
        if pid:
            os.kill(pid, signal.SIGTERM)
            for _ in range(30):
                if not Path('/proc/' + str(pid)).exists():
                    break
                time.sleep(.1)
            if owned_pid(name):
                os.kill(pid, signal.SIGKILL)
        (RUN / (name + '.pid')).unlink(missing_ok=True)
    for iface in (IFACE, TUN):
        call('ip', 'link', 'del', iface, check=False)
    call('ip', 'rule', 'del', 'pref', str(s['priority']), 'iif', IFACE, 'lookup', str(s['table']), check=False)
    call('ip', 'route', 'flush', 'table', str(s['table']), check=False)
    for family in ('iptables', 'ip6tables'):
        ipt(family, '-D', 'INPUT', '-i', IFACE, '-j', 'GR_AMN_LOCAL', check=False)
        ipt(family, '-D', 'INPUT', '-p', 'udp', '--dport', str(s['port']), '-j', 'GR_AMN_UDP', check=False)
        for iface in (IFACE, TUN):
            ipt(family, '-D', 'FORWARD', '-i', iface, '-j', 'GR_AMN_FWD', check=False)
        for chain in ('GR_AMN_LOCAL', 'GR_AMN_FWD', 'GR_AMN_UDP'):
            ipt(family, '-F', chain, check=False)
            ipt(family, '-X', chain, check=False)
    (RUN / 'owned.json').unlink(missing_ok=True)


def start(s):
    if (RUN / 'owned.json').exists():
        raise RuntimeError('Lab already owns runtime state; stop it before redeploy')
    preflight(s)
    RUN.mkdir(mode=0o700, parents=True, exist_ok=True)
    (RUN / 'owned.json').write_text(json.dumps(s))
    try:
        guards(s)
        call('ip', 'route', 'add', 'unreachable', 'default', 'metric', '32760', 'table', str(s['table']))
        call('ip', 'rule', 'add', 'pref', str(s['priority']), 'iif', IFACE, 'lookup', str(s['table']))
        spawn('policy', [str(BASE / 'sing-box-amn'), 'run', '-c', str(BASE / 'policy.json')])
        wait_for(lambda: Path('/sys/class/net/' + TUN).exists())
        call('ip', 'route', 'add', 'default', 'dev', TUN, 'metric', '10', 'table', str(s['table']))
        spawn('engine', [str(BASE / 'amneziawg-go'), '-f', IFACE])
        wait_for(lambda: Path('/var/run/amneziawg/' + IFACE + '.sock').exists())
        configure(s)
        call('ip', 'address', 'add', s['server_address'], 'dev', IFACE)
        call('ip', 'link', 'set', 'dev', IFACE, 'mtu', str(s['mtu']), 'up')
        for iface in (IFACE, TUN):
            path = Path('/proc/sys/net/ipv4/conf') / iface / 'rp_filter'
            if path.exists():
                path.write_text('0')
        # Accept outer IPv4 UDP only after the guarded policy path is ready.
        ipt('iptables', '-I', 'GR_AMN_UDP', '1', '-j', 'ACCEPT')
        assert owned_pid('policy') and owned_pid('engine')
    except BaseException:
        stop(s)
        raise


def status():
    result = {'engine_running': bool(owned_pid('engine')), 'policy_running': bool(owned_pid('policy')), 'boot_persistent': False}
    if result['engine_running']:
        raw = uapi('get=1\n\n')
        handshakes = [int(line.split('=')[1]) for line in raw.splitlines() if line.startswith('last_handshake_time_sec=')]
        result['peers_with_handshake'] = sum(t > 0 for t in handshakes)
        result['configured_peers'] = len(peer_state(raw))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['preflight', 'start', 'stop', 'status', 'sync-peers'])
    args = parser.parse_args()
    os.umask(0o077)
    RUN.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (RUN / 'lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        if args.action == 'status':
            result = status()
        elif args.action == 'stop':
            if (RUN / 'owned.json').exists():
                stop(json.loads((RUN / 'owned.json').read_text()))
            result = {'stopped': True}
        elif args.action == 'sync-peers':
            result = sync_peers(settings())
        else:
            s = settings()
            (preflight if args.action == 'preflight' else start)(s)
            result = {'ok': True, 'action': args.action}
        print(json.dumps(result))
    except Exception as exc:
        print('Amn operation failed: ' + str(exc), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
