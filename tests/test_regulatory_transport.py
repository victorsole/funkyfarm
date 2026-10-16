"""Real publisher HTTP bytes exercise production policy, limits and cancellation."""

import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
from urllib.parse import urlsplit

import httpx

from funkyfarm import regulatory_sources


def test_official_source_transport_bounds_validators_rejections_and_slow_drip_deadline(monkeypatch):
    ordinary = {"id": "authored-ec-transport", "url": "https://food.ec.europa.eu/animals/identification/bovine-animals_en"}
    eurlex = {"id": "authored-eurlex-transport", "url": "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32025R2203"}
    state = {"response": {}, "calls": []}

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            case = state["response"]
            state["calls"].append({"path": self.path, "headers": dict(self.headers)})
            try:
                self.send_response(case.get("status", 200))
                self.send_header("Content-Type", case.get("media", "text/plain"))
                self.send_header("Connection", "close")
                for key, value in case.get("headers", {}).items():
                    self.send_header(key, str(value))
                self.end_headers()
                self.wfile.flush()
                if case.get("gate"):
                    case["gate"].wait(timeout=3)
                body = case.get("body", b"")
                step = case.get("step", 8192)
                for offset in range(0, len(body), step):
                    self.wfile.write(body[offset:offset + step])
                    self.wfile.flush()
                    case["sent"] += min(step, len(body) - offset)
                    if case.get("drip"):
                        time.sleep(case["drip"])
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass
            finally:
                self.close_connection = True
                case["closed"].set()

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    endpoint = f"http://127.0.0.1:{server.server_port}/publisher"
    network = httpx.AsyncHTTPTransport.handle_async_request
    routed = []

    async def loopback(transport, request):
        assert str(request.url) in {ordinary["url"], eurlex["url"]}, "No external request is authorised by this fixture."
        routed.append(str(request.url))
        forwarded = httpx.Request(request.method, endpoint, headers=request.headers,
                                  stream=request.stream, extensions=request.extensions)
        return await network(transport, forwarded)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", loopback)

    def observe(source=ordinary, *, body=b"Authored source body", status=200, headers=None, media="text/plain", **options):
        state["response"] = {"body": body, "status": status, "headers": headers or {}, "media": media,
                             "sent": 0, "closed": threading.Event(), **options}
        return regulatory_sources.fetch_source(source, '"last-good-etag"', "Fri, 16 Oct 2026 00:00:00 GMT")

    try:
        # Only these reviewed EUR-Lex paths receive the larger law-document
        # allowance. Ordinary publishers remain at the original 512,000 bytes.
        assert regulatory_sources.MAX_BYTES == 512_000
        assert regulatory_sources.EURLEX_MAX_BYTES == 2 * 1024 * 1024
        assert regulatory_sources.FETCH_DEADLINE_SECONDS == 12
        for source, cap in ((ordinary, 512_000), (eurlex, 2 * 1024 * 1024)):
            for declared in (False, True):
                body = b"a" * cap
                response = observe(source, body=body, headers={"Content-Length": cap} if declared else {})
                assert response.status == "observed" and response.http_status == 200
                assert response.content_hash == hashlib.sha256(body).hexdigest()
            too_large = observe(source, body=b"b" * (cap + 1))
            assert too_large.status == "response_too_large" and too_large.content_hash is None
            # An oversized declaration must be rejected before waiting for any
            # body bytes. The gate avoids relying on localhost transfer speed.
            release = threading.Event()
            try:
                oversized = observe(source, body=b"unused body", headers={"Content-Length": cap + 1}, gate=release)
                assert oversized.status == "response_too_large" and oversized.http_status == 200
                assert state["response"]["sent"] == 0
            finally:
                release.set()
                assert state["response"]["closed"].wait(timeout=2)

        medium = b"m" * 852_534  # Authored bytes, matching a proved law-body size.
        assert observe(eurlex, body=medium).status == "observed"
        assert observe(ordinary, body=medium).status == "response_too_large"
        conditional = observe(status=304, body=b"")
        assert conditional.status == "not_modified" and conditional.http_status == 304
        assert conditional.etag == '"last-good-etag"' and conditional.last_modified == "Fri, 16 Oct 2026 00:00:00 GMT"
        assert state["calls"][-1]["headers"]["If-None-Match"] == '"last-good-etag"'
        assert state["calls"][-1]["headers"]["If-Modified-Since"] == "Fri, 16 Oct 2026 00:00:00 GMT"

        # These observations must never become successful source baselines.
        rejected = [
            ({"status": 202, "headers": {"ETag": '"pending"'}}, "http_error", 202),
            ({"media": "text/html", "body": b"<html><title>Just a moment</title>Checking your browser</html>"}, "publisher_access_challenge", 200),
            ({"status": 302, "headers": {"Location": "https://attacker.invalid/not-followed"}}, "redirect_blocked", 302),
            ({"headers": {"Content-Encoding": "gzip"}, "body": gzip.compress(b"Do not decompress publisher bodies")}, "unsupported_encoding", 200),
            ({"body": b""}, "empty_response", 200),
            ({"media": "image/png", "body": b"not a reviewed media type"}, "unsupported_content", 200),
        ]
        for payload, expected, http_status in rejected:
            before = len(routed)
            response = observe(**payload)
            assert (response.status, response.http_status, response.content_hash, response.etag, response.last_modified) == (expected, http_status, None, None, None)
            assert len(routed) == before + 1, "A rejected response must not cause a retry or redirect."
        before = len(routed)
        blocked = regulatory_sources.fetch_source({"id": "not-reviewed", "url": "http://127.0.0.1/not-public"})
        assert blocked.status == "blocked_source" and len(routed) == before

        # A byte arrives every 20ms, well before HTTPX's four-second inactivity
        # timeout. The old 16KiB buffered iterator waited for this entire <16KiB
        # response before checking its clock. Cancellation must interrupt it.
        monkeypatch.setattr(regulatory_sources, "FETCH_DEADLINE_SECONDS", 0.5)
        started = time.monotonic()
        response = observe(body=b"s" * 128, step=1, drip=0.02)
        elapsed = time.monotonic() - started
        assert response.status == "read_deadline" and response.http_status == 200
        assert response.content_hash is None and elapsed < 1.5, f"Hard deadline was not enforced: {elapsed:.3f}s"
        assert state["response"]["closed"].wait(timeout=1.5), "The cancelled socket continued consuming publisher bytes."
        assert state["response"]["sent"] < 128
        assert all(call["headers"]["Host"] in {urlsplit(ordinary["url"]).netloc, urlsplit(eurlex["url"]).netloc}
                   and call["headers"]["Accept-Encoding"] == "identity" and "Authorization" not in call["headers"]
                   and "Cookie" not in call["headers"] for call in state["calls"])
    finally:
        if state["response"].get("gate"):
            state["response"]["gate"].set()
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
