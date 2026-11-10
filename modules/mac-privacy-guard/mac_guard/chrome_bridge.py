"""Standalone Chrome stdio bridge. No routing controls or dashboard credential."""
import argparse
import json
import socket
import struct
import sys
from pathlib import Path


def forward(state, data):
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
                command = reply.get('command')
                if result['ok'] and isinstance(command, dict) and set(command) == {'id', 'action', 'session', 'event'}:
                    if command['action'] in {'start', 'stop', 'clear', 'preview', 'reporting_on', 'reporting_off', 'pause_protection', 'resume_protection', 'allow_sites', 'block_sites'}:
                        result['command'] = command
                return result
    except (OSError, ValueError, AttributeError):
        return {'ok': False}


def serve(source, output, state):
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
            result = forward(state, json.loads(payload))
        except (ValueError, TypeError):
            result = {'ok': False}
        body = json.dumps(result).encode()
        output.write(struct.pack('=I', len(body)) + body)
        output.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('caller')
    args = parser.parse_args()
    if args.caller != args.origin:
        raise SystemExit(1)
    serve(sys.stdin.buffer, sys.stdout.buffer, args.state)


if __name__ == '__main__':
    main()
