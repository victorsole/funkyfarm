"""PostgreSQL-only persistence. Every request transaction binds a tenant scope."""

from contextlib import contextmanager
from datetime import date, datetime
from decimal import Decimal
import hashlib
import json
import os
from typing import Callable, TYPE_CHECKING
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .models import ApiError

if TYPE_CHECKING:
    from .security import Session


def json_safe(value):
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, (UUID, datetime, date)):
        return value.isoformat() if isinstance(value, (datetime, date)) else str(value)
    if isinstance(value, Decimal):
        return str(value)
    return value


def connect():
    url = os.environ.get("FUNKYFARM_DATABASE_URL", "")
    if not url.startswith(("postgresql://", "postgres://")):
        raise RuntimeError("FUNKYFARM_DATABASE_URL must be a PostgreSQL runtime connection URL")
    return psycopg.connect(url, row_factory=dict_row, connect_timeout=5)


def assert_runtime_role(conn):
    role = conn.execute(
        "SELECT r.rolsuper,r.rolbypassrls,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)=current_user AS owns_records "
        "FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE r.rolname=current_user AND n.nspname='funkyfarm' AND c.relname='records'"
    ).fetchone()
    if not role or role["rolsuper"] or role["rolbypassrls"] or role["owns_records"] or not role["relrowsecurity"] or not role["relforcerowsecurity"]:
        raise RuntimeError("Runtime must use a migrated nonowner PostgreSQL role without RLS bypass")


@contextmanager
def auth_transaction():
    with connect() as conn:
        assert_runtime_role(conn)
        conn.execute("SET LOCAL search_path TO funkyfarm,public")
        yield conn


@contextmanager
def transaction(session: "Session"):
    with connect() as conn:
        assert_runtime_role(conn)
        conn.execute("SET LOCAL search_path TO funkyfarm,public")
        conn.execute("SELECT set_config('app.user_id',%s,true),set_config('app.workspace_id',%s,true)",
                     (str(session.user_id), str(session.workspace_id)))
        if session.credential_scope == "assistant":
            conn.execute("SELECT set_config('app.assistant_farms',%s,true)",
                         (json.dumps(list(session.credential_farm_ids or ())),))
            conn.execute("SELECT set_config('app.assistant_credential_id',%s,true)",
                         (str(session.credential_id or ""),))
            conn.execute("SELECT set_config('app.assistant_can_propose',%s,true)",
                         ("true" if "propose" in (session.credential_permissions or ()) else "false",))
        if not conn.execute("SELECT funkyfarm.has_membership() AS allowed").fetchone()["allowed"]:
            raise ApiError(403, "workspace_access_denied", "Your workspace access is no longer available.")
        yield conn


def fetch_record(conn, kind: str, record_id: str):
    try:
        record_id = UUID(str(record_id))
    except (ValueError, TypeError):
        raise ApiError(404, "not_found", "This record was not found.") from None
    row = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at "
                       "FROM records WHERE kind=%s AND id=%s AND deleted_at IS NULL", (kind, record_id)).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "This record was not found in this workspace.")
    return json_safe(row)


def insert_record(conn, kind: str, data: dict):
    if kind in {"facts", "operations", "purchases", "sales"} and data.get("farm_id"):
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':reconciliation:'||%s,0))", (str(data["farm_id"]),))
    row = conn.execute(
        "INSERT INTO records (id,workspace_id,kind,data) VALUES (%s,current_setting('app.workspace_id')::uuid,%s,%s) "
        "RETURNING id,kind,workspace_id,revision,data,created_at,updated_at",
        (uuid4(), kind, Jsonb(data)),
    ).fetchone()
    return json_safe(row)


def update_record(conn, kind: str, record_id: str, expected_revision: int, data: dict):
    current = fetch_record(conn, kind, record_id)
    if kind in {"facts", "operations", "purchases", "sales"} and current["data"].get("farm_id"):
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':reconciliation:'||%s,0))", (str(current["data"]["farm_id"]),))
        current = fetch_record(conn, kind, record_id)
    if current["revision"] != expected_revision:
        raise ApiError(409, "revision_conflict", "This record changed. Review the saved version before trying again.",
                       {"current_revision": current["revision"], "record_id": current["id"]})
    row = conn.execute(
        "UPDATE records SET data=%s,revision=revision+1,updated_at=clock_timestamp() "
        "WHERE id=%s AND kind=%s AND revision=%s AND deleted_at IS NULL "
        "RETURNING id,kind,workspace_id,revision,data,created_at,updated_at",
        (Jsonb(data), UUID(current["id"]), kind, expected_revision),
    ).fetchone()
    if row is None:
        raise ApiError(409, "revision_conflict", "This record changed. Reload it before trying again.")
    return json_safe(row)


def list_records(conn, kind: str, limit: int = 50, offset: int = 0, farm_id: str | None = None):
    args: list = [kind]
    where = "kind=%s AND deleted_at IS NULL"
    if farm_id:
        where += " AND data->>'farm_id'=%s"
        args.append(str(farm_id))
    total = conn.execute(f"SELECT count(*) AS count FROM records WHERE {where}", args).fetchone()["count"]
    rows = conn.execute(f"SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
                        f"WHERE {where} ORDER BY updated_at DESC,id LIMIT %s OFFSET %s", [*args, limit, offset]).fetchall()
    return {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}


def idempotent(conn, key: str | None, scope: str, payload, operation: Callable[[], dict]):
    """Serialize retries within this workspace and return the first committed result."""
    if key is None:
        return operation()
    if not 1 <= len(key) <= 160 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise ApiError(400, "invalid_idempotency_key", "Use an idempotency key of 1 to 160 printable characters.")
    grant = conn.execute("SELECT membership_fingerprint() AS fingerprint").fetchone()["fingerprint"]
    if not grant:
        raise ApiError(403, "workspace_access_denied", "Your workspace access is no longer available.")
    # A newly accepted or narrowed grant must never recover an earlier grant's response.
    credential = conn.execute("SELECT current_setting('app.assistant_credential_id',true) AS id").fetchone()["id"]
    scope = f"{scope}:grant:{grant}:credential:{credential or 'interactive'}"
    digest = hashlib.sha256(json.dumps(json_safe(payload), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    context = conn.execute("SELECT current_setting('app.workspace_id') AS workspace,current_setting('app.user_id') AS actor").fetchone()
    lock = f"{context['workspace']}:{context['actor']}:{scope}:{key}"
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (lock,))
    old = conn.execute("SELECT request_hash,response FROM idempotency_keys WHERE scope=%s AND key=%s", (scope, key)).fetchone()
    if old:
        if old["request_hash"] != digest:
            raise ApiError(409, "idempotency_conflict", "This retry key was already used for different input.")
        return old["response"]
    response = operation()
    conn.execute("INSERT INTO idempotency_keys(workspace_id,scope,key,request_hash,response) "
                 "VALUES(current_setting('app.workspace_id')::uuid,%s,%s,%s,%s)", (scope, key, digest, Jsonb(json_safe(response))))
    return response
