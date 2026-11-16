"""Sanitize completed Channel D HTTP/2 CONNECT access records."""
import hashlib
import json
import math
import re
from datetime import datetime, timedelta, timezone


def validate_profiles(profiles):
    if not isinstance(profiles, dict) or not profiles:
        raise ValueError('missing private Channel D profile map')
    keys = []
    for user, profile in profiles.items():
        if not isinstance(user, str) or not user or not isinstance(profile, dict):
            raise ValueError('invalid profile map')
        slot, label = profile.get('client_key'), profile.get('client_label')
        if not isinstance(slot, str) or not re.fullmatch(r'D-\d{2}', slot):
            raise ValueError('invalid profile slot')
        if not isinstance(label, str) or not label or len(label) > 120 or any(c in label for c in '\r\n'):
            raise ValueError('invalid profile label')
        keys.append(slot)
    if len(keys) != len(set(keys)):
        raise ValueError('duplicate profile slot')
    return profiles


def parse_record(raw, profiles, file_id, offset):
    row = json.loads(raw)
    if not isinstance(row, dict):
        raise ValueError('invalid log')
    if row.get('method') != 'CONNECT' or row.get('status') != 200:
        return None, None
    user = row.get('user_id')
    if not user or str(user).startswith(('invalid:', 'invalidformat:', 'invalidbase64:')):
        return None, None
    if user not in profiles:
        return None, 'unmapped_profile'
    if row.get('proto') not in ('HTTP/2.0', 'HTTP/3.0'):
        return None, 'unsupported_protocol'
    up, down = row.get('bytes_read'), row.get('size')
    if type(up) is not int or type(down) is not int or min(up, down) < 0:
        raise ValueError('invalid byte counters')
    ts, duration = row.get('ts'), row.get('duration')
    if type(ts) not in (int, float) or type(duration) not in (int, float) or not math.isfinite(ts) or not math.isfinite(duration) or duration < 0:
        raise ValueError('invalid log timestamp')
    end = datetime.fromtimestamp(ts, timezone.utc)
    start = end - timedelta(seconds=max(duration, .001))
    def iso(value):
        return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    identity = hashlib.sha256((file_id + ':' + str(offset) + ':').encode() + raw).hexdigest()
    profile = profiles[user]
    return {'sample_id': identity, 'channel': 'D', 'client_key': profile['client_key'],
            'client_label': profile['client_label'], 'start': iso(start), 'ts': iso(end),
            'bytes_up': up, 'bytes_down': down}, None
