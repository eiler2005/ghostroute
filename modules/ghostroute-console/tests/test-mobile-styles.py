"""The public first paint includes the same shared component styles as Next."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('buffer_proxy', ROOT / 'vps/buffer-proxy.py')
proxy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proxy)


class MobileStylesTest(unittest.TestCase):
    def test_shared_styles_survive_external_stylesheet_removal(self):
        shared = (ROOT / 'app/public/mobile-components.css').read_text()
        self.assertIn(shared, proxy.MOBILE_CRITICAL_CSS)
        self.assertIn('@import "../../public/mobile-components.css"', (ROOT / 'app/src/app/globals.css').read_text())
        handler = object.__new__(proxy.BufferProxyHandler)
        for path in ['/m', '/m/channels', '/m/channels?view=history']:
            handler.path = path
            html = handler._inline_mobile_css('<html><head><link rel="stylesheet" href="/_next/static/css/app.css"></head><body><main class="mobile-shell"></main></body></html>')
            self.assertIn('data-ghostroute-mobile-critical', html)
            self.assertNotIn('rel="stylesheet"', html)
            for selector in ['.detail-row{display:grid', '.channel-filters{display:grid', '.channel-history-row{display:grid', '.channel-health-grid{display:grid']:
                self.assertIn(selector, html)
        handler.path = '/channels'
        self.assertEqual(handler._inline_mobile_css('<head></head>'), '<head></head>')


if __name__ == '__main__':
    unittest.main()
