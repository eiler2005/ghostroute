#!/usr/bin/env python3
"""Control-machine preparation and role-only report for Telegram qualification."""
import argparse
import ipaddress
import json
from pathlib import Path
import sys

import yaml


def prepare(vault, targets, rounds, timeout):
    router = next(c for c in vault['clients'] if c['name'] == 'router')
    primary_host = vault['vps_ssh_host']
    hermes_host = vault.get('vault_router_hermes_vps_host') or vault['vault_router_hermes_vps_ssh_host']
    roles = {}
    for role, host, port, sni, fingerprint in [
        ('primary_vps', primary_host, 443, vault['reality_server_names'][0], 'chrome'),
        ('hermes_vps', hermes_host, vault.get('vault_router_hermes_vps_port', 443),
         vault.get('vault_router_hermes_vps_server_name') or vault['reality_server_names'][0],
         vault.get('vault_router_hermes_vps_utls_fingerprint', 'chrome')),
    ]:
        roles[role] = {'expected_exit': str(ipaddress.IPv4Address(host)), 'outbound': {
            'type': 'vless', 'server': host, 'server_port': int(port), 'uuid': router['uuid'],
            'flow': 'xtls-rprx-vision', 'packet_encoding': 'xudp', 'tcp_fast_open': False,
            'tcp_keep_alive_interval': '30s', 'connect_timeout': '10s',
            'multiplex': {'enabled': False},
            'tls': {'enabled': True, 'server_name': sni, 'utls': {'enabled': True, 'fingerprint': fingerprint},
                    'reality': {'enabled': True, 'public_key': vault['reality_server_public_key'], 'short_id': router['short_id']}}}}
    def backup(name, default=None):
        return vault.get('vault_router_backup_reality_' + name, default)
    required = ['server', 'uuid', 'server_name', 'public_key', 'short_id']
    if not all(backup(k) for k in required):
        raise ValueError('backend bank configuration incomplete')
    transport = backup('transport', 'tcp')
    flow = backup('flow', '' if transport == 'grpc' else 'xtls-rprx-vision')
    alpn = backup('alpn', [])
    if transport not in ('tcp', 'grpc') or flow not in ('', 'xtls-rprx-vision') or not isinstance(alpn, list):
        raise ValueError('invalid backup Reality transport settings')
    if transport == 'grpc' and (flow or not backup('grpc_service_name') or 'h2' not in alpn):
        raise ValueError('gRPC requires empty flow, service name and h2 ALPN')
    roles['backup_reality'] = {'outbound': {
        'type': 'vless', 'server': backup('server'), 'server_port': int(backup('server_port', 443)),
        'uuid': backup('uuid'),
        'packet_encoding': backup('packet_encoding', 'xudp'), 'tcp_fast_open': False,
        'tcp_keep_alive_interval': '30s', 'connect_timeout': '10s', 'multiplex': {'enabled': False},
        'tls': {'enabled': True, 'server_name': backup('server_name'),
                'utls': {'enabled': True, 'fingerprint': backup('utls_fingerprint', 'chrome')},
                'reality': {'enabled': True, 'public_key': backup('public_key'), 'short_id': backup('short_id')}}}}
    outbound = roles['backup_reality']['outbound']
    if flow:
        outbound['flow'] = flow
    if alpn:
        outbound['tls']['alpn'] = alpn
    if transport == 'grpc':
        outbound['transport'] = {'type': 'grpc', 'service_name': backup('grpc_service_name')}
    checked = []
    for label, address, port in targets:
        if not label.replace('-', '').isalnum():
            raise ValueError('invalid target label')
        checked.append((label, str(ipaddress.IPv4Address(address)), int(port)))
        if not 1 <= int(port) <= 65535:
            raise ValueError('invalid target port')
    if not checked:
        raise ValueError('no native targets')
    return {'backends': roles, 'targets': checked, 'rounds': rounds, 'timeout': timeout}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('vault', type=Path)
    p.add_argument('worker', type=Path)
    p.add_argument('targets', type=Path)
    p.add_argument('rounds', type=int, choices=range(1, 6))
    p.add_argument('timeout', type=int, choices=range(2, 11))
    p = sub.add_parser('report')
    p.add_argument('result', type=Path)
    p.add_argument('--json', action='store_true')
    args = parser.parse_args()
    if args.action == 'prepare':
        targets = [line.split() for line in args.targets.read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')]
        payload = prepare(yaml.safe_load(args.vault.read_text()), targets, args.rounds, args.timeout)
        print(args.worker.read_text())
        print('\nprint(json.dumps(run_probe(json.loads(' + repr(json.dumps(payload)) + '))))')
    else:
        report = json.loads(args.result.read_text())
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print('Telegram egress qualification (router vantage; signed-in media not tested)')
            for role, row in report['backends'].items():
                count = sum(x['ok'] for x in row['native'])
                print(f"{role}: native={count}/{len(row['native'])} web={sum(row['web'].values())}/{len(row['web'])} exit={row['exit_identity']} eligible={row['eligible_for_client_trial']}")
            print('Production config unchanged:', report['production_config_unchanged'])
        # A failed inactive backend is a failed qualification, even when the
        # current production backend works. Never turn a partial bank green.
        return 0 if all(r['eligible_for_client_trial'] for r in report['backends'].values()) else 1
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (KeyError, ValueError, StopIteration):
        sys.exit('telegram-egress-check: invalid or incomplete private inputs; no routing changed')
