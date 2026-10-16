"""Opaque, revocable sessions; web mutations additionally require CSRF proof."""

from dataclasses import dataclass
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import os
import re
import secrets
from threading import BoundedSemaphore
from uuid import UUID, uuid4

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from fastapi import APIRouter, Depends, Request, Response
from psycopg.errors import UniqueViolation

from .db import auth_transaction
from .models import ApiError, Login, Registration

router = APIRouter(prefix="/auth", tags=["authentication"])
password_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
_dummy_hash = password_hasher.hash("invalid-login-dummy-password")
COOKIE_NAME = "funkyfarmers_session"
_password_slots = BoundedSemaphore(2)


@contextmanager
def _password_work():
    # Argon2 deliberately uses memory. Bound concurrent work on the small host.
    if not _password_slots.acquire(timeout=0.2):
        raise ApiError(429, "sign_in_busy", "Sign-in is busy. Wait a moment and try again.")
    try:
        yield
    finally:
        _password_slots.release()


@dataclass(frozen=True)
class Session:
    user_id: str
    workspace_id: str
    role: str
    csrf_token: str
    credential_scope: str = "interactive"
    credential_farm_ids: tuple[str, ...] | None = None
    credential_permissions: tuple[str, ...] | None = None
    credential_id: str | None = None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def require_roles(session: Session, *roles: str):
    if session.role not in roles:
        raise ApiError(403, "role_required", "Your workspace role cannot perform this action.")


def _email(value: str):
    value = value.strip().lower()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
        raise ApiError(422, "invalid_email", "Enter a valid email address.")
    return value


def _same_origin(request: Request):
    origin = request.headers.get("origin")
    allowed = {item.rstrip("/") for item in os.environ.get(
        "FUNKYFARMERS_ALLOWED_ORIGINS", "http://localhost:5189,http://127.0.0.1:5189,http://localhost:8139,http://127.0.0.1:8139"
    ).split(",")}
    if origin and origin.rstrip("/") not in allowed:
        raise ApiError(403, "origin_denied", "This browser origin is not permitted.")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise ApiError(403, "origin_denied", "Cross-site browser mutations are not permitted.")


def _credential(request: Request):
    header = request.headers.get("authorization")
    if header:
        if not header.startswith("Bearer ") or not 20 <= len(header[7:]) <= 200:
            raise ApiError(401, "authentication_required", "Sign in to continue.")
        return header[7:], True
    cookie = request.cookies.get(COOKIE_NAME)
    if not cookie or not 20 <= len(cookie) <= 200:
        raise ApiError(401, "authentication_required", "Sign in to continue.")
    return cookie, False


def _resolve(request: Request):
    token, bearer = _credential(request)
    workspace = request.headers.get("x-workspace-id")
    try:
        workspace_uuid = UUID(workspace) if workspace else None
    except ValueError:
        raise ApiError(403, "workspace_access_denied", "This workspace is not available.") from None
    with auth_transaction() as conn:
        if bearer and token.startswith("ffa_"):
            row = conn.execute("SELECT * FROM resolve_assistant_token(%s)", (token_hash(token),)).fetchone()
            if row and workspace_uuid and str(row["workspace_id"]) != str(workspace_uuid):
                row = None
        else:
            row = conn.execute("SELECT * FROM resolve_session(%s,%s)", (token_hash(token), workspace_uuid)).fetchone()
    if not row:
        raise ApiError(401, "authentication_required", "Your session expired or this workspace is unavailable. Sign in again.")
    request.state.session_token_hash = token_hash(token)
    request.state.session_row = row
    if bearer and token.startswith("ffa_"):
        path = request.url.path.rstrip("/")
        permitted = ((request.method == "GET" and path == "/api/v1/assistant/tools")
                     or (request.method == "POST" and path.startswith("/api/v1/assistant/execute/"))
                     or (request.method in {"GET", "POST"} and path == "/api/v1/assistant/mcp"))
        if not permitted:
            raise ApiError(403, "assistant_scope_denied", "This assistant key can use only its permitted tools, not account or approval actions.")
        session = Session(str(row["user_id"]), str(row["workspace_id"]), row["role"], "",
                          "assistant", tuple(str(value) for value in row["farm_ids"]),
                          tuple(row["permissions"]), str(row["credential_id"]))
    else:
        session = Session(str(row["user_id"]), str(row["workspace_id"]), row["role"], row["csrf_token"])
    if not bearer and request.method not in {"GET", "HEAD", "OPTIONS"}:
        _same_origin(request)
        csrf = request.headers.get("x-csrf-token", "")
        if not hmac.compare_digest(csrf, session.csrf_token):
            raise ApiError(403, "csrf_required", "Refresh your session before saving this change.")
    return session


def require_session(request: Request) -> Session:
    return _resolve(request)


def _session_response(row, token=None):
    result = {
        "user": {"id": str(row["user_id"]), "display_name": row["display_name"], "email": row["email"]},
        "workspace": {"id": str(row["workspace_id"]), "name": row["workspace_name"], "role": row["role"]},
        "csrf_token": row["csrf_token"],
    }
    if token:
        result["token"] = token
    return result


def _issue(conn, user_id, request, response):
    token, csrf = secrets.token_urlsafe(48), secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=7)
    conn.execute("SELECT create_session(%s,%s,%s,%s)", (user_id, token_hash(token), csrf, expires))
    row = conn.execute("SELECT * FROM resolve_session(%s,NULL)", (token_hash(token),)).fetchone()
    response.set_cookie(COOKIE_NAME, token, max_age=7 * 86400, httponly=True,
                        secure=os.environ.get("FUNKYFARMERS_COOKIE_SECURE", "false").lower() == "true",
                        samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return _session_response(row, token)


def _throttle(conn, request, email):
    # The database persists a bounded 15-minute budget across processes and restarts.
    client = request.client.host if request.client else "unknown"
    bucket = token_hash(f"{client}:{email}")
    allowed = conn.execute("SELECT authentication_attempt(%s) AS allowed", (bucket,)).fetchone()["allowed"]
    address_allowed = conn.execute("SELECT authentication_attempt(%s) AS allowed", ("address:" + token_hash(client),)).fetchone()["allowed"]
    if not allowed or not address_allowed:
        raise ApiError(429, "too_many_attempts", "Too many sign-in attempts. Try again in 15 minutes.")


@router.post("/register", status_code=201)
def register(body: Registration, request: Request, response: Response):
    _same_origin(request)
    email = _email(body.email)
    display_name = body.display_name.strip()
    if not display_name:
        raise ApiError(422, "invalid_name", "Enter your name.")
    # Reserve budget in its own committed transaction so later failures cannot erase it.
    with auth_transaction() as conn:
        _throttle(conn, request, email)
    with _password_work():
        hashed = password_hasher.hash(body.password)
    try:
        with auth_transaction() as conn:
            user_id = conn.execute("SELECT register_user(%s,%s,%s) AS id", (email, hashed, display_name)).fetchone()["id"]
            return _issue(conn, user_id, request, response)
    except UniqueViolation:
        raise ApiError(409, "registration_unavailable", "This email cannot be registered. Try signing in.") from None


@router.post("/login")
def login(body: Login, request: Request, response: Response):
    _same_origin(request)
    email = _email(body.email)
    with auth_transaction() as conn:
        _throttle(conn, request, email)
    with auth_transaction() as conn:
        user = conn.execute("SELECT * FROM login_identity(%s)", (email,)).fetchone()
    try:
        with _password_work():
            password_hasher.verify(user["password_hash"] if user else _dummy_hash, body.password)
    except (VerificationError, InvalidHashError):
        raise ApiError(401, "invalid_credentials", "Email or password is incorrect.") from None
    if user is None:
        raise ApiError(401, "invalid_credentials", "Email or password is incorrect.")
    with auth_transaction() as conn:
        return _issue(conn, user["id"], request, response)


@router.get("/session")
def get_session(request: Request, response: Response, session: Session = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    return _session_response(request.state.session_row)


@router.post("/logout")
def logout(request: Request, response: Response, session: Session = Depends(require_session)):
    with auth_transaction() as conn:
        conn.execute("SELECT revoke_session(%s)", (request.state.session_token_hash,))
    response.delete_cookie(COOKIE_NAME, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"signed_out": True}
