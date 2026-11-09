"""Dedicated Chrome profile; never change the operator's normal profile."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from .policy import GuardError, browser_url, private_dir, write_private

CHROME = Path('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')


def arguments(profile: Path, port: int) -> list[str]:
    return [str(CHROME), f'--user-data-dir={profile}',
            f'--proxy-server=http://127.0.0.1:{port}', '--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--disable-quic', '--webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--disable-extensions', '--disable-background-networking',
            '--disable-component-update', '--disable-sync', '--no-first-run',
            '--no-default-browser-check', '--disable-features=DnsOverHttps',
            '--force-color-profile=srgb']


class Browser:
    def __init__(self, state: Path, port: int):
        self.profile = state / 'Browser'
        self.port = port
        self.process = None
        self.owner = state / 'browser-pid'

    def open(self, url: str):
        url = browser_url(url)
        if not CHROME.is_file():
            raise GuardError('Для защищённого браузера нужен установленный Google Chrome')
        if self.process and self.process.poll() is None:
            # Chrome forwards this launch only to our separate user-data-dir.
            subprocess.run(arguments(self.profile, self.port) + [url],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            return
        if self.owner.exists():
            try:
                pid = int(self.owner.read_text())
                if pid <= 1:
                    raise ValueError()
                os.kill(pid, 0)
            except ProcessLookupError:
                pass
            except (ValueError, OSError):
                raise GuardError('Не удалось проверить старый процесс защищённого браузера') from None
            else:
                raise GuardError('Закройте прежнее окно защищённого браузера перед новым запуском')
        private_dir(self.profile / 'Default')
        preferences = self.profile / 'Default' / 'Preferences'
        try:
            data = json.loads(preferences.read_text()) if preferences.exists() else {}
        except (ValueError, OSError):
            raise GuardError('Не удалось прочитать профиль защищённого браузера') from None
        data.setdefault('webrtc', {})['ip_handling_policy'] = 'disable_non_proxied_udp'
        data.setdefault('dns_over_https', {})['mode'] = 'off'
        data.setdefault('net', {})['network_prediction_options'] = 2
        write_private(preferences, json.dumps(data).encode())
        self.process = subprocess.Popen(arguments(self.profile, self.port) + [url],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        write_private(self.owner, str(self.process.pid).encode())

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None
