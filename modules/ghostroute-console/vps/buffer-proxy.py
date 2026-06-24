#!/usr/bin/env python3
import http.client
import gzip
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

try:
    import brotli
except ImportError:
    brotli = None


UPSTREAM_HOST = os.environ.get("GHOSTROUTE_BUFFER_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("GHOSTROUTE_BUFFER_UPSTREAM_PORT", "3000"))
LISTEN_HOST = os.environ.get("GHOSTROUTE_BUFFER_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("GHOSTROUTE_BUFFER_LISTEN_PORT", "3001"))
MAX_REQUEST_BODY = int(os.environ.get("GHOSTROUTE_BUFFER_MAX_REQUEST_BODY", "1048576"))
JS_SPLIT_THRESHOLD = int(os.environ.get("GHOSTROUTE_BUFFER_JS_SPLIT_THRESHOLD", "20000"))
JS_SPLIT_PART_SIZE = int(os.environ.get("GHOSTROUTE_BUFFER_JS_SPLIT_PART_SIZE", "12000"))
JS_SPLIT_QUERY_PARAM = "__gr_part"
DISABLE_NEXT_JS = os.environ.get("GHOSTROUTE_BUFFER_DISABLE_NEXT_JS", "1").lower() not in {
    "0",
    "false",
    "no",
}

NEXT_SCRIPT_RE = re.compile(
    r"<script\b(?=[^>]*\bsrc=(?:[\"']/_next/static/[^\"']+\.js[\"']|/_next/static/[^>\s]+\.js))"
    r"[^>]*>\s*</script>",
    re.IGNORECASE,
)
NEXT_SCRIPT_PRELOAD_RE = re.compile(
    r"<link\b(?=[^>]*\brel=(?:[\"'][^\"']*(?:preload|modulepreload)[^\"']*[\"']|[^\s>]*preload[^\s>]*))"
    r"(?=[^>]*\bas=(?:[\"']script[\"']|script))[^>]*>",
    re.IGNORECASE,
)
NEXT_STYLESHEET_RE = re.compile(
    r"<link\b(?=[^>]*\brel=(?:[\"'][^\"']*stylesheet[^\"']*[\"']|[^\s>]*stylesheet[^\s>]*))"
    r"(?=[^>]*\bhref=(?:[\"']/_next/static/css/[^\"']+\.css[^\"']*[\"']|/_next/static/css/[^\s>]+\.css))[^>]*>",
    re.IGNORECASE,
)
NEXT_FLIGHT_RE = re.compile(
    r"<script>\s*\(?self\.__next_f.*?</script>",
    re.DOTALL,
)
NEXT_STREAM_CONTAINER_RE = re.compile(r"<div\s+hidden\s+id=(?:[\"']S:\d+[\"']|S:\d+)[^>]*>", re.IGNORECASE)
BODY_OPEN_RE = re.compile(r"<body\b[^>]*>", re.IGNORECASE)
HEAD_CLOSE_RE = re.compile(r"</head>", re.IGNORECASE)
BODY_VISIBLE_CONTENT_RE = re.compile(
    r"<(?:main|section|article|nav|header|table|ul|ol|h[1-6])\b|<div\b(?![^>]*\bhidden\b)",
    re.IGNORECASE,
)
MOBILE_CRITICAL_CSS = """
html,body{margin:0;min-height:100%;background:#07111f;color:#f2f6fb}
*{box-sizing:border-box}body{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:0}a{color:inherit;text-decoration:none}
.mobile-shell{min-height:100vh;width:min(100%,720px);margin:0 auto;padding:12px 12px 72px;background:#07111f;color:#f2f6fb}
.mobile-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}.mobile-header strong{display:block;font-size:20px;line-height:1.05}.mobile-header span,.mobile-header a{color:#9fb1c7;font-size:13px}.mobile-header a{border:1px solid #2a405c;border-radius:8px;padding:7px 9px;white-space:nowrap}
.mobile-nav{display:flex;gap:7px;overflow-x:auto;padding:2px 0 10px;margin-bottom:10px}.mobile-nav a{flex:0 0 auto;min-height:34px;display:inline-flex;align-items:center;border:1px solid #243954;border-radius:999px;padding:0 12px;color:#c5d2e4;background:#0d1b2e}.mobile-nav a.active{color:#5ca8ff;border-color:rgba(92,168,255,.55);background:rgba(54,132,255,.12)}
.mobile-status,.mobile-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:10px}.mobile-status div,.mobile-kpis div{min-width:0;border:1px solid #243954;border-radius:8px;background:#0d1b2e;padding:10px}.mobile-status span,.mobile-kpis span{display:block;color:#8da2bb;font-size:11px}.mobile-status strong,.mobile-kpis strong{display:block;margin-top:4px;color:#f2f6fb;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-freshness-fresh{color:#65e89b!important}.mobile-freshness-stale{color:#ffc85a!important}
.mobile-hero{margin-bottom:10px}.mobile-hero h1{margin:0 0 8px;font-size:24px;line-height:1.12}.mobile-hero p{margin:0;color:#c9d6e6;font-size:14px;line-height:1.35}
.mobile-filter{display:flex;gap:8px;margin-bottom:10px}.mobile-filter-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(92px,.6fr)}.mobile-filter input,.mobile-filter select,.mobile-filter button{min-width:0;min-height:38px;border-radius:8px;border:1px solid #2a405c;background:#0d1b2e;color:#f2f6fb;padding:0 10px}.mobile-filter button{border-color:#2563eb;background:#123d75;font-weight:800}
.mobile-card,.mobile-flat-card{border:1px solid #243954;border-radius:8px;background:linear-gradient(180deg,rgba(16,35,57,.96),rgba(9,22,38,.96));margin-bottom:10px}.mobile-card{padding:12px}.mobile-card-title,.mobile-flat-title{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:8px}.mobile-card-title h2,.mobile-flat-title h2{margin:0;font-size:18px;line-height:1.18}.mobile-card-title p{margin:2px 0 0;color:#9fb1c7;font-size:12px}.mobile-card-title a{color:#8db6ff;font-weight:800;font-size:13px;white-space:nowrap}.mobile-flat-card{overflow:hidden}.mobile-flat-title{align-items:center;border-bottom:1px solid #1f3148;padding:11px 12px;margin-bottom:0}.mobile-flat-title span{color:#9fb1c7;font-size:12px;white-space:nowrap}
.mobile-list{display:grid;gap:7px}.mobile-row{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #1f3148;border-radius:8px;background:rgba(7,17,31,.55);padding:10px}.mobile-row span{min-width:0}.mobile-row strong,.mobile-row small,.mobile-row b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-row strong{color:#e6edf7;font-size:14px}.mobile-row small{color:#9fb1c7;font-size:12px;margin-top:3px}.mobile-row-meta{flex:0 0 116px;text-align:right;display:grid;justify-items:end;gap:5px}.mobile-row-meta b{max-width:116px;color:#cfe0f5;font-size:12px}.mobile-empty{color:#9fb1c7;padding:12px 0}
.mobile-health-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;border:1px solid #263b55;border-radius:8px;background:#0d1b2e;padding:14px;margin-bottom:10px}.mobile-health-hero h1{margin:0;font-size:22px}.mobile-health-hero p{margin:4px 0 0;color:#9fb1c7;font-size:13px;line-height:1.35}.mobile-health-hero>strong,.mobile-inline-status{flex:0 0 auto;border:1px solid #2f4664;border-radius:999px;padding:5px 10px;font-size:12px;text-transform:uppercase}
.mobile-health-summary,.mobile-compact-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:10px}.mobile-health-summary span,.mobile-compact-meta span{min-width:0;border:1px solid #1f3148;border-radius:8px;background:rgba(7,17,31,.6);padding:9px 10px;color:#9fb1c7;font-size:12px;overflow-wrap:anywhere}.mobile-health-summary b,.mobile-compact-meta b{display:block;margin-top:2px;color:#e6edf7;font-size:13px}
.mobile-status-card-grid{display:grid;gap:7px;margin-bottom:10px}.mobile-status-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;align-items:center;border:1px solid #243954;border-radius:8px;background:rgba(10,25,43,.92);padding:10px 11px}.mobile-status-card span{color:#e6edf7;font-size:14px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mobile-status-card strong{border:1px solid #2f4664;border-radius:999px;padding:4px 8px;font-size:11px;font-weight:800;text-transform:uppercase}.mobile-status-card small{grid-column:1/-1;color:#9fb1c7;font-size:12px;overflow-wrap:anywhere}
.mobile-health-row,.mobile-alarm-row{border-bottom:1px solid #1f3148;background:rgba(7,17,31,.28)}.mobile-health-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px}.mobile-health-main{min-width:0}.mobile-health-main strong{display:block;color:#e6edf7;font-size:15px}.mobile-health-main small{display:block;margin-top:3px;color:#9fb1c7;font-size:12px;white-space:normal}.mobile-alarm-row{padding:12px}.mobile-alarm-head,.mobile-alarm-meta{display:flex;align-items:center;justify-content:space-between;gap:10px}.mobile-alarm-head strong{min-width:0;color:#e6edf7;font-size:15px;overflow-wrap:anywhere}.mobile-alarm-row p{margin:8px 0 0;color:#c9d6e6;font-size:13px;line-height:1.35;overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;justify-content:center;min-height:24px;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:800;border:1px solid #33465e;color:#d8e5f7;background:rgba(15,31,52,.9)}.mobile-shell .badge{min-height:21px;padding:1px 7px;font-size:11px}.route-badge{min-width:70px}.route-vps,.route-badge.route-vps,.status-ok,.confidence-exact,.confidence-managed,.mobile-health-ok{color:#65e89b;border-color:rgba(101,232,155,.45);background:rgba(38,166,91,.12)}.route-direct,.route-badge.route-direct,.status-warn,.confidence-estimated,.severity-warning,.mobile-health-warning{color:#ffc85a;border-color:rgba(255,200,90,.48);background:rgba(255,200,90,.12)}.route-mixed,.route-badge.route-mixed,.confidence-direct,.confidence-dns-interest{color:#91bdff;border-color:rgba(145,189,255,.52);background:rgba(145,189,255,.12)}.route-unknown,.route-badge.route-unknown,.confidence-unknown,.status-unknown,.mobile-health-unknown{color:#b7c3d2;border-color:rgba(183,195,210,.34);background:rgba(183,195,210,.08)}.severity-critical,.mobile-health-critical{color:#ff7a7a;border-color:rgba(255,122,122,.52);background:rgba(255,86,86,.13)}
.pagination{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;color:#a9bad0;flex-wrap:wrap}.pagination>div{display:flex;align-items:center;gap:10px}.pagination strong{color:#e6edf7}.muted-button{min-height:34px;border-radius:8px;border:1px solid #33465e;background:#0d1b2e;color:#8db6ff;padding:0 10px;display:inline-flex;align-items:center;justify-content:center;gap:8px}.mobile-shell .pagination{font-size:12px;gap:8px}.mobile-shell .pagination .muted-button{min-height:30px;padding:4px 8px}
"""

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}


class ClosingHTTPConnection(http.client.HTTPConnection):
    # Next.js streams HTML without a Content-Length on HTTP/1.1. The buffer
    # proxy keeps Connection: close on the upstream request so upstream.read()
    # has a deterministic end before nginx receives the body.
    _http_vsn = 11
    _http_vsn_str = "HTTP/1.1"


class BufferProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def do_GET(self):
        self._proxy()

    def do_HEAD(self):
        self._proxy(send_body=False)

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_PATCH(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def log_message(self, fmt, *args):
        return

    def _proxy(self, send_body=True):
        try:
            body = self._read_body()
            headers = self._upstream_headers()
            conn = ClosingHTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=60)
            conn.request(self.command, self.path, body=body, headers=headers)
            upstream = conn.getresponse()
            response_body = upstream.read()
            response_headers = {
                key.lower(): value for key, value in upstream.getheaders()
            }
            html_response = self._dehydrated_html_response(response_body, response_headers)
            if html_response is not None:
                response_body, response_headers = html_response
            else:
                split_response = self._split_js_response(response_body, response_headers)
                if split_response is not None:
                    response_body, response_headers = split_response

            encoding = self._selected_encoding(response_body, response_headers)
            if encoding == "br":
                response_body = brotli.compress(response_body, quality=6)
                response_headers["content-encoding"] = "br"
            elif encoding == "gzip":
                response_body = gzip.compress(response_body, compresslevel=9)
                response_headers["content-encoding"] = "gzip"

            self.send_response(upstream.status, upstream.reason)
            for key, value in upstream.getheaders():
                lower = key.lower()
                if lower in HOP_BY_HOP or lower in {"content-length", "content-encoding"}:
                    continue
                self.send_header(key, value)
            if "content-encoding" in response_headers:
                self.send_header("Content-Encoding", response_headers["content-encoding"])
            self.send_header("Content-Length", str(len(response_body)))
            self.send_header("Connection", "close")
            self.end_headers()
            if send_body and self.command != "HEAD":
                self.wfile.write(response_body)
                self.wfile.flush()
            self.close_connection = True
            conn.close()
        except Exception:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

    def _read_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length > MAX_REQUEST_BODY:
            raise ValueError("request body too large")
        if length <= 0:
            return None
        return self.rfile.read(length)

    def _upstream_headers(self):
        headers = {}
        for key, value in self.headers.items():
            if key.lower() in HOP_BY_HOP or key.lower() == "accept-encoding":
                continue
            headers[key] = value
        headers["Host"] = self.headers.get("Host", f"{UPSTREAM_HOST}:{UPSTREAM_PORT}")
        headers["Connection"] = "close"
        return headers

    def _selected_encoding(self, body, response_headers):
        if len(body) < 1024:
            return None
        if "content-encoding" in response_headers:
            return None
        content_type = response_headers.get("content-type", "")
        compressible = (
            content_type.startswith("text/")
            or "json" in content_type
            or "javascript" in content_type
        )
        if not compressible:
            return None
        accept_encoding = self.headers.get("Accept-Encoding", "")
        if brotli is not None and "br" in accept_encoding:
            return "br"
        if "gzip" in accept_encoding:
            return "gzip"
        return None

    def _dehydrated_html_response(self, body, response_headers):
        if not DISABLE_NEXT_JS:
            return None
        if self.command not in {"GET", "HEAD"}:
            return None
        content_type = response_headers.get("content-type", "")
        if "text/html" not in content_type:
            return None
        if "content-encoding" in response_headers:
            return None
        try:
            html = body.decode("utf-8")
        except UnicodeDecodeError:
            return None

        html = self._promote_next_stream_content(html)
        html = NEXT_SCRIPT_PRELOAD_RE.sub("", html)
        html = NEXT_SCRIPT_RE.sub("", html)
        html = NEXT_FLIGHT_RE.sub("", html)
        html = self._inline_mobile_css(html)
        headers = dict(response_headers)
        headers["content-type"] = content_type
        return html.encode("utf-8"), headers

    def _promote_next_stream_content(self, html):
        body_match = BODY_OPEN_RE.search(html)
        body_end = html.rfind("</body>")
        if body_match is None or body_end == -1:
            return html

        stream_matches = [
            match for match in NEXT_STREAM_CONTAINER_RE.finditer(html)
            if body_match.end() <= match.start() < body_end
        ]
        if not stream_matches:
            return html

        body_content_before_stream = html[body_match.end() : stream_matches[0].start()]
        if BODY_VISIBLE_CONTENT_RE.search(body_content_before_stream):
            return html

        for stream_match in stream_matches:
            content_start = stream_match.end()
            content_end = self._matching_div_end(html, stream_match.start(), content_start)
            if content_end is None:
                continue
            stream_content = html[content_start:content_end]
            if not stream_content.strip():
                continue
            return html[: body_match.end()] + stream_content + html[body_end:]
        return html

    def _inline_mobile_css(self, html):
        path = urlsplit(self.path).path
        if path != "/m" and not path.startswith("/m/"):
            return html
        html = NEXT_STYLESHEET_RE.sub("", html)
        if "data-ghostroute-mobile-critical" in html:
            return html
        style = f"<style data-ghostroute-mobile-critical>{MOBILE_CRITICAL_CSS}</style>"
        if HEAD_CLOSE_RE.search(html):
            return HEAD_CLOSE_RE.sub(style + "</head>", html, count=1)
        return style + html

    def _matching_div_end(self, html, div_start, content_start):
        depth = 1
        for match in re.finditer(r"</?div\b[^>]*>", html[content_start:], re.IGNORECASE):
            tag_start = content_start + match.start()
            if tag_start <= div_start:
                continue
            tag = match.group(0)
            if tag[1:2] == "/":
                depth -= 1
                if depth == 0:
                    return tag_start
            else:
                depth += 1
        return None

    def _split_js_response(self, body, response_headers):
        split = urlsplit(self.path)
        if not self._can_split_js(split, body, response_headers):
            return None

        query = parse_qs(split.query, keep_blank_values=True)
        source = body.decode("utf-8")
        part_count = (len(source) + JS_SPLIT_PART_SIZE - 1) // JS_SPLIT_PART_SIZE
        headers = {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": response_headers.get("cache-control", "public, max-age=31536000, immutable"),
        }

        if JS_SPLIT_QUERY_PARAM in query:
            try:
                part_index = int(query[JS_SPLIT_QUERY_PARAM][0])
            except (TypeError, ValueError, IndexError):
                part_index = -1
            if part_index < 0 or part_index >= part_count:
                return b"", headers
            start = part_index * JS_SPLIT_PART_SIZE
            end = start + JS_SPLIT_PART_SIZE
            return source[start:end].encode("utf-8"), headers

        return self._js_split_bootstrap(split, part_count).encode("utf-8"), headers

    def _can_split_js(self, split, body, response_headers):
        if self.command not in {"GET", "HEAD"}:
            return False
        if not split.path.startswith("/_next/static/") or not split.path.endswith(".js"):
            return False
        if len(body) <= JS_SPLIT_THRESHOLD:
            return False
        if "content-encoding" in response_headers:
            return False
        content_type = response_headers.get("content-type", "")
        if "javascript" not in content_type and "ecmascript" not in content_type:
            return False
        try:
            body.decode("utf-8")
        except UnicodeDecodeError:
            return False
        return True

    def _js_split_bootstrap(self, split, part_count):
        query = parse_qs(split.query, keep_blank_values=True)
        query.pop(JS_SPLIT_QUERY_PARAM, None)
        base_query = urlencode(query, doseq=True)
        base_path = urlunsplit(("", "", split.path, base_query, ""))
        return (
            "(function(){"
            f"var u={json.dumps(base_path)};"
            f"var n={part_count};"
            "var s='';"
            "for(var i=0;i<n;i++){"
            "var x=new XMLHttpRequest();"
            "x.open('GET',u+(u.indexOf('?')===-1?'?':'&')+'__gr_part='+i,false);"
            "x.send(null);"
            "if(x.status<200||x.status>=300){throw new Error('GhostRoute chunk part failed: '+u);}"
            "s+=x.responseText;"
            "}"
            "(0,eval)(s+'\\n//# sourceURL='+u);"
            "})();"
        )


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), BufferProxyHandler)
    server.serve_forever()
