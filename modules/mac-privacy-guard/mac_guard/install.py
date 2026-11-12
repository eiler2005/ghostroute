"""Local, user-owned app bundle and unpacked Chrome extension builder."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import shlex
import subprocess
import sys
import tempfile

from .policy import GuardError, domains_from_text, matches, private_dir, public_host, write_private

ROOT = Path(__file__).resolve().parent.parent


def ordinary_direct_domains(path, sensitive):
    if path.is_symlink():
        raise GuardError('Приватные исключения не должны быть символической ссылкой')
    if not path.exists():
        return []
    info = path.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
        raise GuardError('Приватным исключениям нужны права 600, текущий владелец и размер до 8 KiB')
    domains = domains_from_text(path.read_text())
    if len(domains) > 32:
        raise GuardError('Разрешено до 32 исключений обычного Chrome')
    for domain in domains:
        public_host(domain)
        if ':' in domain or not any('a' <= char <= 'z' for char in domain):
            raise GuardError('Исключение должно быть публичным доменным именем')
        if matches(domain, sensitive) or any(matches(protected, [domain]) for protected in sensitive):
            raise GuardError('Исключение пересекается с чувствительным каталогом')
    return domains


def ordinary_routing_mode(state, selected=None):
    path = state / 'ordinary-routing-mode'
    if path.is_symlink():
        raise GuardError('Настройка маршрута не должна быть символической ссылкой')
    mode = 'network'
    if path.exists():
        info = path.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 64:
            raise GuardError('Настройке маршрута нужны права 600, текущий владелец и размер до 64 байт')
        mode = path.read_text().strip()
    if selected is not None:
        mode = selected
    if mode not in ('network', 'external_pac'):
        raise GuardError('Неизвестный режим обычных сайтов')
    if selected is not None:
        write_private(path, (mode + '\n').encode())
    return mode


def extension(destination, domains, ordinary_routing=None):
    mode = ordinary_routing_mode(destination.parent, ordinary_routing)
    direct = ordinary_direct_domains(destination.parent / 'ordinary-direct-domains.txt', domains)
    private_dir(destination)
    # requestDomains matches exact hosts and their subdomains, not substrings.
    rules = [{'id': index + 1, 'priority': 1, 'action': {'type': 'block'},
              'condition': {'requestDomains': [domain], 'resourceTypes': [
                  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
                  'object', 'xmlhttprequest', 'ping', 'csp_report', 'media',
                  'websocket', 'webtransport', 'webbundle', 'other']}}
             for index, domain in enumerate(domains)]
    manifest = {'manifest_version': 3, 'name': 'GhostRoute Sensitive Site Guard',
                'version': '0.5.2', 'description': 'Ordinary sites follow the Mac network; sensitive sites require verified GhostRoute.',
                'permissions': ['declarativeNetRequest', 'declarativeNetRequestFeedback', 'nativeMessaging', 'proxy', 'privacy'],
                'background': {'service_worker': 'background.js'},
                'devtools_page': 'devtools.html',
                'icons': {str(size): f'icon-{size}.png' for size in (16, 32, 48, 128)},
                'declarative_net_request': {'rule_resources': [{'id': 'sensitive', 'enabled': True, 'path': 'rules.json'}]},
                'action': {'default_popup': 'popup.html'}}
    for filename, content in [('manifest.json', json.dumps(manifest, indent=2)), ('rules.json', json.dumps(rules)), ('ordinary-direct-domains.json', json.dumps(direct)), ('ordinary-routing.json', json.dumps({'mode': mode}))]:
        write_private(destination / filename, content.encode())
    for filename in ('background.js', 'counts.js', 'pac.js', 'strict.js', 'popup.html', 'popup.js', 'popup.css', 'help.html', 'help.js',
                     'devtools.html', 'devtools.js', 'diagnostics.js', 'diagnostics.html', 'panel.js', 'panel.css'):
        write_private(destination / filename, (ROOT / 'extension' / filename).read_bytes())
    for size in (16, 32, 48, 128):
        filename = f'icon-{size}.png'
        write_private(destination / filename, (ROOT / 'assets' / filename).read_bytes())


def extension_id(destination):
    # Chromium GenerateIdForPath on macOS: SHA-256 of the absolute unpacked path.
    digest = hashlib.sha256(str(destination.resolve()).encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(character, 16)) for character in digest)


def native_host(state, destination, manifests, python, app=None):
    directory = state / 'Chrome Native Host'
    private_dir(directory)
    script = directory / 'bridge.py'
    write_private(script, (ROOT / 'mac_guard/chrome_bridge.py').read_bytes())
    origin = 'chrome-extension://' + extension_id(destination) + '/'
    executable = directory / 'ghostroute-events'
    command = [str(python.resolve()), '-I', '-B', str(script), '--state', str(state.resolve()), '--origin', origin]
    if app is not None:
        command += ['--app', str(app.resolve())]
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
        shutil.copy2(ROOT / 'assets/AppIcon.icns', resources / 'AppIcon.icns')
        info = {'CFBundleExecutable': 'GhostRouteGuard', 'CFBundleIdentifier': 'org.ghostroute.guard',
                'CFBundleName': 'GhostRoute Guard', 'CFBundleDisplayName': 'GhostRoute Guard',
                'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '0.5.2',
                'CFBundleIconFile': 'AppIcon',
                'CFBundleVersion': '14', 'LSMinimumSystemVersion': '13.0',
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
    parser.add_argument('--ordinary-routing', choices=('network', 'external_pac'),
                        help='Ordinary sites: Mac network (default) or explicitly preserved external inline PAC; choice persists across rebuilds')
    args = parser.parse_args()
    if not args.extension_only and args.app.exists():
        raise GuardError('Приложение уже существует. Закройте его и переименуйте старый bundle перед обновлением')
    domains = domains_from_text(args.catalog.read_text())
    if not domains:
        raise SystemExit('Empty catalog is not allowed')
    extension(args.extension, domains, args.ordinary_routing)
    native_host(args.extension.parent, args.extension, args.native_hosts, Path(sys.executable), args.app)
    if not args.extension_only:
        install(args.app, Path(sys.executable))
    print('Local installation completed; extension activation is a separate Chrome step.')


if __name__ == '__main__':
    main()
