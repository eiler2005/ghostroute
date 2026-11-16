#!/opt/bin/python3
"""Poll loopback-only isolated channel counters without changing routing."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent))
from isolated_channel_store import open_store, ingest, record_gap
from amn_counters import extract as extract_amn, profile_keys as amn_profile_keys
from channel_d_spool import collect as collect_d

STATE = Path('/opt/var/log/router_configuration')
CLIENT = '/opt/libexec/ghostroute-channel-stats'
CHANNELS = {
    'anyT': ('/opt/etc/ghostroute-anytls/sing-box-atls', '/opt/etc/ghostroute-anytls/policy.json',
             ['lab-client'] + ['lab-client-%02d' % n for n in range(2, 9)]),
    'Snell': ('/opt/etc/ghostroute-snell/sing-box-snell', '/opt/etc/ghostroute-snell/policy.json',
              ['snell-lab-%d' % n for n in range(1, 4)]),
}


def process_instance(binary, config_path):
    matches = []
    boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        try:
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            if args[:4] != [binary.encode(), b'run', b'-c', config_path.encode()]:
                continue
            stat = (entry / 'stat').read_text()
            start_ticks = stat[stat.rindex(')') + 2:].split()[19]
            matches.append(boot_id + ':' + entry.name + ':' + start_ticks)
        except (OSError, ValueError, IndexError):
            continue
    if len(matches) != 1:
        raise RuntimeError('channel process not uniquely identified')
    return matches[0]


def collect(channel, binary, config_path, expected_users):
    config = json.loads(Path(config_path).read_text())
    api = config.get('experimental', {}).get('v2ray_api', {})
    stats = api.get('stats', {})
    if not stats.get('enabled') or not set(expected_users) <= set(stats.get('users', [])):
        raise RuntimeError('profile counters are not enabled')
    before = process_instance(binary, config_path)
    response = subprocess.run([CLIENT, api.get('listen', '')], capture_output=True, check=True, timeout=10)
    counters = json.loads(response.stdout)['stat']
    after = process_instance(binary, config_path)
    if before != after:
        raise RuntimeError('channel process changed during query')
    return {'channel': channel, 'instance_id': before,
            'ts': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
            'stats': counters}


def amn_instance():
    pid = int(Path('/tmp/ghostroute-amn/engine.pid').read_text().strip())
    proc = Path('/proc') / str(pid)
    if b'/opt/etc/ghostroute-amn/amneziawg-go' not in (proc / 'cmdline').read_bytes().split(b'\0'):
        raise RuntimeError('Amn engine identity mismatch')
    stat = (proc / 'stat').read_text()
    ticks = stat[stat.rindex(')') + 2:].split()[19]
    boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    return boot_id + ':' + str(pid) + ':' + ticks


def collect_amn():
    path = Path('/opt/etc/ghostroute-amn/settings.json')
    settings_raw = path.read_bytes()
    before = amn_instance()
    response = b''
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(5)
        sock.connect('/var/run/amneziawg/gr-amn.sock')
        sock.sendall(b'get=1\n\n')
        while not response.endswith(b'\n\n'):
            chunk = sock.recv(8192)
            if not chunk or len(response) + len(chunk) > 1024 * 1024:
                raise RuntimeError('incomplete Amn response')
            response += chunk
    settings = json.loads(settings_raw)
    counters = extract_amn(settings, response.decode('utf-8'))
    if before != amn_instance() or settings_raw != path.read_bytes():
        raise RuntimeError('Amn changed during query')
    peer_fingerprint = hashlib.sha256(json.dumps(amn_profile_keys(settings), sort_keys=True).encode()).hexdigest()
    return {'channel': 'Amn', 'instance_id': before + ':' + peer_fingerprint,
            'ts': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
            'stats': counters}


def export(db, state_dir):
    target = state_dir / 'isolated-channel-deltas.jsonl'
    fd, temporary = tempfile.mkstemp(prefix='.isolated-channel-', dir=state_dir)
    try:
        with os.fdopen(fd, 'w') as stream:
            for (payload,) in db.execute('select payload from intervals order by ts, sample_id'):
                stream.write(payload + '\n')
            for channel, ts, reason in db.execute('select channel, ts, reason from gaps order by ts, channel'):
                stream.write(json.dumps({'kind': 'gap', 'channel': channel, 'ts': ts, 'reason': reason}, separators=(',', ':')) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def channel_d_logging_enabled():
    path = Path('/opt/etc/caddy/channel-d-naiveproxy/Caddyfile')
    try:
        config = path.read_text()
    except OSError:
        return False
    return all(item in config for item in ('channel-d-access.log', 'log_append method',
                                            'log_append proto', 'request delete', 'resp_headers delete'))


def main():
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True)
    with (STATE / 'isolated-channel.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = open_store(str(STATE / 'isolated-channel.sqlite'))
        errors = []
        for channel, args in CHANNELS.items():
            try:
                ingest(db, collect(channel, *args))
            except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError):
                errors.append(channel)
                now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
                record_gap(db, channel, now, 'sampling_failed')
        now = datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
        if not Path('/var/run/amneziawg/gr-amn.sock').exists():
            record_gap(db, 'Amn', now, 'inactive')
        else:
            try:
                ingest(db, collect_amn())
            except (OSError, ValueError, KeyError, IndexError, RuntimeError):
                errors.append('Amn')
                record_gap(db, 'Amn', now, 'sampling_failed')
        d_profiles = Path('/opt/etc/ghostroute-observability/channel-d-profiles.json')
        if not d_profiles.exists() or not channel_d_logging_enabled():
            record_gap(db, 'D', now, 'inactive')
        else:
            try:
                if collect_d(db, STATE, d_profiles, now):
                    with db:
                        db.execute('insert or replace into status values (?, 1)', ('D',))
                else:
                    record_gap(db, 'D', now, 'sampling_failed')
                    errors.append('D')
            except (OSError, ValueError, KeyError, RuntimeError):
                errors.append('D')
                record_gap(db, 'D', now, 'sampling_failed')
        cutoff = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat(timespec='seconds').replace('+00:00', 'Z')
        with db:
            db.execute('delete from intervals where ts < ?', (cutoff,))
            db.execute('delete from gaps where ts < ?', (cutoff,))
            db.execute('delete from log_cursors where updated_ts < ?', (cutoff,))
        export(db, STATE)
        db.close()
        if errors:
            print('Counter sample unavailable: ' + ', '.join(errors), file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
