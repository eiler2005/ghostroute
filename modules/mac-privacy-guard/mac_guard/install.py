"""Local, user-owned app bundle and unpacked Chrome extension builder."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import shlex
import subprocess
import sys
import tempfile

from .policy import GuardError, domains_from_text, private_dir, write_private

ROOT = Path(__file__).resolve().parent.parent


def extension(destination, domains):
    private_dir(destination)
    # requestDomains matches exact hosts and their subdomains, not substrings.
    rules = [{'id': index + 1, 'priority': 1, 'action': {'type': 'block'},
              'condition': {'requestDomains': [domain], 'resourceTypes': [
                  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
                  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
                  'websocket', 'webtransport', 'webbundle', 'other']}}
             for index, domain in enumerate(domains)]
    manifest = {'manifest_version': 3, 'name': 'GhostRoute Sensitive Site Guard',
                'version': '0.2.0', 'description': 'Blocks sensitive destinations and reports local block metadata to GhostRoute Guard.',
                'permissions': ['declarativeNetRequest', 'declarativeNetRequestFeedback', 'nativeMessaging'],
                'background': {'service_worker': 'background.js'},
                'declarative_net_request': {'rule_resources': [{'id': 'sensitive', 'enabled': True, 'path': 'rules.json'}]},
                'action': {'default_popup': 'popup.html'}}
    for filename, content in [('manifest.json', json.dumps(manifest, indent=2)), ('rules.json', json.dumps(rules))]:
        write_private(destination / filename, content.encode())
    for filename in ('background.js', 'popup.html', 'popup.js', 'popup.css'):
        write_private(destination / filename, (ROOT / 'extension' / filename).read_bytes())


def extension_id(destination):
    # Chromium GenerateIdForPath on macOS: SHA-256 of the absolute unpacked path.
    digest = hashlib.sha256(str(destination.resolve()).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(character, 16)) for character in digest)


def native_host(state, destination, manifests, python):
    directory = state / 'Chrome Native Host'
    private_dir(directory)
    script = directory / 'bridge.py'
    write_private(script, (ROOT / 'mac_guard/chrome_bridge.py').read_bytes())
    origin = 'chrome-extension://' + extension_id(destination) + '/'
    executable = directory / 'ghostroute-events'
    command = [str(python.resolve()), '-I', '-B', str(script), '--state', str(state.resolve()), '--origin', origin]
    write_private(executable, ('#!/bin/sh\nexec ' + shlex.join(command) + ' "$@"\n').encode())
    executable.chmod(0o700)
    manifest = {'name':'org.ghostroute.guard.events', 'description':'Local GhostRoute block events',
                'path':str(executable.resolve()), 'type':'stdio', 'allowed_origins':[origin]}
    write_private(manifests / 'org.ghostroute.guard.events.json', json.dumps(manifest).encode())


def install(destination, python):
    if sys.platform != 'darwin':
        raise GuardError('App bundle собирается только на macOS')
    if destination.exists():
        raise GuardError('Приложение уже существует. Закройте его и переименуйте старый bundle перед обновлением')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='guard-build-', dir=destination.parent) as temporary:
        bundle = Path(temporary) / 'GhostRoute Guard.app'
        resources = bundle / 'Contents/Resources'
        executable = bundle / 'Contents/MacOS/GhostRouteGuard'
        executable.parent.mkdir(parents=True)
        resources.mkdir()
        for name in ('mac_guard',):
            shutil.copytree(ROOT / name, resources / name, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (resources / 'python-path').write_text(str(python.resolve()) + '\n')
        info = {'CFBundleExecutable': 'GhostRouteGuard', 'CFBundleIdentifier': 'org.ghostroute.guard',
                'CFBundleName': 'GhostRoute Guard', 'CFBundleDisplayName': 'GhostRoute Guard',
                'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '0.2.0',
                'CFBundleVersion': '2', 'LSMinimumSystemVersion': '13.0',
                'NSHighResolutionCapable': True,
                'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
                'CFBundleURLTypes': [{'CFBundleURLName': 'GhostRoute Guard', 'CFBundleURLSchemes': ['ghostrouteguard']}]}
        (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        build = Path(temporary) / 'swift-build'
        command = ['swift', 'build', '--package-path', str(ROOT / 'native'),
                   '--scratch-path', str(build), '--configuration', 'release']
        subprocess.run(command + ['--product', 'GhostRouteGuard'], check=True)
        binary_dir = subprocess.check_output(command + ['--show-bin-path'], text=True).strip()
        shutil.copy2(Path(binary_dir) / 'GhostRouteGuard', executable)
        subprocess.run(['codesign', '--force', '--sign', '-', str(bundle)], check=True, capture_output=True)
        shutil.move(bundle, destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path, default=Path.home() / 'Applications/GhostRoute Guard.app')
    parser.add_argument('--extension', type=Path, default=Path.home() / 'Library/Application Support/GhostRoute Guard/Chrome Blocker')
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--native-hosts', type=Path, default=Path.home() / 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
    parser.add_argument('--extension-only', action='store_true')
    args = parser.parse_args()
    if not args.extension_only and args.app.exists():
        raise GuardError('Приложение уже существует. Закройте его и переименуйте старый bundle перед обновлением')
    domains = domains_from_text(args.catalog.read_text())
    if not domains:
        raise SystemExit('Empty catalog is not allowed')
    extension(args.extension, domains)
    native_host(args.extension.parent, args.extension, args.native_hosts, Path(sys.executable))
    if not args.extension_only:
        install(args.app, Path(sys.executable))
    print('Local installation completed; extension activation is a separate Chrome step.')


if __name__ == '__main__':
    main()
