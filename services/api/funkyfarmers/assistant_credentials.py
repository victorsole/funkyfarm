"""Human-issued, farm-limited assistant keys. Plaintext is returned only once."""

from datetime import datetime, timedelta, timezone
import secrets
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from .assistant_tools import _grant, _human_browser
from .db import fetch_record, insert_record, list_records, transaction, update_record
from .models import ApiError, StrictModel
from .security import Session, require_roles, require_session, token_hash

router = APIRouter(prefix="/assistant/credentials", tags=["assistant access"])


class CredentialCreate(StrictModel):
    name: str = Field(min_length=1, max_length=120)
    farm_ids: list[UUID] = Field(min_length=1, max_length=100)
    permissions: list[Literal["read", "propose"]] = Field(default_factory=lambda: ["read"], min_length=1, max_length=2)
    expires_in_days: int = Field(default=7, ge=1, le=30, strict=True)


class CredentialRevoke(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)


def _owner(request, session):
    _human_browser(request)
    require_roles(session, "owner")
    if getattr(session, "credential_scope", "interactive") != "interactive":
        raise ApiError(403, "interactive_session_required", "Manage assistant access from your signed-in application.")


def _public(record):
    data = record["data"]
    return {"id": record["id"], "revision": record["revision"], "data": {key: data.get(key) for key in
            ("name", "created_by", "farm_ids", "permissions", "expires_at", "revoked_at")}}


@router.get("")
def credentials(request: Request, session: Session = Depends(require_session)):
    _owner(request, session)
    with transaction(session) as conn:
        page = list_records(conn, "ai_credentials", 50)
        return {**page, "items": [_public(record) for record in page["items"]]}


@router.post("", status_code=201)
def create_credential(body: CredentialCreate, request: Request, session: Session = Depends(require_session)):
    _owner(request, session)
    name = body.name.strip()
    if not name:
        raise ApiError(422, "invalid_client_name", "Name the assistant client receiving this access.")
    farms = sorted(set(map(str, body.farm_ids)))
    permissions = sorted(set(body.permissions) | {"read"})
    token = "ffa_" + secrets.token_urlsafe(64)
    with transaction(session) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:assistant-credentials",))
        for farm_id in farms:
            fetch_record(conn, "farms", farm_id)
        active = conn.execute("SELECT count(*) AS n FROM records WHERE kind='ai_credentials' AND deleted_at IS NULL AND data->>'revoked_at' IS NULL AND (data->>'expires_at')::timestamptz>now()").fetchone()["n"]
        if active >= 20:
            raise ApiError(429, "assistant_credentials_limit", "Revoke an unused assistant key before creating another.")
        record = insert_record(conn, "ai_credentials", {
            "token_hash": token_hash(token), "created_by": session.user_id, "farm_ids": farms,
            "permissions": permissions, "grant_fingerprint": _grant(conn),
            "expires_at": (datetime.now(timezone.utc) + timedelta(days=body.expires_in_days)).isoformat(),
            "revoked_at": None, "name": name,
        })
    return {"credential": _public(record), "token": token, "mcp_path": "/api/v1/assistant/mcp",
            "notice": "Copy this key once into your trusted assistant client. It is not saved in browser storage. Never paste it into a chat, farm record or document. It cannot approve, issue, send or file anything."}


@router.post("/{credential_id}/revoke")
def revoke_credential(credential_id: UUID, body: CredentialRevoke, request: Request, session: Session = Depends(require_session)):
    _owner(request, session)
    with transaction(session) as conn:
        record = fetch_record(conn, "ai_credentials", str(credential_id))
        data = {**record["data"], "revoked_at": record["data"].get("revoked_at") or datetime.now(timezone.utc).isoformat()}
        return _public(update_record(conn, "ai_credentials", record["id"], body.expected_revision, data))
