"""Bounded Chrome stdio bridge. No upstream secrets or dashboard credential."""
import argparse
import json
import plistlib
import re
import socket
import struct
import subprocess
import sys
from pathlib import Path


def launch_app(app):
    """Launch only the installed bundle selected by the local installer."""
    if sys.platform != 'darwin' or app is None:
        return {'ok': False}
    try:
        app = app.resolve(strict=True)
        info = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
        if app.suffix != '.app' or not isinstance(info, dict) or info.get('CFBundleIdentifier') != 'org.ghostroute.guard':
            return {'ok': False}
        subprocess.run(['/usr/bin/open', '-g', '-a', str(app), '--args', '--background'],
                       check=True, capture_output=True, timeout=3)
        return {'ok': True}
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError):
        return {'ok': False}


def forward(state, data, app=None):
    if isinstance(data, dict) and data.get('op') == 'launch':
        if set(data) != {'op', 'profile'} or not isinstance(data['profile'], str) or not re.fullmatch('[a-f0-9]{32}', data['profile']):
            return {'ok': False}
        return launch_app(app)
    raw = json.dumps(data, separators=(',', ':')).encode() + b'\n'
    if len(raw) > 8192:
        return {'ok': False}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(2)
            connection.connect(str(state / 'chrome-events.sock'))
            connection.sendall(raw)
            with connection.makefile('rb') as source:
                reply = json.loads(source.readline(2048))
                result = {'ok': reply.get('ok') is True}
                if result['ok'] and reply.get('access') in {'allow', 'block'}:
                    result['access'] = reply['access']
                strict = reply.get('strict')
                if (result['ok'] and isinstance(strict, dict)
                        and set(strict) in ({'enabled', 'ready', 'port', 'catalog_digest', 'system_direct', 'reason'}, {'enabled', 'ready', 'port', 'catalog_digest', 'system_direct', 'reason', 'baseline'})
                        and strict.get('baseline', 'direct') in ('direct', 'external_pac')
                        and all(type(strict[k]) is bool for k in ('enabled', 'ready', 'system_direct'))
                        and type(strict['port']) is int and 0 <= strict['port'] <= 65535
                        and isinstance(strict['catalog_digest'], str) and len(strict['catalog_digest']) == 64
                        and strict['reason'] in {'unavailable', 'upgrade_required', 'route_unavailable', 'paused', 'system_proxy', 'catalog_mismatch', 'waiting', 'owned', 'conflict', 'permission_required', 'unsupported_proxy', 'error', 'checking', 'active', 'route_failed'}):
                    result['strict'] = strict
                command = reply.get('command')
                if result['ok'] and isinstance(command, dict) and set(command) == {'id', 'action', 'session', 'event'}:
                    if command['action'] in {'start', 'stop', 'clear', 'preview', 'reporting_on', 'reporting_off', 'pause_protection', 'resume_protection', 'allow_sites', 'block_sites'}:
                        result['command'] = command
                return result
    except (OSError, ValueError, AttributeError):
        return {'ok': False}


def serve(source, output, state, app=None):
    while True:
        header = source.read(4)
        if len(header) != 4:
            return
        length = struct.unpack('=I', header)[0]
        if not 0 < length <= 8192:
            return
        payload = source.read(length)
        if len(payload) != length:
            return
        try:
            result = forward(state, json.loads(payload), app)
        except (ValueError, TypeError):
            result = {'ok': False}
        body = json.dumps(result).encode()
        output.write(struct.pack('=I', len(body)) + body)
        output.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--app', type=Path)
    parser.add_argument('caller')
    args = parser.parse_args()
    if args.caller != args.origin:
        raise SystemExit(1)
    serve(sys.stdin.buffer, sys.stdout.buffer, args.state, args.app)


if __name__ == '__main__':
    main()
