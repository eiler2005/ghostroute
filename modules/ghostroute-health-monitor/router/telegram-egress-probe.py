#!/usr/bin/env python3
"""Bounded isolated router probes; never edits production routing or services."""
import concurrent.futures
import copy
import hashlib
import ipaddress
import json
from pathlib import Path
import secrets
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import tempfile
import time


def exact(stream, size):
    data = b''
    while len(data) < size:
        part = stream.recv(size - len(data))
        if not part:
            raise EOFError('incomplete response')
        data += part
    return data


def valid_res_pq(data, nonce):
    return (len(data) >= 40 and data[:8] == bytes(8)
            and struct.unpack('<I', data[16:20])[0] == len(data) - 20
            and data[20:24] == struct.pack('<I', 0x05162463)
            and data[24:40] == nonce)


def native_probe(port, target, timeout):
    label, address, destination_port = target
    started = time.monotonic()
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=timeout) as s:
            s.settimeout(timeout)
            s.sendall(b'\x05\x01\x00')
            if exact(s, 2) != b'\x05\x00':
                raise ValueError('SOCKS authentication')
            s.sendall(b'\x05\x01\x00\x01' + socket.inet_aton(address) + struct.pack('!H', destination_port))
            head = exact(s, 4)
            if head[:3] != b'\x05\x00\x00':
                raise ValueError('SOCKS connect')
            if head[3] == 1:
                exact(s, 4)
            elif head[3] == 4:
                exact(s, 16)
            elif head[3] == 3:
                exact(s, exact(s, 1)[0])
            else:
                raise ValueError('SOCKS address type')
            exact(s, 2)
            nonce = secrets.token_bytes(16)
            body = struct.pack('<I', 0xbe7e8ef1) + nonce
            packet = bytes(8) + struct.pack('<Q', int(time.time() * 2**32) & ~3) + struct.pack('<I', len(body)) + body
            s.sendall(b'\xef' + bytes([len(packet) // 4]) + packet)
            size = exact(s, 1)[0]
            if size == 127:
                size = int.from_bytes(exact(s, 3), 'little')
            if not 0 < size < 262144:
                raise ValueError('MTProto frame length')
            ok = valid_res_pq(exact(s, size * 4), nonce)
            return {'target': label, 'ok': ok, 'seconds': round(time.monotonic() - started, 3)}
    except Exception as exc:
        return {'target': label, 'ok': False, 'error': type(exc).__name__,
                'seconds': round(time.monotonic() - started, 3)}


def raw_probe(outbound, timeout):
    result = {'tcp': False, 'tls': False}
    try:
        with socket.create_connection((outbound['server'], outbound['server_port']), timeout=timeout) as s:
            result['tcp'] = True
            s.settimeout(timeout)
            with ssl._create_unverified_context().wrap_socket(s, server_hostname=outbound['tls']['server_name']):
                result['tls'] = True
    except Exception as exc:
        result['error'] = type(exc).__name__
    return result


def transfer(port, url, timeout):
    try:
        p = subprocess.run(['/opt/bin/curl', '-4', '-fsS', '--connect-timeout', str(timeout),
                            '--max-time', str(timeout * 2), '--proxy', 'socks5h://127.0.0.1:' + str(port),
                            '--max-filesize', '2097152', url], capture_output=True, timeout=timeout * 2 + 2)
        return p.returncode == 0 and bool(p.stdout), p.stdout
    except subprocess.TimeoutExpired:
        return False, b''


def qualifies(native, web, identity, unchanged):
    return (bool(native) and all(row['ok'] for row in native) and bool(web)
            and all(web.values()) and identity in ('matches_configured', 'observed_not_home') and unchanged)


def run_probe(payload):
    def interrupted(signum, frame):
        raise SystemExit('diagnostic interrupted')
    for signum in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    os_path = Path('/opt/etc/sing-box/config.json')
    before = os_path.read_bytes()
    source = json.loads(before)
    wan = subprocess.run(['nvram', 'get', 'wan0_ipaddr'], capture_output=True, text=True, timeout=5).stdout.strip()
    roles = payload['backends']
    timeout = payload['timeout']
    results = {role: {'native': [], 'web': {}, 'exit_identity': 'failed'} for role in roles}
    with tempfile.TemporaryDirectory(prefix='gr-tg-qualification-', dir='/tmp') as temporary:
        root = Path(temporary)
        binary = root / 'gr-tg-probe'
        shutil.copy2('/opt/bin/sing-box', binary)
        reservations = []
        ports = {}
        try:
            for role in roles:
                s = socket.socket()
                s.bind(('127.0.0.1', 0))
                ports[role] = s.getsockname()[1]
                reservations.append(s)
            # Preserve resolver definitions, but never route diagnostic traffic
            # through any production outbound or production catch-all.
            probe = {'log': {'level': 'error'}, 'dns': copy.deepcopy(source['dns']),
                     'inbounds': [{'type': 'socks', 'tag': role, 'listen': '127.0.0.1', 'listen_port': ports[role]} for role in roles],
                     'outbounds': [dict(item['outbound'], tag=role) for role, item in roles.items()],
                     'route': {'default_domain_resolver': 'cover-dns-server',
                               'rules': [{'inbound': role, 'outbound': role} for role in roles], 'final': next(iter(roles))}}
            # Existing DNS definitions may reference reality-out. Keep this
            # definition available for config validation only; native tests use
            # raw IPv4 and each backend owns every probe request on its inbound.
            production = next(o for o in source['outbounds'] if o['tag'] == 'reality-out')
            probe['outbounds'].append(production)
            config = root / 'config.json'
            config.write_text(json.dumps(probe))
            config.chmod(0o600)
            checked = subprocess.run([str(binary), 'check', '-c', str(config)], capture_output=True, timeout=15)
            if checked.returncode:
                raise RuntimeError('isolated config validation failed')
        finally:
            for s in reservations:
                s.close()
        with (root / 'runtime.log').open('wb') as log:
            process = subprocess.Popen([str(binary), 'run', '-c', str(config)], stdout=log, stderr=log)
            try:
                time.sleep(1)
                if process.poll() is not None:
                    raise RuntimeError('isolated probe failed to start')
                with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                    raw = {role: pool.submit(raw_probe, item['outbound'], timeout) for role, item in roles.items()}
                    for role, future in raw.items():
                        results[role]['raw_advisory'] = future.result()
                    for round_number in range(1, payload['rounds'] + 1):
                        jobs = [(role, pool.submit(native_probe, ports[role], target, timeout)) for role in roles for target in payload['targets']]
                        for role, future in jobs:
                            results[role]['native'].append(dict(future.result(), round=round_number))
                        if round_number < payload['rounds']:
                            time.sleep(2)
                    jobs = [(role, label, pool.submit(transfer, ports[role], url, timeout))
                            for role in roles for label, url in [('telegram', 'https://telegram.org/'), ('web', 'https://web.telegram.org/')]]
                    for role, label, future in jobs:
                        results[role]['web'][label] = future.result()[0]
                    for role, item in roles.items():
                        ok, value = transfer(ports[role], 'https://api.ipify.org', timeout)
                        if ok:
                            try:
                                address = str(ipaddress.IPv4Address(value.decode().strip()))
                                expected = item.get('expected_exit')
                                results[role]['exit_identity'] = ('home_leak' if address == wan else
                                    'matches_configured' if expected and address == expected else
                                    'mismatch' if expected else 'observed_not_home')
                            except ValueError:
                                pass
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
    unchanged = hashlib.sha256(before).digest() == hashlib.sha256(os_path.read_bytes()).digest()
    for row in results.values():
        row['eligible_for_client_trial'] = qualifies(row['native'], row['web'], row['exit_identity'], unchanged)
    return {'schema_version': 1, 'vantage': 'router', 'production_config_unchanged': unchanged,
            'client_messages_and_media': 'not_tested', 'backends': results}
