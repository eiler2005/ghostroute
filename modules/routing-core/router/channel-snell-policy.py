#!/usr/bin/env python3
"""Isolated Snell v4-compatible listeners behind strict ShadowTLS v3."""
import copy


def project(reference, slots, cover):
    if len(slots) != 3 or len({s['port'] for s in slots}) != 3:
        raise ValueError('Require three distinct lab listeners')
    passwords = [s[k] for s in slots for k in ('psk', 'shadowtls_password')]
    if len(set(passwords)) != 6 or any(len(p) < 32 for p in passwords):
        raise ValueError('Require six distinct strong credentials')
    if any(type(s['port']) is not int or not 1024 < s['port'] <= 65535 for s in slots):
        raise ValueError('Invalid listener')
    if not cover or any(c in cover for c in '/@?# \r\n'):
        raise ValueError('Invalid cover hostname')
    if len(reference.get('inbounds', [])) != 1 or reference['inbounds'][0]['type'] != 'anytls':
        raise ValueError('Require reviewed AnyTLS policy projection')
    old_tag = reference['inbounds'][0]['tag']
    result = copy.deepcopy(reference)
    # The reference may carry AnyTLS telemetry. Snell owns a separate API.
    result.pop('experimental', None)
    result['log'] = {'level': 'warn', 'output': '/tmp/ghostroute-snell/policy.log', 'timestamp': True}
    result['inbounds'] = []
    tags = ['snell-lab-' + str(i) for i in range(1, 4)]
    for slot, tag in zip(slots, tags):
        result['inbounds'] += [
            {'type': 'shadowtls', 'tag': tag + '-tls', 'listen': '0.0.0.0',
             'listen_port': slot['port'], 'version': 3, 'strict_mode': True,
             'users': [{'name': tag, 'password': slot['shadowtls_password']}],
             'handshake': {'server': cover, 'server_port': 443}, 'detour': tag},
            {'type': 'snell', 'tag': tag, 'version': 5, 'psk': slot['psk']},
        ]
    for rule in result['route']['rules']:
        if rule.get('inbound') == old_tag:
            rule['inbound'] = tags
        elif 'inbound' in rule:
            raise ValueError('Unexpected policy scope')
    return result
