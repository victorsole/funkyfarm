"""OAuth authorization-code/PKCE for the existing farm-restricted MCP resource.

Provider subscriptions and provider credentials never enter this service. Opaque
access credentials use the ordinary ffa_ validation boundary on every MCP call.
"""

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
import re
import secrets
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse
from psycopg.errors import CheckViolation
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from .assistant_tools import _grant, _human_browser
from .db import auth_transaction, fetch_record, insert_record, list_records, transaction, update_record
from .models import ApiError, StrictModel
from .security import Session, require_roles, require_session, token_hash

router = APIRouter(prefix="/assistant/oauth", tags=["assistant OAuth"])
metadata_router = APIRouter(tags=["OAuth discovery"])
BROWSER_COOKIE = "ff_oauth_request"
COOKIE_PATH = "/api/v1/assistant/oauth"
SCOPES = {"farm:read", "farm:propose", "offline_access"}
ACCESS_SECONDS = 900
REQUEST_SECONDS = 600
CODE_SECONDS = 120
GRANT_DAYS = 7
SAFE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff"}
DEFAULT_REDIRECTS = ["https://chatgpt.com/connector_platform_oauth_redirect", "https://claude.ai/api/mcp/auth_callback"]


class ClientInput(BaseModel):
    # RFC 7591 permits extra metadata; none of it is fetched or used as authority.
    model_config = ConfigDict(extra="ignore")
    client_name: str = Field(default="Assistant client", min_length=1, max_length=120)
    redirect_uris: list[str] = Field(min_length=1, max_length=3)
    grant_types: list[Literal["authorization_code", "refresh_token"]] = Field(default_factory=lambda: ["authorization_code"], min_length=1, max_length=2)
    response_types: list[Literal["code"]] = Field(default_factory=lambda: ["code"], min_length=1, max_length=1)
    token_endpoint_auth_method: Literal["none"] = "none"
    scope: str = Field(default="farm:read farm:propose offline_access", max_length=200)


class ConsentInput(StrictModel):
    decision: Literal["allow", "deny"]
    farm_ids: list[UUID] = Field(default_factory=list, max_length=100)
    allow_propose: bool = False
    allow_refresh: bool = False


class RevokeInput(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)


class OAuthFailure(Exception):
    def __init__(self, code, message, status=400):
        self.code, self.message, self.status = code, message, status


def _error(failure):
    return JSONResponse({"error": failure.code, "error_description": failure.message}, status_code=failure.status, headers=SAFE_HEADERS)


def _origin(value, allow_http):
    try:
        if any(ord(character) <= 32 or ord(character) == 127 for character in value):
            raise ValueError()
        parsed = urlsplit(value)
        _ = parsed.port
    except ValueError:
        raise OAuthFailure("temporarily_unavailable", "The operator must configure a valid public OAuth origin.", 503) from None
    local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or
            parsed.path not in {"", "/"} or parsed.scheme != "https" and not (allow_http and local and parsed.scheme == "http")):
        raise OAuthFailure("temporarily_unavailable", "OAuth needs a configured HTTPS origin. Local HTTP is available only in explicit development mode.", 503)
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def settings():
    """Canonical operator settings, never attacker-controlled Host/forwarded headers."""
    allow_http = os.environ.get("FUNKYFARMERS_OAUTH_ALLOW_LOCAL_HTTP", "false").lower() == "true"
    base = _origin(os.environ.get("FUNKYFARMERS_PUBLIC_URL", ""), allow_http)
    web = _origin(os.environ.get("FUNKYFARMERS_WEB_URL", base), allow_http)
    if urlsplit(web).hostname != urlsplit(base).hostname or urlsplit(web).scheme != urlsplit(base).scheme:
        raise OAuthFailure("temporarily_unavailable", "The consent website and OAuth API must share a hostname and scheme for browser-bound consent.", 503)
    try:
        redirects = json.loads(os.environ.get("FUNKYFARMERS_OAUTH_REDIRECT_URIS", json.dumps(DEFAULT_REDIRECTS)))
        if not isinstance(redirects, list) or not 1 <= len(redirects) <= 20 or any(not isinstance(uri, str) for uri in redirects):
            raise ValueError()
        for uri in redirects:
            parsed = urlsplit(uri)
            _ = parsed.port
            if (len(uri) > 2048 or parsed.username or parsed.password or parsed.fragment or not parsed.hostname or
                    any(ord(character) <= 32 or ord(character) == 127 for character in uri) or
                    any(key in {"code", "state", "iss", "error", "access_token", "refresh_token"} for key, _ in parse_qsl(parsed.query)) or
                    parsed.scheme != "https" and not (allow_http and parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"})):
                raise ValueError()
    except (ValueError, TypeError):
        raise OAuthFailure("temporarily_unavailable", "The operator must configure exact OAuth callback URLs.", 503) from None
    return {"base": base, "web": web, "issuer": base + "/api/v1/assistant/oauth",
            "resource": base + "/api/v1/assistant/mcp", "redirects": redirects,
            "resource_metadata": base + "/.well-known/oauth-protected-resource/api/v1/assistant/mcp",
            "local_development": urlsplit(base).scheme == "http"}


def challenge_header(scope="farm:read"):
    config = settings()
    return f'Bearer resource_metadata="{config["resource_metadata"]}", scope="{scope}"'


def protected_resource_metadata():
    try:
        config = settings()
        return JSONResponse({"resource": config["resource"], "authorization_servers": [config["issuer"]],
                             "scopes_supported": ["farm:read", "farm:propose"], "bearer_methods_supported": ["header"],
                             "resource_name": "FunkyFarmers selected farm tools"}, headers=SAFE_HEADERS)
    except OAuthFailure as failure:
        return _error(failure)


def authorization_server_metadata():
    try:
        config = settings()
        issuer = config["issuer"]
        return JSONResponse({"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token",
            "registration_endpoint": issuer + "/register", "revocation_endpoint": issuer + "/revoke",
            "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
            "token_endpoint_auth_methods_supported": ["none"], "revocation_endpoint_auth_methods_supported": ["none"],
            "code_challenge_methods_supported": ["S256"], "scopes_supported": sorted(SCOPES),
            "authorization_response_iss_parameter_supported": True, "client_id_metadata_document_supported": False}, headers=SAFE_HEADERS)
    except OAuthFailure as failure:
        return _error(failure)


for path in ("/.well-known/oauth-protected-resource/api/v1/assistant/mcp", "/.well-known/oauth-protected-resource",
             "/api/v1/assistant/.well-known/oauth-protected-resource"):
    metadata_router.add_api_route(path, protected_resource_metadata, methods=["GET"])
for path in ("/.well-known/oauth-authorization-server/api/v1/assistant/oauth", "/.well-known/oauth-authorization-server"):
    metadata_router.add_api_route(path, authorization_server_metadata, methods=["GET"])
router.add_api_route("/.well-known/oauth-protected-resource", protected_resource_metadata, methods=["GET"])
router.add_api_route("/.well-known/oauth-authorization-server", authorization_server_metadata, methods=["GET"])


@router.get("/config")
def configuration(response: Response):
    response.headers.update(SAFE_HEADERS)
    try:
        config = settings()
    except OAuthFailure as failure:
        return {"available": False, "message": failure.message, "provider_account_verified": False}
    return {"available": True, "resource": config["resource"], "issuer": config["issuer"],
            "local_development": config["local_development"], "provider_account_verified": False,
            "authorization": "OAuth authorization code with S256 PKCE and rotating refresh tokens",
            "message": "Connect from your assistant's custom MCP connector settings. Live provider-account connectivity has not been verified."}


def _throttle(request, operation, client_id=""):
    address = request.client.host if request.client else "unknown"
    with auth_transaction() as conn:
        allowed = conn.execute("SELECT authentication_attempt(%s) AS allowed",
                               ("address:oauth:" + operation + ":" + token_hash(address),)).fetchone()["allowed"]
        client_allowed = conn.execute("SELECT authentication_attempt(%s) AS allowed",
                                      ("oauth:" + operation + ":" + token_hash(address + ":" + client_id),)).fetchone()["allowed"]
    if not allowed or not client_allowed:
        raise OAuthFailure("temporarily_unavailable", "Too many authorization attempts. Try again after 15 minutes.", 429)


def _client(conn, client_id):
    if not isinstance(client_id, str) or not re.fullmatch(r"ffoc_[A-Za-z0-9_-]{32,80}", client_id):
        raise OAuthFailure("invalid_client", "Use a client registered with this authorization server.")
    value = conn.execute("SELECT oauth_get_client(%s) AS client", (client_id,)).fetchone()["client"]
    if not value:
        raise OAuthFailure("invalid_client", "This registered client is unavailable or expired.")
    return value


def _scopes(value):
    if not isinstance(value, str) or len(value) > 200:
        raise OAuthFailure("invalid_scope", "Choose the published farm scopes.")
    scopes = set(value.split())
    if not scopes or scopes - SCOPES or "farm:read" not in scopes:
        raise OAuthFailure("invalid_scope", "Farm read access is required; only published read, propose and offline scopes are available.")
    return scopes


async def _body(request, content_type):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != content_type:
        raise OAuthFailure("invalid_request", f"Use {content_type} for this endpoint.")
    result = bytearray()
    async for chunk in request.stream():
        if len(result) + len(chunk) > 16_384:
            raise OAuthFailure("invalid_request", "OAuth input must be at most 16 KiB.", 413)
        result.extend(chunk)
    return bytes(result)


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result or len(key) > 100 or len(value) > 4096:
            raise OAuthFailure("invalid_request", "Use each bounded OAuth parameter once.")
        result[key] = value
    return result


@router.post("/register")
async def register_client(request: Request):
    try:
        config = settings()
        raw = await _body(request, "application/json")
        try:
            body = ClientInput.model_validate(json.loads(raw))
        except (ValueError, ValidationError, UnicodeError, RecursionError):
            raise OAuthFailure("invalid_client_metadata", "Use bounded public-client registration metadata with exact redirect URLs.") from None
        redirects = list(dict.fromkeys(body.redirect_uris))
        if not body.client_name.strip() or any(uri not in config["redirects"] for uri in redirects):
            raise OAuthFailure("invalid_redirect_uri", "Every callback must exactly match an operator-allowed HTTPS provider callback.")
        if "authorization_code" not in body.grant_types:
            raise OAuthFailure("invalid_client_metadata", "Only a human-authorized code flow can create an assistant connection.")
        scopes = _scopes(body.scope)
        await run_in_threadpool(_throttle, request, "register")
        client_id = "ffoc_" + secrets.token_urlsafe(32)
        metadata = {"client_id": client_id, "client_name": body.client_name.strip(), "redirect_uris": redirects,
                    "token_endpoint_auth_method": "none", "grant_types": sorted(set(body.grant_types)),
                    "response_types": ["code"], "scope": " ".join(sorted(scopes)),
                    "client_id_issued_at": int(datetime.now(timezone.utc).timestamp())}
        def save():
            with auth_transaction() as conn:
                return conn.execute("SELECT oauth_register_client(%s,%s,%s) AS client", (
                    client_id, Jsonb(metadata), datetime.now(timezone.utc) + timedelta(days=90))).fetchone()["client"]
        try:
            registered = await run_in_threadpool(save)
        except CheckViolation as error:
            capacity = error.diag.message_primary == "client registration capacity reached"
            raise OAuthFailure("temporarily_unavailable", "Client registration is at capacity." if capacity else "Authorization storage needs its configured registration bounds updated.", 429 if capacity else 503) from None
        if not registered:
            raise OAuthFailure("temporarily_unavailable", "Client registration is at capacity. Try again later.", 429)
        return JSONResponse(registered, status_code=201, headers=SAFE_HEADERS)
    except OAuthFailure as failure:
        return _error(failure)


@router.get("/authorize")
def authorize(request: Request):
    try:
        config = settings()
        params = _unique(request.query_params.multi_items())
        if len(str(request.url.query)) > 8192:
            raise OAuthFailure("invalid_request", "The authorization request is too large.")
        if params.get("response_type") != "code":
            raise OAuthFailure("unsupported_response_type", "Only authorization-code responses are supported.")
        if params.get("code_challenge_method") != "S256" or not re.fullmatch(r"[A-Za-z0-9_-]{43}", params.get("code_challenge", "")):
            raise OAuthFailure("invalid_request", "S256 PKCE is required for every authorization request.")
        if params.get("resource") != config["resource"]:
            raise OAuthFailure("invalid_target", "The requested resource must be the canonical FunkyFarmers MCP URL.")
        state = params.get("state", "")
        if not state or len(state) > 1024:
            raise OAuthFailure("invalid_request", "Include a bounded client state value for the authorization response.")
        scopes = _scopes(params.get("scope", "farm:read"))
        _throttle(request, "authorize", params.get("client_id", ""))
        browser_secret = secrets.token_urlsafe(32)
        request_id = uuid4()
        expires = datetime.now(timezone.utc) + timedelta(seconds=REQUEST_SECONDS)
        with auth_transaction() as conn:
            client = _client(conn, params.get("client_id"))
            redirect = params.get("redirect_uri")
            if redirect not in client["redirect_uris"] or redirect not in config["redirects"]:
                raise OAuthFailure("invalid_request", "The callback must exactly match this client's registered redirect URI.")
            if scopes - _scopes(client["scope"]):
                raise OAuthFailure("invalid_scope", "This client did not register the requested scope.")
            if "offline_access" in scopes and "refresh_token" not in client["grant_types"]:
                raise OAuthFailure("invalid_scope", "Offline access needs a registered refresh-token grant.")
            data = {"client_id": client["client_id"], "client_name": client["client_name"], "redirect_uri": redirect,
                    "scope": " ".join(sorted(scopes)), "resource": config["resource"], "issuer": config["issuer"],
                    "state": state, "code_challenge": params["code_challenge"], "expires_at": expires.isoformat()}
            try:
                created = conn.execute("SELECT oauth_create_request(%s,%s,%s,%s) AS created",
                                       (request_id, token_hash(browser_secret), Jsonb(data), expires)).fetchone()["created"]
            except CheckViolation as error:
                capacity = error.diag.message_primary == "authorization request capacity reached"
                raise OAuthFailure("temporarily_unavailable", "Authorization is at capacity." if capacity else "Authorization storage needs its configured request bounds updated.", 429 if capacity else 503) from None
            if not created:
                raise OAuthFailure("temporarily_unavailable", "Authorization is busy. Try connecting again later.", 429)
        response = RedirectResponse(config["web"] + "/app/assistant/connect?" + urlencode({"request": str(request_id)}), status_code=303, headers=SAFE_HEADERS)
        response.set_cookie(BROWSER_COOKIE, browser_secret, max_age=REQUEST_SECONDS, httponly=True,
                            secure=not config["local_development"], samesite="lax", path=COOKIE_PATH)
        return response
    except OAuthFailure as failure:
        return _error(failure)


def _owner(request, session):
    _human_browser(request)
    require_roles(session, "owner")
    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Review assistant access in your signed-in browser.")


def _pending(conn, request_id, request, consume=False):
    secret = request.cookies.get(BROWSER_COOKIE, "")
    if not 32 <= len(secret) <= 100:
        raise ApiError(400, "oauth_browser_binding", "Restart the connection from your assistant in this browser. This consent request belongs to a different or expired browser flow.")
    function = "oauth_consume_request" if consume else "oauth_get_request"
    value = conn.execute(f"SELECT {function}(%s,%s) AS pending", (request_id, token_hash(secret))).fetchone()["pending"]
    if not value:
        raise ApiError(400, "oauth_request_expired", "This browser's connection request expired or was already used. Start again from your assistant.")
    try:
        config = settings()
        client = _client(conn, value["client_id"])
    except OAuthFailure as failure:
        raise ApiError(failure.status, failure.code, failure.message) from None
    if value["resource"] != config["resource"] or value["issuer"] != config["issuer"] or value["redirect_uri"] not in config["redirects"] or value["redirect_uri"] not in client["redirect_uris"]:
        raise ApiError(400, "oauth_request_changed", "The connection settings changed. Start again from your assistant.")
    return value


@router.get("/requests/{request_id}")
def consent_request(request_id: UUID, request: Request, response: Response, session: Session = Depends(require_session)):
    _owner(request, session)
    response.headers.update(SAFE_HEADERS)
    with transaction(session) as conn:
        pending = _pending(conn, request_id, request)
        farms = list_records(conn, "farms", 100)
        return {"request_id": str(request_id), "client_name": pending["client_name"], "client_id": pending["client_id"],
                "redirect_uri": pending["redirect_uri"], "redirect_hostname": urlsplit(pending["redirect_uri"]).hostname,
                "requested_scopes": pending["scope"].split(), "resource": pending["resource"], "expires_at": pending["expires_at"],
                "workspace": {"id": session.workspace_id}, "farms": [{"id": farm["id"], "name": farm["data"]["name"]} for farm in farms["items"]],
                "farm_limit": 100, "farm_count": farms["total"], "provider_account_verified": False,
                "notice": "The client name is registration metadata, not verified provider identity. Only the selected farms and permissions are granted. Nothing can approve evidence, issue reports or file with authorities."}


def _redirect(pending, config, **values):
    separator = "&" if "?" in pending["redirect_uri"] else "?"
    return pending["redirect_uri"] + separator + urlencode({**values, "state": pending["state"], "iss": config["issuer"]})


@router.post("/requests/{request_id}/consent")
def consent(request_id: UUID, body: ConsentInput, request: Request, response: Response, session: Session = Depends(require_session)):
    _owner(request, session)
    try:
        config = settings()
    except OAuthFailure as failure:
        raise ApiError(failure.status, failure.code, failure.message) from None
    with transaction(session) as conn:
        pending = _pending(conn, request_id, request)
        if body.decision == "deny":
            _pending(conn, request_id, request, consume=True)
            response.headers.update(SAFE_HEADERS)
            response.delete_cookie(BROWSER_COOKIE, path=COOKIE_PATH)
            return {"redirect_url": _redirect(pending, config, error="access_denied", error_description="The farm owner declined assistant access.")}
        farms = sorted(set(map(str, body.farm_ids)))
        if not farms:
            raise ApiError(422, "farm_selection_required", "Choose at least one farm, or decline this connection.")
        requested = set(pending["scope"].split())
        if body.allow_propose and "farm:propose" not in requested or body.allow_refresh and "offline_access" not in requested:
            raise ApiError(422, "oauth_scope_escalation", "Only permissions requested by this client can be granted.")
        for farm_id in farms:
            fetch_record(conn, "farms", farm_id)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':assistant-credentials',0))")
        active = conn.execute("SELECT count(*) AS n FROM records WHERE kind='ai_oauth_grants' AND deleted_at IS NULL "
                              "AND data->>'revoked_at' IS NULL AND (data->>'expires_at')::timestamptz>now()").fetchone()["n"]
        if active >= 20:
            raise ApiError(429, "assistant_connection_limit", "Disconnect an unused assistant connection before adding another.")
        _pending(conn, request_id, request, consume=True)
        scopes = {"farm:read"} | ({"farm:propose"} if body.allow_propose else set()) | ({"offline_access"} if body.allow_refresh else set())
        grant = insert_record(conn, "ai_oauth_grants", {"client_id": pending["client_id"], "client_name": pending["client_name"],
            "created_by": session.user_id, "farm_ids": farms, "permissions": ["read", "propose"] if body.allow_propose else ["read"],
            "scope": " ".join(sorted(scopes)), "resource": config["resource"], "issuer": config["issuer"],
            "grant_fingerprint": _grant(conn), "expires_at": (datetime.now(timezone.utc) + timedelta(days=GRANT_DAYS)).isoformat(),
            "revoked_at": None, "current_credential_id": None, "current_refresh_id": None, "last_issued_at": None})
        code = "ffac_" + secrets.token_urlsafe(32)
        insert_record(conn, "ai_oauth_codes", {"token_hash": token_hash(code), "created_by": session.user_id,
            "grant_id": grant["id"], "client_id": pending["client_id"], "redirect_uri": pending["redirect_uri"],
            "resource": pending["resource"], "code_challenge": pending["code_challenge"], "consumed_at": None,
            "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=CODE_SECONDS)).isoformat()})
    response.headers.update(SAFE_HEADERS)
    response.delete_cookie(BROWSER_COOKIE, path=COOKIE_PATH)
    return {"redirect_url": _redirect(pending, config, code=code), "connection_id": grant["id"]}


def _public_grant(record):
    fields = ("client_name", "client_id", "farm_ids", "permissions", "scope", "expires_at", "revoked_at", "last_issued_at")
    return {"id": record["id"], "revision": record["revision"], "data": {key: record["data"].get(key) for key in fields}}


@router.get("/connections")
def connections(request: Request, response: Response, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                session: Session = Depends(require_session)):
    _owner(request, session)
    response.headers.update(SAFE_HEADERS)
    with transaction(session) as conn:
        page = list_records(conn, "ai_oauth_grants", limit, offset)
        return {**page, "items": [_public_grant(record) for record in page["items"]]}


def _locked_grant(conn, grant_id):
    conn.execute("SELECT id FROM records WHERE kind='ai_oauth_grants' AND id=%s AND deleted_at IS NULL FOR UPDATE", (UUID(grant_id),))
    return fetch_record(conn, "ai_oauth_grants", grant_id)


def _revoke_grant(conn, grant, reason):
    credential_id = grant["data"].get("current_credential_id")
    if credential_id:
        try:
            conn.execute("SELECT id FROM records WHERE kind='ai_credentials' AND id=%s AND deleted_at IS NULL FOR UPDATE", (UUID(credential_id),))
            credential = fetch_record(conn, "ai_credentials", credential_id)
            if not credential["data"].get("revoked_at"):
                update_record(conn, "ai_credentials", credential["id"], credential["revision"], {
                    **credential["data"], "revoked_at": datetime.now(timezone.utc).isoformat()})
        except ApiError as error:
            if error.status != 404:
                raise
    if not grant["data"].get("revoked_at"):
        grant = update_record(conn, "ai_oauth_grants", grant["id"], grant["revision"], {
            **grant["data"], "revoked_at": datetime.now(timezone.utc).isoformat(), "revocation_reason": reason})
    return grant


@router.post("/connections/{grant_id}/revoke")
def disconnect(grant_id: UUID, body: RevokeInput, request: Request, response: Response, session: Session = Depends(require_session)):
    _owner(request, session)
    response.headers.update(SAFE_HEADERS)
    with transaction(session) as conn:
        grant = _locked_grant(conn, str(grant_id))
        if grant["revision"] != body.expected_revision:
            raise ApiError(409, "revision_conflict", "This connection changed. Reload it before disconnecting it.")
        return _public_grant(_revoke_grant(conn, grant, "owner_disconnected"))


def _expires(data):
    try:
        return datetime.fromisoformat(data["expires_at"]) > datetime.now(timezone.utc)
    except (ValueError, TypeError, KeyError):
        return False


def _valid_grant(conn, grant, config):
    data = grant["data"]
    if (data.get("revoked_at") or not _expires(data) or data.get("resource") != config["resource"] or data.get("issuer") != config["issuer"] or
            data.get("grant_fingerprint") != _grant(conn)):
        return False
    for farm_id in data["farm_ids"]:
        fetch_record(conn, "farms", farm_id)
    credential_id = data.get("current_credential_id")
    if credential_id and fetch_record(conn, "ai_credentials", credential_id)["data"].get("revoked_at"):
        return False
    return True


def _mint(conn, grant):
    data = grant["data"]
    previous = data.get("current_credential_id")
    if previous:
        conn.execute("SELECT id FROM records WHERE kind='ai_credentials' AND id=%s AND deleted_at IS NULL FOR UPDATE", (UUID(previous),))
        old = fetch_record(conn, "ai_credentials", previous)
        if old["data"].get("revoked_at"):
            raise OAuthFailure("invalid_grant", "The prior access credential was revoked. Start a new connection.")
        update_record(conn, "ai_credentials", old["id"], old["revision"], {**old["data"], "revoked_at": datetime.now(timezone.utc).isoformat()})
    active = conn.execute("SELECT count(*) AS n FROM records WHERE kind='ai_credentials' AND deleted_at IS NULL "
                          "AND data->>'revoked_at' IS NULL AND (data->>'expires_at')::timestamptz>now()").fetchone()["n"]
    if active >= 20:
        raise OAuthFailure("temporarily_unavailable", "Assistant access is at capacity. Revoke an unused connection.", 429)
    access = "ffa_" + secrets.token_urlsafe(64)
    expires = min(datetime.now(timezone.utc) + timedelta(seconds=ACCESS_SECONDS), datetime.fromisoformat(data["expires_at"]))
    credential = insert_record(conn, "ai_credentials", {"token_hash": token_hash(access), "created_by": data["created_by"],
        "farm_ids": data["farm_ids"], "permissions": data["permissions"], "grant_fingerprint": data["grant_fingerprint"],
        "expires_at": expires.isoformat(), "revoked_at": None, "name": data["client_name"], "token_type": "oauth",
        "oauth_grant_id": grant["id"], "oauth_resource": data["resource"], "oauth_issuer": data["issuer"]})
    response = {"access_token": access, "token_type": "Bearer", "expires_in": max(1, int((expires - datetime.now(timezone.utc)).total_seconds())), "scope": data["scope"]}
    refresh_id = None
    if "offline_access" in data["scope"].split():
        refresh = "ffr_" + secrets.token_urlsafe(64)
        refresh_record = insert_record(conn, "ai_oauth_refresh", {"token_hash": token_hash(refresh), "created_by": data["created_by"],
            "grant_id": grant["id"], "client_id": data["client_id"], "resource": data["resource"], "expires_at": data["expires_at"], "consumed_at": None})
        refresh_id = refresh_record["id"]
        response["refresh_token"] = refresh
    update_record(conn, "ai_oauth_grants", grant["id"], grant["revision"], {**data, "current_credential_id": credential["id"],
        "current_refresh_id": refresh_id, "last_issued_at": datetime.now(timezone.utc).isoformat()})
    return response


def _lookup(hash_value, kind):
    with auth_transaction() as conn:
        return conn.execute("SELECT * FROM oauth_lookup_record(%s,%s)", (hash_value, kind)).fetchone()


def _exchange(params, config):
    kind = params.get("grant_type")
    if kind not in {"authorization_code", "refresh_token"}:
        raise OAuthFailure("unsupported_grant_type", "Use a PKCE authorization code or a rotating refresh token.")
    if params.get("resource") != config["resource"]:
        raise OAuthFailure("invalid_target", "The resource must match the canonical MCP resource.")
    with auth_transaction() as conn:
        _client(conn, params.get("client_id"))
    secret = params.get("code" if kind == "authorization_code" else "refresh_token", "")
    expected_prefix = "ffac_" if kind == "authorization_code" else "ffr_"
    if not secret.startswith(expected_prefix) or not 40 <= len(secret) <= 120:
        raise OAuthFailure("invalid_grant", "This code or refresh token is invalid, expired or already used.")
    record_kind = "ai_oauth_codes" if kind == "authorization_code" else "ai_oauth_refresh"
    found = _lookup(token_hash(secret), record_kind)
    if not found:
        raise OAuthFailure("invalid_grant", "This code or refresh token is invalid, expired or already used.")
    session = Session(str(found["user_id"]), str(found["workspace_id"]), "owner", "")
    failure = None
    response = None
    try:
        with transaction(session) as conn:
            # One workspace budget plus one grant lock serialize rotations and replay revocation.
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':assistant-credentials',0))")
            item = fetch_record(conn, record_kind, str(found["id"]))
            grant = _locked_grant(conn, item["data"]["grant_id"])
            item = fetch_record(conn, record_kind, item["id"])
            data = item["data"]
            if data.get("client_id") != params.get("client_id") or data.get("resource") != params["resource"] or grant["data"].get("client_id") != params["client_id"]:
                raise OAuthFailure("invalid_grant", "The client and resource must match this authorization.")
            if kind == "authorization_code":
                verifier = params.get("code_verifier", "")
                if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier) or params.get("redirect_uri") != data.get("redirect_uri"):
                    raise OAuthFailure("invalid_grant", "The registered callback and PKCE verifier are required.")
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
                if not hmac.compare_digest(challenge, data.get("code_challenge", "")):
                    raise OAuthFailure("invalid_grant", "The PKCE verifier does not match this authorization.")
            if data.get("consumed_at"):
                _revoke_grant(conn, grant, "authorization_code_reuse" if kind == "authorization_code" else "refresh_token_reuse")
                failure = OAuthFailure("invalid_grant", "This authorization was already used. Its connection has been revoked; start a new connection.")
            elif not _expires(data) or not _valid_grant(conn, grant, config):
                failure = OAuthFailure("invalid_grant", "This authorization expired or its farm permissions were revoked.")
            elif kind == "refresh_token" and grant["data"].get("current_refresh_id") != item["id"]:
                _revoke_grant(conn, grant, "refresh_token_not_current")
                failure = OAuthFailure("invalid_grant", "The refresh token is no longer current. Start a new connection.")
            elif params.get("scope") and set(params["scope"].split()) != set(grant["data"]["scope"].split()):
                failure = OAuthFailure("invalid_scope", "Refresh cannot change the original consent. Connect again to change permissions.")
            else:
                update_record(conn, record_kind, item["id"], item["revision"], {**data, "consumed_at": datetime.now(timezone.utc).isoformat()})
                response = _mint(conn, grant)
    except ApiError as error:
        if error.status not in {403, 404, 409}:
            raise
        raise OAuthFailure("invalid_grant", "The authorization or workspace permission is no longer available.") from None
    # Deliberately raise AFTER commit so replay-triggered revocation cannot roll back.
    if failure:
        raise failure
    return response


async def _form(request):
    raw = await _body(request, "application/x-www-form-urlencoded")
    try:
        return _unique(parse_qsl(raw.decode("utf-8"), keep_blank_values=True, strict_parsing=True, max_num_fields=20))
    except (ValueError, UnicodeError):
        raise OAuthFailure("invalid_request", "Use a bounded form-encoded OAuth request.") from None


@router.post("/token")
async def token(request: Request):
    try:
        config = settings()
        params = await _form(request)
        if request.headers.get("authorization"):
            raise OAuthFailure("invalid_client", "Public clients use client_id and PKCE, without a client secret.", 401)
        await run_in_threadpool(_throttle, request, "token", params.get("client_id", ""))
        result = await run_in_threadpool(_exchange, params, config)
        return JSONResponse(result, headers=SAFE_HEADERS)
    except OAuthFailure as failure:
        return _error(failure)


def _revoke_token(params):
    secret = params.get("token", "")
    if not 40 <= len(secret) <= 120:
        return
    kind = "ai_oauth_refresh" if secret.startswith("ffr_") else "ai_credentials" if secret.startswith("ffa_") else None
    if kind is None:
        return
    found = _lookup(token_hash(secret), kind)
    if not found:
        return
    session = Session(str(found["user_id"]), str(found["workspace_id"]), "owner", "")
    try:
        with transaction(session) as conn:
            item = fetch_record(conn, kind, str(found["id"]))
            grant_id = item["data"].get("grant_id") if kind == "ai_oauth_refresh" else item["data"].get("oauth_grant_id")
            if not grant_id:
                return
            grant = _locked_grant(conn, grant_id)
            if grant["data"]["client_id"] == params.get("client_id"):
                _revoke_grant(conn, grant, "client_revoked")
    except ApiError as error:
        if error.status not in {403, 404}:
            raise


@router.post("/revoke")
async def revoke(request: Request):
    try:
        settings()
        params = await _form(request)
        if request.headers.get("authorization"):
            raise OAuthFailure("invalid_client", "Use the registered public client_id without a secret.", 401)
        def verify_client():
            with auth_transaction() as conn:
                _client(conn, params.get("client_id"))
        await run_in_threadpool(verify_client)
        await run_in_threadpool(_throttle, request, "revoke", params.get("client_id", ""))
        await run_in_threadpool(_revoke_token, params)
        return JSONResponse({}, headers=SAFE_HEADERS)
    except OAuthFailure as failure:
        return _error(failure)
