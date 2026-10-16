"""Reviewed public-source catalogue and bounded conditional HTTP observations.

This module observes publisher bytes, not the meaning or legal effect of a rule.
It receives no farm, tenant, user, credential, or arbitrary endpoint parameters.
"""

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

import httpx

CATALOG_PATH = Path(__file__).resolve().parents[3] / "shared" / "obligations.json"
MAX_SOURCES = 100
MAX_BYTES = 512_000
WORKFLOWS = frozenset({"annual", "cap", "inputs", "inspection", "sustainability"})
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
}


def allowed_source_url(url):
    if not isinstance(url, str) or len(url) > 2048 or any(ord(char) < 33 or ord(char) > 126 for char in url):
        return False
    try:
        parsed = urlsplit(url)
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
            "rules": linked_rules})
    return result


@dataclass(frozen=True)
class SourceObservation:
    status: str
    http_status: int | None = None
    content_hash: str | None = None
    etag: str | None = None
    last_modified: str | None = None


def _header(value):
    return value[:500] if isinstance(value, str) and value.isascii() and not any(ord(c) < 32 or ord(c) == 127 for c in value) else None


def fetch_source(source, etag=None, last_modified=None):
    """One bounded request. No redirects, credentials, proxies or retries."""
    if not allowed_source_url(source.get("url")):
        return SourceObservation("blocked_source")
    headers = {"Accept": "text/html, application/xhtml+xml, application/pdf, text/plain, application/xml, application/json", "Accept-Encoding": "identity", "User-Agent": "FunkyFarmers/0.1 official-source-change-observer"}
    if _header(etag):
        headers["If-None-Match"] = _header(etag)
    if _header(last_modified):
        headers["If-Modified-Since"] = _header(last_modified)
    try:
        deadline = time.monotonic() + 12
        with httpx.Client(timeout=httpx.Timeout(4, connect=4), follow_redirects=False, trust_env=False) as client:
            with client.stream("GET", source["url"], headers=headers) as response:
                if response.status_code == 304:
                    return SourceObservation("not_modified", 304, etag=_header(response.headers.get("etag")) or _header(etag), last_modified=_header(response.headers.get("last-modified")) or _header(last_modified))
                if response.status_code != 200:
                    return SourceObservation("redirect_blocked" if 300 <= response.status_code < 400 else "http_error", response.status_code)
                if response.headers.get("content-encoding", "identity").lower() != "identity":
                    return SourceObservation("unsupported_encoding", 200)
                media = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                if media not in {"text/html", "application/xhtml+xml", "application/pdf", "text/plain", "application/xml", "text/xml", "application/json"}:
                    return SourceObservation("unsupported_content", 200)
                content = bytearray()
                for chunk in response.iter_raw(chunk_size=16384):
                    if time.monotonic() > deadline:
                        return SourceObservation("read_deadline", 200)
                    content.extend(chunk)
                    if len(content) > MAX_BYTES:
                        return SourceObservation("response_too_large", 200)
                if not content:
                    return SourceObservation("empty_response", 200)
                # Common publisher anti-bot/interstitial pages are not legal source baselines.
                probe = bytes(content[:100_000]).lower()
                if media in {"text/html", "application/xhtml+xml"} and any(marker in probe for marker in (b"checking your browser", b"verify you are human", b"<title>just a moment", b"<title>access denied", b"<title>captcha", b"request rejected")):
                    return SourceObservation("publisher_access_challenge", 200)
                return SourceObservation("observed", 200, hashlib.sha256(content).hexdigest(), _header(response.headers.get("etag")), _header(response.headers.get("last-modified")))
    except (httpx.HTTPError, ValueError):
        return SourceObservation("network_error")
