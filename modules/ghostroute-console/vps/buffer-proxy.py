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
NEXT_FLIGHT_RE = re.compile(
    r"<script>\s*\(?self\.__next_f.*?</script>",
    re.DOTALL,
)

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

        html = NEXT_SCRIPT_PRELOAD_RE.sub("", html)
        html = NEXT_SCRIPT_RE.sub("", html)
        html = NEXT_FLIGHT_RE.sub("", html)
        headers = dict(response_headers)
        headers["content-type"] = content_type
        return html.encode("utf-8"), headers

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
