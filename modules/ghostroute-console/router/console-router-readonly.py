#!/opt/bin/python3
"""Forced-command boundary for the Console's router credential."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys

POLICY = Path('/jffs/addons/ghostroute-console-readonly/policy.json')
MAX_SCRIPT = 256 * 1024
SAFE_PATH = '/sbin:/bin:/usr/sbin:/usr/bin:/opt/sbin:/opt/bin'
STATE_ROOTS = ('/opt/var/log/router_configuration', '/jffs/addons/router_configuration/traffic')
FACT_FILES = ('lan-flow-facts.tsv', 'dns-query-facts.tsv', 'lan-device-counters.tsv',
              'mobile-reality-counters.tsv', 'sing-box-route-evidence.tsv')
LOG_FILES = ('/opt/var/log/sing-box.log', '/opt/var/log/dnsmasq.log',
             '/opt/var/log/domain-activity.log')


class Rejected(ValueError):
    pass


def report_file(path, roots):
    value = Path(path)
    if not any(value.resolve().is_relative_to(Path(root).resolve()) for root in roots):
        raise Rejected('report path escapes its data directory')
    return str(value)


def script_header(original):
    try:
        words = shlex.split(original)
    except ValueError as error:
        raise Rejected('invalid command syntax') from error
    if words[-2:] != ['sh', '-s']:
        raise Rejected('command is not a report request')
    values = {}
    for word in words[:-2]:
        name, separator, value = word.partition('=')
        if not separator or name in values:
            raise Rejected('invalid or duplicate report parameter')
        values[name] = value
    return values


def plan(original, payload, policy):
    if len(original) > 16384 or '\0' in original:
        raise Rejected('invalid request size')
    if policy.get('schema_version') != 1:
        raise Rejected('invalid policy')
    if original in policy['commands']:
        return ['/bin/sh', '-c', policy['commands'][original]], b'', {}

    prefix = 'STATE_DIR=$( [ -x /opt/bin/opkg ] && printf /opt/var/log/router_configuration || printf /jffs/addons/router_configuration/traffic ); '
    tail = 'SNAP=$(ls "$STATE_DIR/tailscale"/{day}T*.json 2>/dev/null | sort | head -1); [ -n "$SNAP" ] && cat "$SNAP" || printf \'{{}}\\n\''
    match = re.fullmatch(re.escape(prefix)+re.escape(tail.format(day='DATE')).replace('DATE', r'([0-9]{4}-[0-9]{2}-[0-9]{2})'), original)
    if match:
        return ['/bin/sh', '-c', prefix+tail.format(day=match[1])], b'', {}

    match = re.fullmatch(r"cat '([^']+)' 2>/dev/null \|\| true", original)
    if match and any(match[1] == root+'/'+name for root in STATE_ROOTS for name in FACT_FILES):
        path = report_file(match[1], STATE_ROOTS)
        return ['/bin/sh', '-c', 'cat "$1" 2>/dev/null || true', 'report', path], b'', {}

    match = re.fullmatch(r'cat "([^"\n]+/dns-forensics/[A-Za-z0-9_.:+-]{1,160}\.tsv)"', original)
    if match:
        roots = ('/opt/var/log/router_configuration/dns-forensics',
                 '/jffs/addons/router_configuration/dns-forensics')
        path = report_file(match[1], roots)
        return ['/bin/cat', path], b'', {}

    match = re.fullmatch(r'''LOG=([^;]+); \[ -f "\$LOG" \] && tail -n '([0-9]{1,4})' "\$LOG" \|\| true''', original)
    if match and match[1] in LOG_FILES and 1 <= int(match[2]) <= 1000:
        return ['/bin/sh', '-c', '[ ! -f "$1" ] || tail -n "$2" "$1"', 'report', match[1], match[2]], b'', {}

    match = re.fullmatch(r'''LOG_LINES='([0-9]{1,5})'; \[ -f /opt/var/log/domain-activity.log \] && tail -n "\$LOG_LINES" /opt/var/log/domain-activity.log \|\| true''', original)
    if match and 1 <= int(match[1]) <= 10000:
        return ['/bin/sh', '-c', '[ ! -f "$1" ] || tail -n "$2" "$1"', 'report', LOG_FILES[2], match[1]], b'', {}

    match = re.fullmatch(r"/jffs/scripts/traffic-rollup-export --json '(today|week|month)'", original)
    if match:
        return ['/jffs/scripts/traffic-rollup-export', '--json', match[1]], b'', {}

    values = script_header(original)
    if len(payload) > MAX_SCRIPT:
        raise Rejected('report script exceeds size limit')
    digest = hashlib.sha256(payload).hexdigest()
    entry = policy['scripts'].get(digest)
    if not entry or hashlib.sha256(entry['body'].encode()).hexdigest() != digest:
        raise Rejected('report script is not approved')
    for name, value in values.items():
        pattern = entry['parameters'].get(name)
        if pattern is None or re.fullmatch(pattern, value) is None:
            raise Rejected('report parameter is not approved')
    return ['/bin/sh', '-s'], entry['body'].encode(), values


def main():
    original = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    policy = json.loads(POLICY.read_text())
    # Only report-script requests consume stdin. Shell, SCP and SFTP requests
    # fail closed without waiting for an untrusted stream.
    try:
        script_header(original)
        script_request = True
    except Rejected:
        script_request = False
    if script_request:
        signal.alarm(15)
        payload = sys.stdin.buffer.read(MAX_SCRIPT+1)
        signal.alarm(0)
    else:
        payload = b''
    argv, body, parameters = plan(original, payload, policy)
    environment = {'PATH': SAFE_PATH, 'HOME': '/root', 'LANG': 'C', 'LC_ALL': 'C', **parameters}
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, env=environment, start_new_session=True)
    try:
        process.communicate(body, timeout=100)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        return 124
    return process.returncode


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Rejected, OSError, ValueError, KeyError):
        print('rejected: Console router report access only', file=sys.stderr)
        sys.exit(126)
