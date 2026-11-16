from pathlib import Path
import unittest
from jinja2 import Environment, StrictUndefined


class ChannelDObservabilityTests(unittest.TestCase):
    def test_logging_is_opt_in_and_does_not_change_profile_config(self):
        path = Path(__file__).resolve().parents[1] / 'ansible/roles/channel_d_naiveproxy/templates/Caddyfile.j2'
        template = Environment(undefined=StrictUndefined).from_string(path.read_text())
        values = {'channel_d_naiveproxy_ingress_port': 12001, 'channel_d_naiveproxy_tls_cert_path': '/tmp/test.pem',
                  'channel_d_naiveproxy_tls_key_path': '/tmp/test.key', 'channel_d_naiveproxy_upstream_socks_port': 12002,
                  'channel_d_naiveproxy_www_root': '/tmp/www', 'channel_d_naiveproxy_clients': [{'username': 'fixture', 'password': 'fixture-secret'}]}
        old = template.render(**values)
        new = template.render(**values, channel_d_traffic_observability_enabled=True)
        self.assertNotIn('channel-d-access.log', old)
        self.assertIn('channel-d-access.log', new)
        self.assertIn('request delete', new)
        self.assertIn('resp_headers delete', new)
        self.assertIn('roll_uncompressed', new)
        self.assertIn('basic_auth fixture fixture-secret', old)
        self.assertIn('basic_auth fixture fixture-secret', new)
        self.assertIn('upstream socks5://127.0.0.1:12002', old)
        self.assertIn('upstream socks5://127.0.0.1:12002', new)


if __name__ == '__main__':
    unittest.main()
