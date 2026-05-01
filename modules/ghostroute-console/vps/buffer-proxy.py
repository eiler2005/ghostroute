#!/usr/bin/env python3
import http.client
import gzip
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import brotli
except ImportError:
    brotli = None


UPSTREAM_HOST = os.environ.get("GHOSTROUTE_BUFFER_UPSTREAM_HOST", "127.0.0.1")
UPSTREAM_PORT = int(os.environ.get("GHOSTROUTE_BUFFER_UPSTREAM_PORT", "3000"))
LISTEN_HOST = os.environ.get("GHOSTROUTE_BUFFER_LISTEN_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("GHOSTROUTE_BUFFER_LISTEN_PORT", "3001"))
MAX_REQUEST_BODY = int(os.environ.get("GHOSTROUTE_BUFFER_MAX_REQUEST_BODY", "1048576"))

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


class BufferProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

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
            conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=60)
            conn.request(self.command, self.path, body=body, headers=headers)
            upstream = conn.getresponse()
            response_body = upstream.read()
            response_headers = {
                key.lower(): value for key, value in upstream.getheaders()
            }
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
            conn.close()
        except Exception:
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()

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
            if key.lower() in HOP_BY_HOP:
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


if __name__ == "__main__":
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), BufferProxyHandler)
    server.serve_forever()
