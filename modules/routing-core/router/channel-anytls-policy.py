#!/usr/bin/env python3
"""Project the selected-client split into an isolated AnyTLS lab."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path

REFERENCE = 'channel-b-relay-socks'
TAG = 'channel-anytls-in'
BASE = Path('/opt/etc/ghostroute-anytls')
RUN = Path('/tmp/ghostroute-anytls')
PRIVATE = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
           '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
           '224.0.0.0/4', '240.0.0.0/4', '::/0']


def validate_settings(s):
    if type(s['port']) is not int or not 1024 < s['port'] <= 65535:
        raise ValueError('Invalid lab listener')
    if len(s['users']) != 2 or {u['name'] for u in s['users']} != {'lab-client', 'lab-probe'}:
        raise ValueError('Require distinct client and probe identities')
    passwords = [u['password'] for u in s['users']]
    if any(not isinstance(p, str) or len(p) < 32 for p in passwords) or len(set(passwords)) != 2:
        raise ValueError('Require distinct strong passwords')
    if not s['host'] or not s['server_name'] or any(c in s['host'] + s['server_name'] for c in '\r\n/@?# '):
        raise ValueError('Invalid TLS endpoint')
    for key in ('certificate_path', 'key_path'):
        if not str(s[key]).startswith('/opt/') or '..' in Path(s[key]).parts:
            raise ValueError('TLS files must be explicit Entware paths')
    return s


def project(source, settings):
    s = validate_settings(settings)
    if not any(i.get('tag') == REFERENCE for i in source['inbounds']):
        raise ValueError('Selected-client reference inbound is absent')
    rules = []
    for original in source['route']['rules']:
        scope = original.get('inbound', [])
        scope = [scope] if isinstance(scope, str) else scope
        if not scope:
            raise ValueError('Unscoped production rule requires explicit review')
        if REFERENCE not in scope:
            continue
        rule = copy.deepcopy(original)
        if 'auth_user' in rule or 'rules' in rule:
            raise ValueError('User/logical policy requires explicit projection review')
        rule['inbound'] = TAG
        rules.append(rule)
    dns = [r for r in rules if r.get('port') == 53]
    if (len(dns) != 2 or dns[0].get('action') != 'route-options'
            or dns[0].get('override_address') != '127.0.0.1'
            or dns[0].get('override_port') != 53
            or dns[1] != {'inbound': TAG, 'port': 53, 'outbound': 'direct-out'}):
        raise ValueError('Reference DNS is not the supported router resolver path')
    rules = [r for r in rules if r not in dns]
    if not rules or rules[-1] != {'inbound': TAG, 'outbound': 'direct-out'}:
        raise ValueError('Selected-client terminal split changed')
    if not any(r.get('outbound') == 'reality-out' and 'rule_set' in r for r in rules):
        raise ValueError('Managed split is missing')
    referenced = {r['outbound'] for r in rules + dns if 'outbound' in r}
    if not referenced <= {'reality-out', 'sensitive-out', 'direct-out'}:
        raise ValueError('Unexpected egress owner')
    outbounds = [copy.deepcopy(o) for o in source['outbounds'] if o['tag'] in referenced]
    if {o['tag'] for o in outbounds} != referenced or any(o['type'] not in ('vless', 'direct') or o.get('detour') for o in outbounds):
        raise ValueError('Unsupported egress dependency or automatic selection')
    route = copy.deepcopy(source['route'])
    # All DNS is forced to the router resolver. No other router/LAN/IPv6 access.
    route['rules'] = dns + [{'ip_cidr': PRIVATE, 'action': 'reject'},
                            {'network': 'udp', 'action': 'reject'}] + rules
    route['final'] = 'direct-out'
    return {
        'log': {'level': 'warn', 'output': str(RUN / 'policy.log'), 'timestamp': True},
        'dns': copy.deepcopy(source['dns']),
        'inbounds': [{'type': 'anytls', 'tag': TAG, 'listen': '0.0.0.0',
                      'listen_port': s['port'], 'users': copy.deepcopy(s['users']),
                      'tls': {'enabled': True, 'server_name': s['server_name'],
                              'certificate_path': s['certificate_path'], 'key_path': s['key_path']}}],
        'outbounds': outbounds, 'route': route,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('source', 'settings', 'output'):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    raw = args.source.read_bytes()
    result = project(json.loads(raw), json.loads(args.settings.read_text()))
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    args.output.with_suffix('.source.sha256').write_text(hashlib.sha256(raw).hexdigest() + '\n')


if __name__ == '__main__':
    main()
