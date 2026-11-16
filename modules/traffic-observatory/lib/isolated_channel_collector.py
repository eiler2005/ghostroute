"""Profile counter extraction for isolated sing-box instances.

Stats API dimensions overlap: only user counters are projected into client
traffic. Callers must verify the instance did not change across the query.
"""
import hashlib
import json
from datetime import datetime


def profile_counters(channel, stats):
    if channel == 'anyT':
        profiles = {'lab-client': 'anyT-01'}
        profiles.update({'lab-client-%02d' % n: 'anyT-%02d' % n for n in range(2, 9)})
    elif channel == 'Snell':
        profiles = {'snell-lab-%d' % n: 'Snell-%02d' % n for n in range(1, 4)}
    elif channel == 'Amn':
        profiles = {'Amn-%02d' % n: 'Amn-%02d' % n for n in range(1, 9)}
    else:
        raise ValueError('unknown channel')
    if not isinstance(stats, dict):
        raise ValueError('invalid stats response')
    result = {profile: {'up': 0, 'down': 0} for profile in profiles.values()}
    for user, profile in profiles.items():
        for direction, suffix in (('up', 'uplink'), ('down', 'downlink')):
            key = 'user>>>%s>>>traffic>>>%s' % (user, suffix)
            value = stats.get(key, 0)
            if type(value) is not int or value < 0:
                raise ValueError('invalid byte counter')
            result[profile][direction] = value
    return result


def profile_intervals(previous, current):
    """Produce deterministic records for consecutive samples of one process.

    A reset, restart or malformed sample never produces a fabricated delta.
    """
    if previous['channel'] != current['channel']:
        raise ValueError('channel mismatch')
    start = datetime.fromisoformat(previous['ts'].replace('Z', '+00:00'))
    end = datetime.fromisoformat(current['ts'].replace('Z', '+00:00'))
    if start.tzinfo is None or end.tzinfo is None or end <= start:
        raise ValueError('invalid interval')
    if not previous.get('instance_id') or previous['instance_id'] != current.get('instance_id'):
        return [], ['process_changed']
    before = profile_counters(previous['channel'], previous['stats'])
    after = profile_counters(current['channel'], current['stats'])
    rows, gaps = [], []
    for profile in sorted(before):
        up = after[profile]['up'] - before[profile]['up']
        down = after[profile]['down'] - before[profile]['down']
        if up < 0 or down < 0:
            gaps.append(profile + ':counter_reset')
            continue
        if not (up or down):
            continue
        raw_id = json.dumps([current['channel'], current['instance_id'], profile, previous['ts'], current['ts']], separators=(',', ':'))
        rows.append({'sample_id': hashlib.sha256(raw_id.encode()).hexdigest(),
                     'channel': current['channel'], 'client_key': profile,
                     'start': previous['ts'], 'ts': current['ts'],
                     'bytes_up': up, 'bytes_down': down})
    return rows, gaps
