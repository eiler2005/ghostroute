"""Preserve private Channel D username-to-slot identities across updates."""
import re


def merge_profiles(existing, clients):
    if not isinstance(existing, dict) or not isinstance(clients, list):
        raise ValueError('invalid profile inventory')
    result = {user: dict(profile) for user, profile in existing.items()}
    used = set()
    for user, profile in result.items():
        slot = profile.get('client_key', '')
        if not isinstance(user, str) or not user or not re.fullmatch(r'D-\d{2}', slot) or slot in used:
            raise ValueError('invalid existing slot')
        used.add(slot)
    seen = set()
    for client in clients:
        if not isinstance(client, dict):
            raise ValueError('invalid profile')
        user, label = client.get('username'), client.get('name')
        if not isinstance(user, str) or not user or user in seen or not isinstance(label, str) or not label or len(label) > 120 or any(c in label for c in '\r\n'):
            raise ValueError('invalid profile')
        seen.add(user)
        if user in result:
            result[user]['client_label'] = label
            continue
        slot = next(('D-%02d' % n for n in range(1, 100) if 'D-%02d' % n not in used), None)
        if slot is None:
            raise ValueError('no available profile slots')
        result[user] = {'client_key': slot, 'client_label': label}
        used.add(slot)
    return result
