"""Reviewed public-source catalogue and bounded conditional HTTP observations.

This module observes publisher bytes, not the meaning or legal effect of a rule.
It receives no farm, tenant, user, credential, or arbitrary endpoint parameters.
"""

import asyncio
from dataclasses import dataclass
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

import httpx

CATALOG_PATH = Path(__file__).resolve().parents[3] / "shared" / "obligations.json"
FUNDING_PATH = CATALOG_PATH.with_name("funding.json")
MAX_SOURCES = 100
MAX_BYTES = 512_000
MAX_TEXT = 24_000
# Complete EUR-Lex texts/notices exceed the normal page budget. Keep that
# exception publisher-specific; neither a user nor a redirect can raise it.
EURLEX_MAX_BYTES = 2 * 1024 * 1024
FETCH_DEADLINE_SECONDS = 12
WORKFLOWS = frozenset({"annual", "cap", "inputs", "inspection", "sustainability", "funding"})
# Expanding this list is a reviewed source/code change, never a browser setting.
OFFICIAL_PATHS = {
    "eur-lex.europa.eu": ("/legal-content/",),
    "food.ec.europa.eu": ("/animals/", "/plants/", "/horizontal-topics/"),
    "agriculture.ec.europa.eu": ("/",),
    "environment.ec.europa.eu": ("/",),
    "www.ama.at": ("/fachliche-informationen/",),
    "mze.gov.cz": ("/public/portal/mze/",),
    "www.gov.pl": ("/web/arimr/",),
    "portal.nebih.gov.hu": ("/",),
    "www.landwirtschaftskammer.de": ("/foerderung/", "/landwirtschaft/"),
    "www.rvo.nl": ("/onderwerpen/",),
    "www.apa.sk": ("/",),
    "agriculture.gouv.fr": ("/le-registre-dutilisation-des-produits-phytopharmaceutiques-au-format-electronique",),
    "www.gesetze-im-internet.de": ("/pflschg_2012/__11.html",),
    "gesetze-im-internet.de": ("/pflschg_2012/__11.html",),
    "landwirtschaftskammer.de": ("/landwirtschaft/pflanzenschutz/genehmigungen/aufzeichnung.htm",),
    "rea.ec.europa.eu": ("/funding-and-grants/promotion-agricultural-products-0/calls-proposals-promotion-agricultural-products_en",),
}


def allowed_source_url(url):
    if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 33 or ord(char) > 126 for char in url):
        return False
    try:
        parsed = urlsplit(url)
        if parsed.hostname == "rea.ec.europa.eu" and (parsed.path not in OFFICIAL_PATHS[parsed.hostname] or parsed.query):
            return False
        return (parsed.scheme == "https" and parsed.hostname in OFFICIAL_PATHS and parsed.port in (None, 443)
                and not parsed.username and not parsed.password and not parsed.fragment
                and ".." not in parsed.path and "%" not in parsed.path
                and any(parsed.path.startswith(prefix) for prefix in OFFICIAL_PATHS[parsed.hostname]))
    except ValueError:
        return False


def source_catalog():
    if not CATALOG_PATH.exists():
        return []
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8-sig"))
    raw = catalog.get("sources", [])
    if FUNDING_PATH.exists():
        funding = json.loads(FUNDING_PATH.read_text(encoding="utf-8-sig"))
        raw = [*raw, *funding.get("monitoring_sources", [])]
    if not isinstance(raw, list) or len(raw) > MAX_SOURCES:
        raise ValueError("Regulatory source catalogue must be a bounded source list")
    result, identifiers, urls = [], set(), set()
    for source in raw:
        if not isinstance(source, dict) or not isinstance(source.get("id"), str) or not source["id"] or len(source["id"]) > 160:
            raise ValueError("Regulatory source identifiers must be explicit and bounded")
        if not allowed_source_url(source.get("url")):
            raise ValueError(f"Regulatory source is outside the reviewed official allowlist: {source['id']}")
        if source["id"] in identifiers or source["url"] in urls:
            raise ValueError("Regulatory sources must have distinct identifiers and URLs")
        workflows = source.get("workflow_ids", [])
        if not isinstance(workflows, list) or any(item not in WORKFLOWS for item in workflows):
            raise ValueError("Regulatory source workflows are not recognised")
        identifiers.add(source["id"])
        urls.add(source["url"])
        linked_rules = [rule for rule in catalog.get("rules", []) if rule.get("id") in source.get("rule_ids", []) or any(citation.get("url") == source["url"] or citation.get("source_id") == source["id"] for citation in rule.get("citations", []) if isinstance(citation, dict))]
        result.append({"id": source["id"], "url": source["url"], "title": str(source.get("title", source["id"]))[:500],
            "country": source.get("country"), "region": source.get("region"), "workflow_ids": workflows,
            "source_type": source.get("source_type", "official_page"), "source_edition": source.get("version", source.get("edition")),
            "catalog_checked_at": source.get("checked_date", catalog.get("updated_at")), "rule_ids": [rule["id"] for rule in linked_rules],
            "poll_interval_seconds": max(900, min(86400, int(source["poll_interval_seconds"]))) if source.get("poll_interval_seconds") is not None else None,
            "rules": linked_rules})
    return result


@dataclass(frozen=True)
class SourceObservation:
    status: str
    http_status: int | None = None
    content_hash: str | None = None
    etag: str | None = None
    last_modified: str | None = None
    readable_text: str | None = None
    text_truncated: bool = False


class _ReadablePage(HTMLParser):
    """Retain plain publisher text only; never render or execute source markup."""

    HIDDEN = {"script", "style", "nav", "header", "footer", "svg", "form", "iframe", "noscript", "template"}
    BLOCKS = {"p", "li", "h1", "h2", "h3", "h4", "section", "article", "div", "br", "tr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = []
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag in self.HIDDEN:
            self.hidden.append(tag)
        elif not self.hidden and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if self.hidden:
            if tag == self.hidden[-1]:
                self.hidden.pop()
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def readable_excerpt(content, media, encoding="utf-8"):
    if media not in {"text/html", "application/xhtml+xml", "text/plain", "application/xml", "text/xml"}:
        return None, False
    try:
        text = content.decode(encoding or "utf-8", errors="replace")
    except LookupError:
        text = content.decode("utf-8", errors="replace")
    if media != "text/plain":
        parser = _ReadablePage()
        parser.feed(text)
        parser.close()
        text = "".join(parser.parts)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]", "", text)
    text = "\n".join(line for raw in text.splitlines() if (line := " ".join(raw.split())))
    return text[:MAX_TEXT] or None, len(text) > MAX_TEXT


def _header(value):
    return value[:500] if isinstance(value, str) and value.isascii() and not any(ord(c) < 32 or ord(c) == 127 for c in value) else None


def fetch_source(source, etag=None, last_modified=None):
    """Sync worker entry point; one request, no redirects/proxies or retries."""
    if not allowed_source_url(source.get("url")):
        return SourceObservation("blocked_source")
    return asyncio.run(_fetch_source(source, etag, last_modified))


async def _fetch_source(source, etag, last_modified):
    headers = {"Accept": "text/html, application/xhtml+xml, application/pdf, text/plain, application/xml, application/json", "Accept-Encoding": "identity", "User-Agent": "FunkyFarm/0.1 official-source-change-observer"}
    if _header(etag):
        headers["If-None-Match"] = _header(etag)
    if _header(last_modified):
        headers["If-Modified-Since"] = _header(last_modified)
    budget = EURLEX_MAX_BYTES if urlsplit(source["url"]).hostname == "eur-lex.europa.eu" else MAX_BYTES
    http_status = None
    try:
        # Cancel slow response reads even when a publisher keeps sending tiny
        # chunks before the per-read timeout. OS DNS cleanup remains external.
        async with asyncio.timeout(FETCH_DEADLINE_SECONDS), httpx.AsyncClient(timeout=httpx.Timeout(4, connect=4), follow_redirects=False, trust_env=False) as client:
            async with client.stream("GET", source["url"], headers=headers) as response:
                http_status = response.status_code
                if response.status_code == 304:
                    return SourceObservation("not_modified", 304, etag=_header(response.headers.get("etag")) or _header(etag), last_modified=_header(response.headers.get("last-modified")) or _header(last_modified))
                if response.status_code != 200:
                    return SourceObservation("redirect_blocked" if 300 <= response.status_code < 400 else "http_error", response.status_code)
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    return SourceObservation("unsupported_encoding", 200)
                media = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if media not in {"text/html", "application/xhtml+xml", "application/pdf", "text/plain", "application/xml", "text/xml", "application/json"}:
                    return SourceObservation("unsupported_content", 200)
                declared_length = response.headers.get("content-length")
                if declared_length is not None:
                    size = int(declared_length)
                    if size < 0:
                        return SourceObservation("invalid_response", 200)
                    if size > budget:
                        return SourceObservation("response_too_large", 200)
                content = bytearray()
                async for chunk in response.aiter_raw():
                    if len(content) + len(chunk) > budget:
                        return SourceObservation("response_too_large", 200)
                    content.extend(chunk)
                if not content:
                    return SourceObservation("empty_response", 200)
                # Common publisher anti-bot/interstitial pages are not legal source baselines.
                probe = bytes(content[:100_000]).lower()
                if media in {"text/html", "application/xhtml+xml"} and any(marker in probe for marker in (b"checking your browser", b"verify you are human", b"<title>just a moment", b"<title>access denied", b"<title>captcha", b"request rejected")):
                    return SourceObservation("publisher_access_challenge", 200)
                text, truncated = readable_excerpt(bytes(content), media, response.encoding)
                return SourceObservation("observed", 200, hashlib.sha256(content).hexdigest(), _header(response.headers.get("etag")), _header(response.headers.get("last-modified")), text, truncated)
    except TimeoutError:
        return SourceObservation("read_deadline", http_status)
    except (httpx.HTTPError, ValueError):
        return SourceObservation("network_error", http_status)
