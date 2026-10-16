"""Reviewed OIDC providers, browser-bound PKCE, explicit linking, and native handoff.

No discovery, userinfo, provider refresh-token storage, or email-based account linking.
Only operator-configured endpoints are contacted; ID-token URLs never select a key.
"""

import base64
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import re
import secrets
import socket
import ssl
import threading
import time
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import UUID

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import RedirectResponse
from psycopg.types.json import Jsonb
from pydantic import Field

from .db import auth_transaction, json_safe
from .models import ApiError, StrictModel
from .security import (COOKIE_NAME, Session, _password_work, _same_origin,
                       _session_response, _throttle, password_hasher,
                       require_session, token_hash)

router = APIRouter(prefix="/auth/sso", tags=["single sign-on"])
FLOW_COOKIE = "funkyfarm_sso_browser"
FLOW_PATH = "/api/v1/auth/sso"
_NATIVE_URI = "funkyfarmapp://auth/sso"
_NETWORK = threading.BoundedSemaphore(4)
_DNS_SLOTS = threading.BoundedSemaphore(2)
_DNS = ThreadPoolExecutor(max_workers=2, thread_name_prefix="oidc-dns")


class Start(StrictModel):
    mode: Literal["login", "link"] = "login"
    return_to: str = Field(default="/app", max_length=1024)


class NativeExchange(StrictModel):
    code: str = Field(min_length=32, max_length=128)
    code_verifier: str = Field(min_length=43, max_length=128)
    redirect_uri: str = Field(min_length=1, max_length=1024)


class Unlink(StrictModel):
    pass


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))


def _local_enabled():
    return os.environ.get("FUNKYFARM_SSO_ALLOW_LOCAL_HTTP", "").lower() == "true"


def _url(value, *, local=False, origin=False):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        raise ValueError("Invalid URL")
    parsed = urlsplit(value)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if (parsed.scheme != "https" and not (local and _local_enabled() and loopback and parsed.scheme == "http")):
        raise ValueError("HTTPS required")
    if (not parsed.hostname or parsed.username or parsed.password or parsed.fragment or parsed.query
            or (origin and parsed.path not in {"", "/"}) or not 1 <= (parsed.port or 443) <= 65535):
        raise ValueError("Invalid URL components")
    if loopback and not (local and _local_enabled()):
        raise ValueError("Local providers require explicit development opt-in")
    return parsed


def _origins():
    public = os.environ.get("FUNKYFARM_PUBLIC_URL", "").rstrip("/")
    web = os.environ.get("FUNKYFARM_WEB_URL", public).rstrip("/")
    _url(public, local=True, origin=True)
    _url(web, local=True, origin=True)
    # Cookies must reach the browser's API origin; distinct origins are allowed
    # only on the same site, with the normal API allowed-origins/CSRF policy.
    if (urlsplit(public).scheme != urlsplit(web).scheme
            or urlsplit(public).hostname != urlsplit(web).hostname):
        raise ValueError("Public and web must share a cookie site")
    return public, web


def _native_uris():
    raw = os.environ.get("FUNKYFARM_SSO_NATIVE_REDIRECT_URIS", "[]")
    extras = _json(raw)
    if not isinstance(extras, list) or len(extras) > 8:
        raise ValueError("Invalid native callback list")
    for entry in extras:
        _url(entry)
    return [_NATIVE_URI, *dict.fromkeys(extras)]


def _providers():
    raw = os.environ.get("FUNKYFARM_SSO_PROVIDERS", "[]")
    try:
        if len(raw.encode()) > 32768:
            raise ValueError("Provider configuration too large")
        entries = _json(raw)
        if not isinstance(entries, list) or len(entries) > 10:
            raise ValueError("Invalid providers")
        google_entries = [entry for entry in entries if isinstance(entry, dict) and entry.get("id") == "google"]
        if len(google_entries) > 1:
            raise ValueError("Duplicate Google provider")
        google_id = os.environ.get("FUNKYFARM_GOOGLE_CLIENT_ID", "")
        google_secret = os.environ.get("FUNKYFARM_GOOGLE_CLIENT_SECRET", "")
        if google_id and google_secret:
            preset = {
                "id": "google", "name": "Google", "reviewed": True,
                "issuer": "https://accounts.google.com",
                "authorization_endpoint": "https://accounts.google.com/o/oauth2/v2/auth",
                "token_endpoint": "https://oauth2.googleapis.com/token",
                "jwks_uri": "https://www.googleapis.com/oauth2/v3/certs",
                "client_id": google_id, "client_secret": google_secret,
                "token_endpoint_auth_method": "client_secret_post",
            }
            if google_entries:
                explicit = google_entries[0]
                if (any(explicit.get(field) != preset[field] for field in (
                        "issuer", "authorization_endpoint", "token_endpoint", "jwks_uri", "client_id", "client_secret"))
                        or explicit.get("token_endpoint_auth_method", "client_secret_post") != "client_secret_post"):
                    raise ValueError("Conflicting Google configuration")
                # Keep the explicit entry's reviewed settings and display name;
                # the preset must never introduce a second provider with its ID.
            else:
                if len(entries) >= 10:
                    raise ValueError("Too many providers")
                entries = [*entries, preset]
        result = {}
        for entry in entries:
            if not isinstance(entry, dict):
                raise ValueError("Invalid provider")
            # Missing credentials means unavailable, never a pretend enabled button.
            if not entry.get("client_id") or not entry.get("client_secret"):
                continue
            identifier = entry.get("id", "")
            if not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", identifier) or identifier in result:
                raise ValueError("Invalid provider ID")
            if entry.get("reviewed") is not True:
                raise ValueError("Provider endpoints must be explicitly reviewed")
            if entry.get("token_endpoint_auth_method", "client_secret_post") not in {"client_secret_post", "client_secret_basic"}:
                raise ValueError("Unsupported token client authentication")
            local = entry.get("allow_local_development") is True and _local_enabled()
            for field in ("issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"):
                _url(entry.get(field), local=local)
            if not all(isinstance(entry.get(field), str) and 1 <= len(entry[field]) <= 2048
                       for field in ("client_id", "client_secret")):
                raise ValueError("Invalid credentials")
            name = entry.get("name", identifier)
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
                raise ValueError("Invalid provider label")
            # Generic providers use reviewed exact endpoints, never discovery or
            # tenant/issuer templates. Google may use the fixed preset above.
            result[identifier] = {**entry, "name": name.strip(), "allow_local_development": local}
        if result:
            _origins()
        return result
    except (ValueError, TypeError, RecursionError):
        raise ApiError(503, "sso_configuration_error", "Single sign-on is not configured correctly. Use password sign-in.") from None


def _provider(identifier):
    provider = _providers().get(identifier)
    if provider is None:
        raise ApiError(404, "sso_provider_unavailable", "This sign-in provider is not configured.")
    return provider


def _fingerprint(provider):
    return token_hash(json.dumps(provider, sort_keys=True, separators=(",", ":")))


def _return_path(value):
    parsed = urlsplit(value)
    if (not value.startswith("/app") or (parsed.path != "/app" and not parsed.path.startswith("/app/"))
            or value.startswith("//") or parsed.scheme or parsed.netloc or parsed.fragment
            or re.search(r"[\\\x00-\x20\x7f]", value) or len(value) > 1024):
        raise ApiError(422, "invalid_return_path", "Return to a page within this app.")
    if any(key.lower() in {"token", "access_token", "id_token", "code", "state"} for key, _ in parse_qsl(parsed.query)):
        raise ApiError(422, "invalid_return_path", "The return page must not contain credentials.")
    return value


def _b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise ValueError("Invalid base64url")
    decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _b64(decoded) != value:
        raise ValueError("Noncanonical base64url")
    return decoded


def _dns(host, port):
    if not _DNS_SLOTS.acquire(timeout=0.05):
        raise ValueError("DNS busy")
    try:
        future = _DNS.submit(socket.getaddrinfo, host, port, 0, socket.SOCK_STREAM)
    except BaseException:
        _DNS_SLOTS.release()
        raise
    future.add_done_callback(lambda _: _DNS_SLOTS.release())
    return future.result(timeout=2)


def _http_json(url, provider, body=None, *, authorization=None):
    """Two-second DNS budget, pinned validated IP, TLS SNI, no proxy/redirects."""
    connection = response = timer = connection_socket = None
    if not _NETWORK.acquire(timeout=0.05):
        raise ApiError(503, "sso_provider_unavailable", "The sign-in provider is busy. Try again.")
    try:
        endpoint = _url(url, local=provider["allow_local_development"])
        port = endpoint.port or (443 if endpoint.scheme == "https" else 80)
        deadline = time.monotonic() + 8
        addresses = {row[4][0] for row in _dns(endpoint.hostname, port)}
        development = provider["allow_local_development"] and endpoint.hostname in {"localhost", "127.0.0.1", "::1"}
        if not addresses or any(not (ipaddress.ip_address(ip).is_loopback if development else ipaddress.ip_address(ip).is_global)
                                for ip in addresses):
            raise ValueError("Provider address not permitted")
        connection_socket = socket.create_connection((sorted(addresses)[0], port), timeout=min(3, deadline - time.monotonic()))

        def expire():
            try:
                connection_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection_socket.close()

        timer = threading.Timer(max(0.01, deadline - time.monotonic()), expire)
        timer.daemon = True
        timer.start()
        if endpoint.scheme == "https":
            connection_socket.settimeout(max(0.01, deadline - time.monotonic()))
            connection_socket = ssl.create_default_context().wrap_socket(connection_socket, server_hostname=endpoint.hostname)
        connection = http.client.HTTPConnection(endpoint.hostname, port, timeout=max(0.01, deadline - time.monotonic()))
        connection.sock = connection_socket
        payload = urlencode(body).encode() if body is not None else None
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "Accept-Encoding": "identity"}
        if authorization:
            headers["Authorization"] = authorization
        connection.request("POST" if body is not None else "GET", endpoint.path or "/", body=payload, headers=headers)
        response = connection.getresponse()
        limit = 65536 if body is not None else 131072
        if (response.status != 200 or response.getheader("Content-Encoding", "identity") != "identity"
                or response.getheader("Content-Type", "").split(";", 1)[0].strip() not in {"application/json", "application/jwk-set+json"}):
            raise ValueError("Invalid provider response")
        length = response.getheader("Content-Length")
        if length and (not length.isdecimal() or int(length) > limit):
            raise ValueError("Provider response too large")
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                raise ValueError("Provider timeout")
            chunk = response.read1(min(8192, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise ValueError("Provider response too large")
        result = _json(b"".join(chunks))
        if not isinstance(result, dict):
            raise ValueError("Provider response not an object")
        return result
    except (OSError, ValueError, TypeError, RecursionError, FutureTimeout, http.client.HTTPException):
        raise ApiError(503, "sso_provider_unavailable", "The sign-in provider could not be verified. Try again or use password sign-in.") from None
    finally:
        if timer:
            timer.cancel()
        if response:
            response.close()
        if connection:
            connection.close()
        if connection_socket:
            connection_socket.close()
        _NETWORK.release()


def _verify_identity(provider, tokens, flow, code):
    try:
        token = tokens.get("id_token")
        if not isinstance(token, str) or not 32 <= len(token) <= 16384:
            raise ValueError("Missing ID token")
        parts = token.split(".")
        if len(parts) != 3:
            raise ValueError("Invalid token")
        header, claims = _json(_unb64(parts[0])), _json(_unb64(parts[1]))
        if (not isinstance(header, dict) or not isinstance(claims, dict) or header.get("alg") != "RS256"
                or any(field in header for field in ("crit", "b64", "jku", "x5u"))
                or not isinstance(header.get("kid"), str) or not 1 <= len(header["kid"]) <= 200):
            raise ValueError("Unsupported signed token")
        jwks = _http_json(provider["jwks_uri"], provider)
        keys = jwks.get("keys")
        if not isinstance(keys, list) or not 1 <= len(keys) <= 32:
            raise ValueError("Invalid keys")
        matching = [key for key in keys if isinstance(key, dict) and key.get("kid") == header["kid"]]
        if len(matching) != 1:
            raise ValueError("Ambiguous signing key")
        key = matching[0]
        if (key.get("kty") != "RSA" or key.get("use", "sig") != "sig" or key.get("alg", "RS256") != "RS256"
                or ("key_ops" in key and key["key_ops"] != ["verify"])):
            raise ValueError("Invalid signing key")
        modulus, exponent = int.from_bytes(_unb64(key.get("n")), "big"), int.from_bytes(_unb64(key.get("e")), "big")
        if not 2048 <= modulus.bit_length() <= 8192 or not 3 <= exponent <= 2**32 - 1 or exponent % 2 == 0:
            raise ValueError("Invalid RSA key")
        rsa.RSAPublicNumbers(exponent, modulus).public_key().verify(
            _unb64(parts[2]), (parts[0] + "." + parts[1]).encode(), padding.PKCS1v15(), hashes.SHA256())
        now = int(time.time())
        if (claims.get("iss") != provider["issuer"] or not isinstance(claims.get("sub"), str)
                or not 1 <= len(claims["sub"]) <= 255 or re.search(r"[\x00-\x1f\x7f]", claims["sub"])):
            raise ValueError("Issuer or subject invalid")
        claims["sub"].encode("utf-8")
        audience = claims.get("aud")
        audiences = [audience] if isinstance(audience, str) else audience
        if (not isinstance(audiences, list) or not 1 <= len(audiences) <= 10
                or not all(isinstance(value, str) for value in audiences) or provider["client_id"] not in audiences
                or ((len(audiences) > 1 or "azp" in claims) and claims.get("azp") != provider["client_id"])):
            raise ValueError("Audience invalid")
        if (type(claims.get("exp")) is not int or type(claims.get("iat")) is not int
                or claims["exp"] <= now or claims["iat"] > now + 60 or claims["iat"] < now - 7200
                or claims["exp"] <= claims["iat"] or claims["exp"] > now + 86400
                or ("nbf" in claims and (type(claims["nbf"]) is not int or claims["nbf"] > now + 60))):
            raise ValueError("Token times invalid")
        nonce = claims.get("nonce")
        if not isinstance(nonce, str) or not hmac.compare_digest(token_hash(nonce), flow["nonce_hash"]):
            raise ValueError("Nonce invalid")
        for field, value in (("c_hash", code), ("at_hash", tokens.get("access_token"))):
            if field in claims:
                if not isinstance(value, str) or not isinstance(claims[field], str) or not hmac.compare_digest(
                        _b64(hashlib.sha256(value.encode()).digest()[:16]), claims[field]):
                    raise ValueError("Token hash invalid")
        email = claims.get("email")
        email = email.strip().lower() if isinstance(email, str) and len(email) <= 254 else None
        if email and (not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or re.search(r"[\x00-\x1f\x7f]", email)):
            email = None
        if email:
            email.encode("utf-8")
        verified_email = email if claims.get("email_verified") is True else None
        name = claims.get("name")
        name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:120] if isinstance(name, str) else ""
        name.encode("utf-8")
        profile = {"email": email, "email_verified": bool(verified_email), "name": name}
        return claims["sub"], verified_email, name or "Farm owner", profile
    except ApiError:
        raise
    except (ValueError, TypeError, KeyError, UnicodeError, RecursionError, InvalidSignature):
        raise ApiError(401, "invalid_identity", "The identity token could not be verified.") from None


def _human(request, session):
    if session.credential_scope != "interactive" or request.headers.get("authorization") or not request.cookies.get(COOKIE_NAME):
        raise ApiError(403, "interactive_session_required", "Use a signed-in browser to manage sign-in methods.")


def _create_flow(request, response, identifier, provider, mode, return_to, *, native=None):
    try:
        public, _ = _origins()
    except ValueError:
        raise ApiError(503, "sso_configuration_error", "The public sign-in address is not configured.") from None
    with auth_transaction() as conn:
        _throttle(conn, request, "sso:" + identifier)
    state, browser, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(4))
    expires = datetime.now(timezone.utc) + timedelta(minutes=10)
    flow = {"provider_id": identifier, "fingerprint": _fingerprint(provider), "mode": mode,
            "return_to": return_to, "verifier": verifier, "nonce_hash": token_hash(nonce),
            "callback": public + FLOW_PATH + "/" + identifier + "/callback", "native": native}
    if mode == "link":
        session = require_session(request)
        _human(request, session)
        flow.update(user_id=session.user_id, session_hash=request.state.session_token_hash)
    with auth_transaction() as conn:
        conn.execute("SELECT sso_create_transaction(%s,%s,%s,%s)",
                     (token_hash(state), token_hash(browser), Jsonb(flow), expires))
    response.set_cookie(FLOW_COOKIE, browser, max_age=600, httponly=True, secure=public.startswith("https://"),
                        samesite="lax", path=FLOW_PATH)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    parameters = {"response_type": "code", "client_id": provider["client_id"], "redirect_uri": flow["callback"],
                  "scope": "openid profile email", "state": state, "nonce": nonce,
                  "code_challenge": _b64(hashlib.sha256(verifier.encode()).digest()), "code_challenge_method": "S256",
                  "prompt": "select_account"}
    return provider["authorization_endpoint"] + "?" + urlencode(parameters), expires


def _result(flow, status, error=None):
    if flow and flow.get("native"):
        native = flow["native"]
        params = {"state": native["state"], "error": error or ("access_denied" if status == "cancelled" else status)}
        target = native["redirect_uri"] + "?" + urlencode(params)
    else:
        try:
            _, web = _origins()
        except ValueError:
            raise ApiError(503, "sso_configuration_error", "The public sign-in address is not configured.") from None
        path = flow["return_to"] if flow else "/app"
        parsed = urlsplit(web + path)
        params = [(key, value) for key, value in parse_qsl(parsed.query) if key not in {"sso", "sso_error"}]
        params.append(("sso", status))
        if error:
            params.append(("sso_error", error))
        target = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(params), ""))
    response = RedirectResponse(target, status_code=303, headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"})
    response.delete_cookie(FLOW_COOKIE, path=FLOW_PATH)
    return response


def _issue_session(conn, user_id, response):
    token, csrf = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
    conn.execute("SELECT create_session(%s,%s,%s,%s)",
                 (user_id, token_hash(token), csrf, datetime.now(timezone.utc) + timedelta(days=7)))
    row = conn.execute("SELECT * FROM resolve_session(%s,NULL)", (token_hash(token),)).fetchone()
    public, _ = _origins()
    response.set_cookie(COOKIE_NAME, token, max_age=604800, httponly=True, secure=public.startswith("https://"), samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return _session_response(row, token)


@router.get("/providers")
def providers(response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        native = _native_uris()
    except (ValueError, TypeError, RecursionError):
        raise ApiError(503, "sso_configuration_error", "Native sign-in callbacks are not configured correctly.") from None
    return {"providers": [{"id": identifier, "name": provider["name"],
                           "allow_local_development": provider["allow_local_development"],
                           "native_start_path": FLOW_PATH + "/" + identifier + "/native/start"}
                          for identifier, provider in _providers().items()], "native_redirect_uris": native}


@router.post("/{provider_id}/start")
def start(provider_id: str, body: Start, request: Request, response: Response):
    _same_origin(request)
    provider = _provider(provider_id)
    target, expires = _create_flow(request, response, provider_id, provider, body.mode, _return_path(body.return_to))
    return {"redirect_url": target, "expires_at": expires.isoformat(), "allow_local_development": provider["allow_local_development"]}


@router.get("/{provider_id}/native/start")
def native_start(provider_id: str, request: Request):
    query = request.query_params
    try:
        allowed = _native_uris()
    except (ValueError, TypeError):
        raise ApiError(503, "sso_configuration_error", "Native sign-in is not configured.") from None
    if (any(len(query.getlist(key)) != 1 for key in ("redirect_uri", "state", "code_challenge", "code_challenge_method"))
            or query.get("redirect_uri") not in allowed or query.get("code_challenge_method") != "S256"
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", query.get("code_challenge", ""))
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", query.get("state", ""))):
        raise ApiError(422, "invalid_native_request", "Use the app's configured callback, state and S256 challenge.")
    provider = _provider(provider_id)
    response = RedirectResponse("/", status_code=303)
    target, _ = _create_flow(request, response, provider_id, provider, "login", "/app",
                            native={key: query[key] for key in ("redirect_uri", "state", "code_challenge")})
    response.headers["location"] = target
    return response


@router.get("/{provider_id}/callback")
def callback(provider_id: str, request: Request):
    query = request.query_params
    state, browser = query.get("state", ""), request.cookies.get(FLOW_COOKIE, "")
    if (len(query.getlist("state")) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]{43}", state)
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", browser)):
        return _result(None, "failed", "invalid_state")
    with auth_transaction() as conn:
        flow = conn.execute("SELECT sso_consume_transaction(%s,%s) AS data", (token_hash(state), token_hash(browser))).fetchone()["data"]
    if not flow or flow.get("provider_id") != provider_id:
        return _result(None, "failed", "invalid_state")
    if query.get("error") == "access_denied":
        return _result(flow, "cancelled")
    code = query.get("code", "")
    if len(query.getlist("code")) != 1 or not 1 <= len(code) <= 4096 or query.get("error"):
        return _result(flow, "failed", "invalid_response")
    try:
        provider = _provider(provider_id)
        if not hmac.compare_digest(flow["fingerprint"], _fingerprint(provider)):
            return _result(flow, "failed", "provider_unavailable")
        if flow["mode"] == "link":
            session = require_session(request)
            _human(request, session)
            if (session.user_id != flow["user_id"] or not hmac.compare_digest(request.state.session_token_hash, flow["session_hash"])):
                return _result(flow, "failed", "session_changed")
        token_body = {"grant_type": "authorization_code", "code": code, "redirect_uri": flow["callback"],
                      "client_id": provider["client_id"], "code_verifier": flow["verifier"]}
        authorization = None
        if provider.get("token_endpoint_auth_method", "client_secret_post") == "client_secret_basic":
            # OAuth client credentials are form-encoded before HTTP Basic encoding.
            from urllib.parse import quote_plus
            credentials = quote_plus(provider["client_id"]) + ":" + quote_plus(provider["client_secret"])
            authorization = "Basic " + base64.b64encode(credentials.encode()).decode("ascii")
        else:
            token_body["client_secret"] = provider["client_secret"]
        tokens = _http_json(provider["token_endpoint"], provider, token_body, authorization=authorization)
        subject, email, name, profile = _verify_identity(provider, tokens, flow, code)
        # A random, never-returned password hash disables password guessing on newly
        # provisioned SSO users. Existing accounts retain their original method.
        with _password_work():
            random_hash = password_hasher.hash(secrets.token_urlsafe(64))
        with auth_transaction() as conn:
            result = conn.execute("SELECT sso_complete(%s,%s,%s,%s,%s,%s,%s,%s,%s) AS data",
                                  (provider["issuer"], subject, provider_id, email, name, random_hash, Jsonb(profile),
                                   flow.get("user_id"), flow.get("session_hash"))).fetchone()["data"]
            if result.get("error"):
                return _result(flow, "failed", result["error"])
            if flow["mode"] == "link":
                return _result(flow, "linked")
            if flow.get("native"):
                native_code = secrets.token_urlsafe(32)
                native = flow["native"]
                conn.execute("SELECT sso_create_handoff(%s,%s,%s,%s,%s)",
                             (token_hash(native_code), result["user_id"], native["redirect_uri"], native["code_challenge"], token_hash(browser)))
                response = _result(flow, "signed_in")
                response.headers["location"] = native["redirect_uri"] + "?" + urlencode({"code": native_code, "state": native["state"]})
                return response
            response = _result(flow, "signed_in")
            _issue_session(conn, result["user_id"], response)
            return response
    except ApiError as error:
        public_error = "invalid_identity" if error.code == "invalid_identity" else (
            "session_changed" if error.status in {401, 403} else "provider_unavailable")
        return _result(flow, "failed", public_error)


@router.post("/native/token")
def native_token(body: NativeExchange, request: Request, response: Response):
    _same_origin(request)
    if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", body.code_verifier):
        raise ApiError(400, "invalid_grant", "This sign-in handoff is invalid or expired. Start again.")
    challenge = _b64(hashlib.sha256(body.code_verifier.encode()).digest())
    with auth_transaction() as conn:
        _throttle(conn, request, "sso-native-exchange")
    with auth_transaction() as conn:
        user_id = conn.execute("SELECT sso_consume_handoff(%s,%s,%s) AS id",
                               (token_hash(body.code), body.redirect_uri, challenge)).fetchone()["id"]
        if user_id is None:
            raise ApiError(400, "invalid_grant", "This sign-in handoff is invalid or expired. Start again.")
        return _issue_session(conn, user_id, response)


@router.get("/accounts")
def accounts(request: Request, response: Response, session: Session = Depends(require_session)):
    _human(request, session)
    with auth_transaction() as conn:
        result = conn.execute("SELECT sso_accounts(%s) AS data", (request.state.session_token_hash,)).fetchone()["data"]
    if result is None:
        raise ApiError(401, "authentication_required", "Sign in again to manage sign-in methods.")
    configured = _providers()
    for entry in result["items"]:
        entry["provider_name"] = configured.get(entry["provider_id"], {}).get("name", entry["provider_id"])
    response.headers["Cache-Control"] = "no-store"
    return json_safe(result)


@router.post("/accounts/{identity_id}/unlink")
def unlink(identity_id: UUID, body: Unlink, request: Request, response: Response,
           session: Session = Depends(require_session)):
    _human(request, session)
    with auth_transaction() as conn:
        result = conn.execute("SELECT sso_unlink(%s,%s) AS data", (request.state.session_token_hash, identity_id)).fetchone()["data"]
    if result.get("error"):
        raise ApiError(409 if result["error"] == "last_signin_method" else 404, result["error"],
                       "Keep another usable sign-in method before removing this one." if result["error"] == "last_signin_method" else "This sign-in method is unavailable.")
    response.delete_cookie(COOKIE_NAME, path="/")
    response.headers["Cache-Control"] = "no-store"
    return result
