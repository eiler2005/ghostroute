#!/usr/bin/env python3
"""Exercise deployment filters with stale public routes and private reports."""
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ConsoleSourceSync(unittest.TestCase):
    def test_public_report_routes_are_updated_without_copying_operator_reports(self):
        playbook = (ROOT / 'modules/ghostroute-console/vps/deploy-readonly.yml').read_text()
        task = playbook.split('- name: Sync repo sources without secrets or generated artifacts', 1)[1].split('delegate_to:', 1)[0]
        flags = re.findall(r'^\s+- (--(?:include|exclude|filter)=.+)$', task, re.M)
        with tempfile.TemporaryDirectory() as work:
            source, dest = pathlib.Path(work) / 'source', pathlib.Path(work) / 'dest'
            source.mkdir(); dest.mkdir()
            shutil.copyfile(ROOT / '.gitignore', source / '.gitignore')
            routes = [
                'modules/ghostroute-console/app/src/app/reports/page.tsx',
                'modules/ghostroute-console/app/src/app/api/reports/llm-safe/route.ts',
            ]
            private = [
                'reports/operator.txt',
                'modules/traffic-observatory/reports/operator.txt',
                'ansible/secrets/operator.yml',
                'ansible/out/client.txt',
                'modules/ghostroute-console/data/operator.json',
            ]
            for relative in routes + private:
                file = source / relative; file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('reviewed source fixture' if relative in routes else 'private fixture')
            for relative in routes:
                file = dest / relative; file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('stale source fixture')
            subprocess.run(['rsync', '-az', *flags, str(source) + '/', str(dest) + '/'], check=True, capture_output=True)
            for relative in routes:
                self.assertEqual((dest / relative).read_text(), 'reviewed source fixture', relative)
            for relative in private:
                self.assertFalse((dest / relative).exists(), relative)


if __name__ == '__main__':
    unittest.main()
