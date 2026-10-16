"""Sourced pack catalogue and explicitly requested official-page change review."""

from datetime import date, datetime, timezone
import hashlib
import http.client
import ipaddress
import socket
import ssl
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from .db import transaction, fetch_record, insert_record, update_record, list_records
from .models import ApiError, StrictModel
from .security import require_session, Session
from .reporting import get_pack, load_packs

router = APIRouter()
@router.get("/guidance")
def guidance(pack_id: str, session: Session = Depends(require_session)):
    pack = get_pack(pack_id)
    return {"pack_id": pack_id, "version": pack["version"], "capability": pack["capability"],
            "sources": pack["sources"], "limits": pack.get("limits", pack.get("limitations", [])), "checks": pack["checks"],
            "fields": pack["fields"], "effective_date": pack.get("effective_date"),
            "message": "Use the cited edition and review missing evidence. A prepared draft is not an authority decision."}


def fetch_official_source(url: str):
    """Pin a globally routable address; preserve hostname TLS verification; never redirect."""
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
        raise ApiError(400, "unsafe_source", "Official source checks require a public HTTPS address on port 443.")
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(addr).is_global or ipaddress.ip_address(addr).is_multicast
                                or ipaddress.ip_address(addr).is_reserved for addr in addresses):
            raise ApiError(400, "unsafe_source", "The official source must resolve only to public addresses.")
        address = sorted(addresses)[0]

        class PinnedConnection(http.client.HTTPSConnection):
            def connect(self):
                raw = socket.create_connection((address, 443), timeout=5)
                try:
                    self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
                except Exception:
                    raw.close()
                    raise

        connection = PinnedConnection(parsed.hostname, timeout=5, context=ssl.create_default_context())
        try:
            connection.request("GET", (parsed.path or "/") + ("?" + parsed.query if parsed.query else ""),
                               headers={"User-Agent": "FunkyFarmers-SourceReview/1", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status != 200:
                raise ApiError(422, "source_unavailable", "The official page did not return a usable document. Redirects are not followed.", {"status": response.status})
            digest, size, deadline = hashlib.sha256(), 0, time.monotonic() + 15
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > 4 * 1024 * 1024 or time.monotonic() > deadline:
                    raise ApiError(422, "source_too_large", "This source exceeded the bounded check size or duration.")
                digest.update(chunk)
            return {"sha256": digest.hexdigest(), "bytes": size, "content_type": response.getheader("Content-Type", "")}
        finally:
            connection.close()
    except (OSError, ValueError, http.client.HTTPException) as exc:
        raise ApiError(422, "source_unavailable", "The official page could not be checked safely.") from exc


class SourceCheck(StrictModel):
    pack_id: str
    source_url: str = Field(max_length=2048)


@router.post("/guidance/sources/check")
def check_source(body: SourceCheck, session: Session = Depends(require_session)):
    if session.role != "owner":
        raise ApiError(403, "owner_required", "Only the workspace owner can initiate an external source check.")
    pack = get_pack(body.pack_id)
    if body.source_url not in {s["url"] for s in pack["sources"]}:
        raise ApiError(400, "source_not_allowlisted", "Choose an exact official source URL from this installed pack.")
    result = fetch_official_source(body.source_url)
    with transaction(session) as conn:
        previous = conn.execute("SELECT data FROM records WHERE kind='source_observations' AND deleted_at IS NULL "
                                "AND data->>'pack_id'=%s AND data->>'source_url'=%s ORDER BY created_at DESC LIMIT 1",
                                (body.pack_id, body.source_url)).fetchone()
        changed = previous is not None and previous["data"].get("sha256") != result["sha256"]
        return insert_record(conn, "source_observations", {**body.model_dump(), **result,
            "pack_version": pack["version"], "checked_at": datetime.now(timezone.utc).isoformat(),
            "changed": changed, "status": "review_required" if changed else "unchanged" if previous else "baseline",
            "meaning": "A changed source document is an observation, not a legal change or an automatic rule update."})


class ChangeReview(StrictModel):
    expected_revision: int = Field(ge=1)
    effective_date: date
    explanation: str = Field(min_length=10, max_length=4000)
    farm_ids: list[str] = Field(max_length=200)
    report_ids: list[str] = Field(default_factory=list, max_length=200)
    required_action: str = Field(min_length=5, max_length=2000)


@router.get("/guidance/sources/observations")
def source_observations(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return list_records(conn, "source_observations", limit, offset)


@router.post("/guidance/changes/{observation_id}/review")
def review_change(observation_id: str, body: ChangeReview, session: Session = Depends(require_session)):
    if session.role not in {"owner", "adviser"}:
        raise ApiError(403, "reviewer_required", "A workspace owner or delegated adviser must review source changes.")
    with transaction(session) as conn:
        observation = fetch_record(conn, "source_observations", observation_id)
        if observation["data"].get("status") != "review_required":
            raise ApiError(409, "change_not_pending", "This observation has no pending changed-source review.")
        pack = get_pack(observation["data"]["pack_id"])
        farms = [fetch_record(conn, "farms", farm_id) for farm_id in set(body.farm_ids)]
        for farm in farms:
            if (pack.get("country") and farm["data"].get("country") != pack["country"]) or (pack.get("region") and farm["data"].get("region") != pack["region"]):
                raise ApiError(422, "jurisdiction_mismatch", "Select farms in the reviewed pack's jurisdiction.")
        reports = [fetch_record(conn, "reports", report_id) for report_id in set(body.report_ids)]
        farm_ids = {f["id"] for f in farms}
        if any(r["data"].get("farm_id") not in farm_ids or r["data"].get("pack_id") != pack["id"] for r in reports):
            raise ApiError(422, "report_scope_mismatch", "Affected reports must belong to a selected farm and the reviewed pack.")
        data = {**observation["data"], "status": "reviewed", "review": {**body.model_dump(mode="json"), "reviewer_id": str(session.user_id), "reviewed_at": datetime.now(timezone.utc).isoformat()}}
        updated = update_record(conn, "source_observations", observation_id, body.expected_revision, data)
        notifications = [insert_record(conn, "notifications", {"type": "reviewed_source_change", "farm_id": farm["id"],
            "pack_id": pack["id"], "observation_id": observation_id, "effective_date": body.effective_date.isoformat(),
            "explanation": body.explanation, "required_action": body.required_action, "read": False,
            "affected_report_ids": [r["id"] for r in reports if r["data"].get("farm_id") == farm["id"]]}) for farm in farms]
        return {"observation": updated, "notifications": notifications, "rules_updated": False}


@router.get("/guidance/notifications")
def notifications(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return list_records(conn, "notifications", limit, offset)


from .obligations import router as obligations_router
router.include_router(obligations_router)
