#!/usr/bin/env python3
"""Exercise the actual remote reader without SSH, secrets or router mutations."""
from pathlib import Path
import itertools, json, subprocess, tempfile, unittest

ROOT = Path(__file__).resolve().parents[3]
SOURCE = (ROOT / 'modules/shared/lib/router-health-common.sh').read_text()
FUNCTION = 'singbox_port_by_tag() {' + SOURCE.split('singbox_port_by_tag() {', 1)[1].split('\n}\n', 1)[0] + '\n}\n'


class HealthJsonReaderTests(unittest.TestCase):
    def parse(self, config, tag='reality-in'):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'reader.sh'
            source.write_text(FUNCTION + '\nsingbox_config="$(cat "$1")"\nsingbox_port_by_tag "$2"\n')
            data = Path(directory) / 'config.json'
            data.write_text(config)
            result = subprocess.run(['sh', str(source), str(data), tag], capture_output=True, text=True, check=True)
            self.assertEqual(result.stderr, '')
            return result.stdout.strip()

    def test_semantic_lookup_is_independent_of_layout_and_key_order(self):
        expected = {'redirect-in': 37001, 'reality-in': 37002, 'dnscrypt-socks-in': 37003}
        for fields in itertools.permutations(['tag', 'listen_port', 'tls']):
            rows = []
            for tag, port in expected.items():
                row = {'tag': tag, 'listen_port': port, 'tls': {'listen_port': 55555}}
                rows.append({key: row[key] for key in fields})
            config = {'inbounds': rows, 'diagnostic_id': 'fixture-99999'}
            for options in [{'indent': 2}, {'sort_keys': True}, {'separators': (',', ':')}]:
                with self.subTest(fields=fields, options=options):
                    for tag, port in expected.items():
                        self.assertEqual(self.parse(json.dumps(config, **options), tag), str(port))

    def test_missing_duplicate_or_invalid_ports_never_select_a_neighbor(self):
        cases = [
            {'inbounds': [{'tag': 'other', 'listen_port': 37001}]},
            {'inbounds': [{'tag': 'reality-in'}, {'tag': 'other', 'listen_port': 37001}]},
            {'inbounds': [{'tag': 'reality-in', 'listen_port': True}]},
            {'inbounds': [{'tag': 'reality-in', 'listen_port': '37002'}]},
            {'inbounds': [{'tag': 'reality-in', 'listen_port': 0}]},
            {'inbounds': [{'tag': 'reality-in', 'listen_port': 65536}]},
            {'inbounds': [{'tag': 'reality-in', 'listen_port': 37002}] * 2},
        ]
        for config in cases:
            with self.subTest(config=config):
                self.assertEqual(self.parse(json.dumps(config)), '')

    def test_malformed_or_wrong_root_json_does_not_emit_configuration(self):
        for config in ['{', '[]', 'null', '{"inbounds":null}']:
            with self.subTest(config=config):
                self.assertEqual(self.parse(config), '')


if __name__ == '__main__':
    unittest.main()
