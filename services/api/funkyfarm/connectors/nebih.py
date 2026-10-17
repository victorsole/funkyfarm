"""Opt-in, bounded e-GN reads. No authority writes or automatic confirmation.

The 2026 e-GN Whitebook governs diary tokens; the gateway guide governs
UsernameToken and the four fixed IP/certificate access endpoints.
"""

import os
from pathlib import Path
import re
import ssl
from time import monotonic
from uuid import uuid4
from xml.etree import ElementTree as ET

import httpx

from ..models import ApiError

SOAP = "http://schemas.xmlsoap.org/soap/envelope/"
GN = "http://gazdanaplo.aap.nebih.gov.hu/"
WSSE = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
WSU = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"
XSI = "http://www.w3.org/2001/XMLSchema-instance"
PASSWORD_TEXT = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText"
ENDPOINTS = {
    ("test", "ip"): "https://intesztfelirapi.nebih.gov.hu/peif/aap/services/GazdanaploService",
    ("production", "ip"): "https://felirapi.nebih.gov.hu/peif/aap/services/GazdanaploService",
    ("test", "certificate"): "https://intesztfelircertapi.nebih.gov.hu/peif/aap/services/GazdanaploService",
    ("production", "certificate"): "https://felircertapi.nebih.gov.hu/peif/aap/services/GazdanaploService",
}
OPERATIONS = {
    "getGnNovtermAdatokE1": "gazdalkodasi-naplo-novterm",
    "getGnNovtermMuveletekE1": "gn-termohely",
}
MAX_BYTES = 4 * 1024 * 1024
READ_BUDGET_SECONDS = 20
SECRET_NAMES = ("token", "password", "username", "credential", "secret", "apikey", "authorization",
                "certificate", "privatekey", "security", "callcontext", "kulsorendszer")
INFO = {"INFO", "I"}
ERROR = {"ERROR", "E"}


def _xml_text(value, maximum):
    return (isinstance(value, str) and 0 < len(value) <= maximum and bool(value.strip())
            and all(ord(c) in (9, 10, 13) or 0x20 <= ord(c) <= 0xD7FF
                    or 0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF for c in value))


def _configuration():
    environment = os.environ.get("FUNKYFARM_NEBIH_ENVIRONMENT", "test")
    mode = os.environ.get("FUNKYFARM_NEBIH_ACCESS_MODE", "")
    config = {"environment": environment, "mode": mode,
              "username": os.environ.get("FUNKYFARM_NEBIH_USERNAME", ""),
              "password": os.environ.get("FUNKYFARM_NEBIH_PASSWORD", ""),
              "system_id": os.environ.get("FUNKYFARM_NEBIH_SYSTEM_ID", "")}
    if (os.environ.get("FUNKYFARM_NEBIH_ENABLED") != "1" or (environment, mode) not in ENDPOINTS
            or not _xml_text(config["username"], 8192) or not _xml_text(config["password"], 8192)
            or not _xml_text(config["system_id"], 20)):
        raise ApiError(503, "nebih_not_configured", "An operator must configure the reviewed Nébih read connection before use.")
    config["url"] = ENDPOINTS[(environment, mode)]
    if mode == "certificate":
        for key, variable in (("cert", "FUNKYFARM_NEBIH_CLIENT_CERT"), ("key", "FUNKYFARM_NEBIH_CLIENT_KEY")):
            value = os.environ.get(variable, "")
            path = Path(value)
            if not value or not path.is_absolute() or not path.is_file():
                raise ApiError(503, "nebih_not_configured", "The operator's Nébih client certificate configuration is unavailable.")
            config[key] = str(path)
    return config


def _tls_context(config):
    context = ssl.create_default_context()
    if config["mode"] == "certificate":
        # Explicit empty password prevents an encrypted key from prompting.
        context.load_cert_chain(config["cert"], config["key"], password="")
    return context


def configured():
    """Configuration readiness only, never proof of account/service approval."""
    try:
        _tls_context(_configuration())
        return True
    except (ApiError, OSError, ValueError):
        return False


def _request(config, token, operation, message_id, parameters, page=None, page_size=None):
    if operation not in OPERATIONS:
        raise ApiError(422, "nebih_operation_not_allowed", "Only the two implemented diary read operations are allowed.")
    envelope = ET.Element(f"{{{SOAP}}}Envelope")
    header = ET.SubElement(envelope, f"{{{SOAP}}}Header")
    security = ET.SubElement(header, f"{{{WSSE}}}Security")
    credentials = ET.SubElement(security, f"{{{WSSE}}}UsernameToken", {f"{{{WSU}}}Id": "UsernameToken-" + str(uuid4())})
    ET.SubElement(credentials, f"{{{WSSE}}}Username").text = config["username"]
    ET.SubElement(credentials, f"{{{WSSE}}}Password", {"Type": PASSWORD_TEXT}).text = config["password"]
    body = ET.SubElement(envelope, f"{{{SOAP}}}Body")
    wrapper = ET.SubElement(body, f"{{{GN}}}{operation}")
    context = ET.SubElement(wrapper, "callContext")
    ET.SubElement(context, "messageId").text = message_id
    if page is not None:
        listing = ET.SubElement(context, "parameterList")
        for key, value in (("pagesize", page_size), ("pagenumber", page)):
            pair = ET.SubElement(listing, "parameter")
            ET.SubElement(pair, "key").text = key
            ET.SubElement(pair, "value").text = str(value)
    token_data = ET.SubElement(wrapper, "tokenAdat")
    ET.SubElement(token_data, "token").text = token
    ET.SubElement(token_data, "kulsorendszer").text = config["system_id"]
    business = ET.SubElement(wrapper, "callParameter")
    for key, value in parameters:
        ET.SubElement(business, key).text = value
    return ET.tostring(envelope, encoding="utf-8", xml_declaration=True)


class _BoundedTree(ET.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0
        self.namespaces = {}
        self.namespace_count = 0
        self.type_namespaces = {}

    def start_ns(self, prefix, uri):
        self.namespace_count += 1
        if self.namespace_count > 20000:
            raise ValueError("XML namespace bounds exceeded")
        self.namespaces.setdefault(prefix or "", []).append(uri)

    def end_ns(self, prefix):
        stack = self.namespaces[prefix or ""]
        stack.pop()
        if not stack:
            del self.namespaces[prefix or ""]

    def doctype(self, name, pubid, system):
        raise ValueError("DTD prohibited")

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > 64 or self.nodes > 20000:
            raise ValueError("XML bounds exceeded")
        node = super().start(tag, attrs)
        if f"{{{XSI}}}type" in attrs:
            value = attrs[f"{{{XSI}}}type"]
            prefix = value.split(":", 1)[0] if ":" in value else ""
            if prefix in self.namespaces:
                self.type_namespaces[id(node)] = {prefix: self.namespaces[prefix][-1]}
        return node

    def end(self, tag):
        node = super().end(tag)
        self.depth -= 1
        return node


def _schema():
    raise ApiError(502, "nebih_response_schema", "Nébih returned an unsupported or incomplete read response. No evidence was confirmed.")


def _one(parent, tag, required=False):
    nodes = [node for node in parent if node.tag == tag]
    if len(nodes) > 1 or required and not nodes:
        _schema()
    return nodes[0] if nodes else None


def _text(parent, name):
    node = _one(parent, name)
    if node is None:
        return None
    if len(node):
        _schema()
    return node.text or ""


class _Redactor:
    def __init__(self, config, token):
        # Username/system ID are identifiers, not passwords. Replacing short
        # identifiers throughout all business text would silently corrupt it.
        # Their actual credential elements are still omitted by _tree.
        self.secrets = sorted({token, config["password"], config.get("cert", ""), config.get("key", "")} - {""},
                              key=len, reverse=True)
        self.applied = False

    def __call__(self, value):
        if value is not None:
            original = value
            for secret in self.secrets:
                value = value.replace(secret, "[redacted]")
            self.applied = self.applied or value != original
        return value

    def identifier(self, value):
        # A redacted ID is unavailable, never an invented selectable source ID.
        return value if self(value) == value else None


def _credential_name(name):
    compact = re.sub(r"[^a-z0-9]", "", name.rsplit("}", 1)[-1].lower())
    return any(word in compact for word in SECRET_NAMES)


def _tree(node, redact, type_namespaces):
    # Only business elements are emitted. Never retain SOAP headers/faults,
    # credentials, raw XML, or provider request diagnostics. Clark names keep
    # safe business attribute namespaces unambiguous without XML round-tripping.
    if _credential_name(node.tag):
        redact.applied = True
        return None
    attributes = {}
    for name, value in node.attrib.items():
        if _credential_name(name):
            redact.applied = True
        else:
            attributes[redact(name)] = redact(value)
    return {"name": redact(node.tag), "text": redact(node.text or ""),
            "attributes": attributes,
            "type_namespaces": {redact(prefix): redact(uri) for prefix, uri in type_namespaces.get(id(node), {}).items()},
            "children": [child for item in node if (child := _tree(item, redact, type_namespaces)) is not None]}


def _parse(content, operation, config, token, message_id):
    if len(content) > MAX_BYTES:
        raise ApiError(502, "nebih_response_large", "The Nébih response exceeded the safe read limit.")
    try:
        builder = _BoundedTree()
        root = ET.fromstring(content, parser=ET.XMLParser(target=builder))
    except (ET.ParseError, ValueError):
        raise ApiError(502, "nebih_response_xml", "Nébih returned unsafe, oversized or invalid XML. No response content was retained.") from None
    if root.tag != f"{{{SOAP}}}Envelope" or any(n.tag not in (f"{{{SOAP}}}Header", f"{{{SOAP}}}Body") for n in root):
        _schema()
    _one(root, f"{{{SOAP}}}Header")
    body = _one(root, f"{{{SOAP}}}Body", required=True)
    if any(node.tag == f"{{{SOAP}}}Fault" for node in body):
        raise ApiError(502, "nebih_soap_fault", "Nébih rejected this read. Check authorised access with the operator; no fault content was retained.")
    if len(body) != 1 or body[0].tag != f"{{{GN}}}{operation}Response":
        _schema()
    response = body[0]
    if len(response) != 1 or response[0].tag != "result":
        _schema()
    result = response[0]
    expected = OPERATIONS[operation]
    if any(node.tag not in ("resultContext", expected) for node in result):
        _schema()
    context = _one(result, "resultContext")
    business = _one(result, expected)
    redact = _Redactor(config, token)
    highest, messages = None, []
    if context is not None:
        returned_id = _text(context, "messageId")
        if returned_id is not None and returned_id != message_id:
            _schema()
        highest = _text(context, "highestMessageSeverity")
        listing = _one(context, "messageList")
        if listing is not None:
            for item in listing:
                if item.tag != "message":
                    _schema()
                messages.append({key: redact(_text(item, key)) for key in ("code", "severity", "sourceSystemCode", "text")})
    severity = (highest or "").strip().upper()
    blocked = severity not in INFO or any((m["severity"] or "").strip().upper() not in INFO for m in messages)
    has_error = severity in ERROR or any((m["severity"] or "").strip().upper() in ERROR for m in messages)
    if business is None and not has_error:
        _schema()
    if business is not None and any(not isinstance(node.tag, str) or node.tag.startswith("{") for node in business.iter()):
        _schema()
    payload = _tree(business, redact, builder.type_namespaces) if business is not None else None
    return {"source_url": config["url"], "environment": config["environment"], "operation": operation,
            "message_id": message_id, "messages": messages, "highest_severity": redact(highest), "blocked": blocked,
            "payload": payload, "representation": "sanitized_business_tree", "redactions_applied": redact.applied}, business, redact


def _check_deadline(deadline):
    if monotonic() >= deadline:
        raise ApiError(504, "nebih_read_timeout", "The whole Nébih read exceeded its time budget. No automatic retry occurred.")


def _read(token, operation, parameters=(), page=None, page_size=None):
    deadline = monotonic() + READ_BUDGET_SECONDS
    if not _xml_text(token, 50):
        raise ApiError(422, "nebih_token_invalid", "Provide the diary's current e-GN token, at most 50 characters.")
    try:
        config = _configuration()
        tls = _tls_context(config)
    except (OSError, ValueError):
        raise ApiError(503, "nebih_not_configured", "The operator's Nébih TLS configuration is unavailable.") from None
    message_id = str(uuid4())
    request = _request(config, token, operation, message_id, parameters, page, page_size)
    _check_deadline(deadline)
    try:
        with httpx.Client(verify=tls, timeout=httpx.Timeout(10, connect=5), follow_redirects=False, trust_env=False) as client:
            with client.stream("POST", config["url"], content=request,
                    headers={"Content-Type": "text/xml; charset=utf-8", "Accept": "text/xml", "Accept-Encoding": "identity", "SOAPAction": '""',
                             "User-Agent": "FunkyFarm/0.1 authorised-diary-reader"}) as response:
                _check_deadline(deadline)
                if response.status_code != 200:
                    raise ApiError(502, "nebih_read_failed", "Nébih did not authorise or complete the read. No remote response content was retained.", {"status": response.status_code})
                if response.headers.get("Content-Encoding", "identity").strip().lower() != "identity":
                    raise ApiError(502, "nebih_response_encoding", "Nébih returned compressed content instead of the requested bounded identity response.")
                length = response.headers.get("Content-Length")
                if length is not None:
                    if not re.fullmatch(r"[0-9]{1,20}", length.strip()):
                        raise ApiError(502, "nebih_response_schema", "Nébih returned an invalid response length.")
                    if int(length) > MAX_BYTES:
                        raise ApiError(502, "nebih_response_large", "The Nébih response exceeded the safe read limit.")
                content = bytearray()
                chunks = response.iter_raw()
                while True:
                    _check_deadline(deadline)
                    try:
                        chunk = next(chunks)
                    except StopIteration:
                        break
                    _check_deadline(deadline)
                    if len(content) + len(chunk) > MAX_BYTES:
                        raise ApiError(502, "nebih_response_large", "The Nébih response exceeded the safe read limit. Narrow the selected page or use.")
                    content.extend(chunk)
    except (httpx.HTTPError, OSError, ValueError):
        raise ApiError(502, "nebih_read_failed", "Nébih could not be read safely. No automatic retry or evidence confirmation occurred.") from None
    _check_deadline(deadline)
    result = _parse(content, operation, config, token, message_id)
    _check_deadline(deadline)
    return result


def read_diary(token: str, page: int, page_size: int) -> dict:
    if (isinstance(page, bool) or not isinstance(page, int) or page < 1
            or isinstance(page_size, bool) or not isinstance(page_size, int) or not 1 <= page_size <= 50):
        raise ApiError(422, "nebih_paging_invalid", "Choose a page starting at one and between one and 50 sites per page.")
    result, business, redact = _read(token, "getGnNovtermAdatokE1", page=page, page_size=page_size)
    sites = []
    if business is not None:
        listing = _one(business, "gn-termohely-list")
        if listing is not None:
            for site in listing:
                if site.tag != "gn-termohely":
                    _schema()
                site_id = redact.identifier(_text(site, "id"))
                uses = _one(site, "gn-hasznositas-list")
                entries = []
                if uses is not None:
                    for use in uses:
                        if use.tag != "gn-hasznositas-extend":
                            _schema()
                        entries.append({"id": redact.identifier(_text(use, "id"))})
                sites.append({"id": site_id, "uses": entries})
    if len(sites) > page_size:
        _schema()
    totals = {m["text"].strip() for m in result["messages"] if m["code"] == "0000" and m["severity"] == "INFO"
              and m["text"] is not None and re.fullmatch(r"[0-9]{1,18}", m["text"].strip())}
    total = int(next(iter(totals))) if len(totals) == 1 else None
    if total is not None and sites and (page - 1) * page_size + len(sites) > total:
        _schema()
    result.update(sites=sites, number_returned=len(sites), page=page, page_size=page_size, total_sites=total,
                  partial=(page != 1 or total > len(sites)) if total is not None else None,
                  redactions_applied=redact.applied,
                  scope="paged_sites_only", notice="Only the selected diary site page was read. This is a sanitized business snapshot, not the full original SOAP response. Other diary blocks are not paginated; operation details require a separate selected site/use read. Codes, units and coordinates remain unverified source values, not confirmed farm facts.")
    return result


def read_operations(token: str, site_id: str, use_id: str) -> dict:
    for value in (site_id, use_id):
        if (not isinstance(value, str) or not re.fullmatch(r"[+-]?[0-9]{1,19}", value)
                or not -(2 ** 63) <= int(value) < 2 ** 63):
            raise ApiError(422, "nebih_selection_invalid", "Select the exact site and use identifiers returned by the diary read.")
    result, business, redact = _read(token, "getGnNovtermMuveletekE1", (("termohely-id", site_id), ("hasznositas-id", use_id)))
    verified = False
    if business is not None:
        uses = _one(business, "gn-hasznositas-list")
        # The WSDL permits an unbounded list, but this call explicitly filters
        # one use. Missing/duplicate/other IDs cannot establish that selection.
        if (_text(business, "id") != site_id or uses is None or len(uses) != 1
                or uses[0].tag != "gn-hasznositas-muvelet" or _text(uses[0], "id") != use_id):
            raise ApiError(502, "nebih_selection_mismatch", "The returned site and use did not uniquely match the requested selection. No result was attributed to that field.")
        verified = True
    result.update(requested_site_id=redact.identifier(site_id), requested_use_id=redact.identifier(use_id),
                  selection_verified=verified, redactions_applied=redact.applied)
    return result
