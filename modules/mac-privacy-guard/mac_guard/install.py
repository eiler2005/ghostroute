"""Local, user-owned app bundle and unpacked Chrome extension builder."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import plistlib
import platform
import shutil
import subprocess
import sys
import tempfile

from .policy import GuardError, domains_from_text, private_dir, write_private

ROOT = Path(__file__).resolve().parent.parent


def extension(destination, domains):
    private_dir(destination)
    # requestDomains matches exact hosts and their subdomains, not substrings.
    rules = [{'id': index + 1, 'priority': 1, 'action': {'type': 'block'},
              'condition': {'requestDomains': [domain]}} for index, domain in enumerate(domains)]
    manifest = {'manifest_version': 3, 'name': 'GhostRoute Sensitive Site Guard',
                'version': '0.1.0', 'description': 'Blocks sensitive destinations in this ordinary Chrome profile.',
                'permissions': ['declarativeNetRequest'],
                'declarative_net_request': {'rule_resources': [{'id': 'sensitive', 'enabled': True, 'path': 'rules.json'}]},
                'action': {'default_popup': 'popup.html'}}
    for filename, content in [('manifest.json', json.dumps(manifest, indent=2)), ('rules.json', json.dumps(rules))]:
        write_private(destination / filename, content.encode())
    write_private(destination / 'popup.html', ('<!doctype html><html lang="ru"><meta charset="utf-8"><body><h2>GhostRoute Guard</h2><p>Чувствительные сайты заблокированы в этом профиле Chrome.</p><p>Откройте приложение GhostRoute Guard, проверьте маршрут и используйте защищённый браузер.</p><p>Другие профили и приложения не охвачены.</p></body></html>').encode())


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
        for name in ('mac_guard', 'ui'):
            shutil.copytree(ROOT / name, resources / name, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        (resources / 'python-path').write_text(str(python.resolve()) + '\n')
        info = {'CFBundleExecutable': 'GhostRouteGuard', 'CFBundleIdentifier': 'org.ghostroute.guard',
                'CFBundleName': 'GhostRoute Guard', 'CFBundleDisplayName': 'GhostRoute Guard',
                'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '0.1.0',
                'CFBundleVersion': '1', 'LSMinimumSystemVersion': '13.0',
                'NSHighResolutionCapable': True,
                'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
                'CFBundleURLTypes': [{'CFBundleURLName': 'GhostRoute Guard', 'CFBundleURLSchemes': ['ghostrouteguard']}]}
        (bundle / 'Contents/Info.plist').write_bytes(plistlib.dumps(info))
        subprocess.run(['xcrun', 'swiftc', str(ROOT / 'native/Guard.swift'), '-O',
                        '-target', platform.machine() + '-apple-macos13.0', '-framework', 'AppKit',
                        '-framework', 'WebKit', '-o', str(executable)], check=True)
        subprocess.run(['codesign', '--force', '--sign', '-', str(bundle)], check=True, capture_output=True)
        shutil.move(bundle, destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path, default=Path.home() / 'Applications/GhostRoute Guard.app')
    parser.add_argument('--extension', type=Path, default=Path.home() / 'Library/Application Support/GhostRoute Guard/Chrome Blocker')
    parser.add_argument('--catalog', type=Path, required=True)
    parser.add_argument('--extension-only', action='store_true')
    args = parser.parse_args()
    domains = domains_from_text(args.catalog.read_text())
    if not domains:
        raise SystemExit('Empty catalog is not allowed')
    extension(args.extension, domains)
    if not args.extension_only:
        install(args.app, Path(sys.executable))
    print('Local installation completed; extension activation is a separate Chrome step.')


if __name__ == '__main__':
    main()
