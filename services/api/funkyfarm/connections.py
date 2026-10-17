"""Honest connection capabilities and human-approved manual authority handoffs.

No government write transport is enabled. A prepared handoff is not a submission.
"""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from .connectors import read_parcels
from .connectors import nebih
from .connectors.vault import decrypt_credentials, encrypt_credentials
from .db import fetch_record, idempotent, insert_record, list_records, transaction, update_record
from .models import ApiError
from .security import Session, require_roles, require_session

router = APIRouter(prefix="/connections", tags=["connections"])
PROFILE_PATH = Path(__file__).resolve().parents[3] / "shared" / "countries.json"
Workflow = Literal["annual", "cap", "inputs", "inspection", "sustainability"]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Capability(Input):
    id: str
    country: str
    workflow_id: Workflow
    title: str
    mode: Literal["public_read", "private_read", "portal_handoff"]
    live_read: bool = False
    live_write: bool = False
    automatic_filing: bool = False
    official_url: str
    setup_requirements: list[str]
    limitations: list[str]
    sources: list[dict]
    documented_connections: list[dict] = Field(default_factory=list)
    configuration_ready: bool = False


class CreateConnection(Input):
    farm_id: UUID
    capability_id: str = Field(min_length=1, max_length=160)


class Revision(Input):
    expected_revision: int = Field(ge=1)


class Credentials(Revision):
    username: SecretStr | None = None
    password: SecretStr | None = None
    api_key: SecretStr | None = None


class ReadParcels(Input):
    bbox: list[float] = Field(min_length=4, max_length=4)
    limit: int = Field(default=50, ge=1, le=100)


class ReadDiary(Revision):
    consent: Literal[True]
    page: int = Field(default=1, ge=1, le=100000, strict=True)
    page_size: int = Field(default=50, ge=1, le=50, strict=True)


class ReadDiaryOperations(Revision):
    consent: Literal[True]
    field_read_id: UUID
    site_id: str = Field(min_length=1, max_length=20)
    use_id: str = Field(min_length=1, max_length=20)


class Preview(Input):
    report_id: UUID
    expected_report_revision: int = Field(ge=1)


class Approval(Input):
    preview_id: UUID
    expected_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")


class Handoff(Input):
    approval_id: UUID
    expected_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _official_url(value):
    from urllib.parse import urlsplit
    if not isinstance(value, str):
        return None
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or parts.fragment:
        return None
    return value


def capabilities():
    result = []
    if PROFILE_PATH.exists():
        profiles = json.loads(PROFILE_PATH.read_text(encoding="utf-8-sig"))
        for profile in profiles.get("countries", []):
            country = profile["country"]
            portal = profile.get("portal")
            if isinstance(portal, dict):
                portal = portal.get("url")
            portal = _official_url(portal)
            if not portal:
                continue
            for workflow in ("annual", "cap", "inputs", "inspection", "sustainability"):
                inventory = [entry for entry in profile.get("connections", []) if isinstance(entry, dict) and entry.get("workflow_id") == workflow]
                result.append(Capability(id=f"country-{country}-{workflow}-handoff", country=country, workflow_id=workflow,
                    title=f"{profile.get('name', country)} · {workflow.replace('_', ' ')} handoff", mode="portal_handoff", official_url=portal,
                    setup_requirements=["Prepare and approve a report in this workspace.", "Sign in separately to the authority portal using your own identity or valid delegated mandate.", "Review applicability, current campaign instructions, field mapping and every value before manually entering or attaching information."],
                    limitations=["No automatic filing, portal prefill, credential exchange or authority acceptance.", "Downloaded reports are FunkyFarm evidence dossiers, not validated authority-import files.", "The national portal is a starting route; not every workflow or small farm has an obligation there."],
                    sources=[entry for entry in profile.get("official_links", []) if isinstance(entry, dict)], documented_connections=inventory).model_dump())
    result.append(Capability(id="nl-pdok-brp-public", country="NL", workflow_id="cap", title="PDOK public crop parcel reference data", mode="public_read", live_read=True,
        official_url="https://api.pdok.nl/rvo/gewaspercelen/ogc/v1", setup_requirements=["Activate public read for the selected Dutch farm.", "Provide a small longitude/latitude map extent. No agency credentials are needed."],
        limitations=["Public parcel candidates only; not a private RVO claim or property register.", "Dataset edition may differ from the reporting year. Review its metadata before reuse.", "Nothing is automatically imported into confirmed farm facts, sent to RVO, or judged eligible."],
        sources=[{"url": "https://www.pdok.nl/ogc-apis/-/article/basisregistratie-gewaspercelen-brp-", "title": "PDOK official BRP OGC API"}]).model_dump())
    result.append(Capability(id="hu-nebih-egn-read", country="HU", workflow_id="inputs", title="Read my Nébih farm diary", mode="private_read", live_read=True,
        configuration_ready=nebih.configured(), official_url="https://portal.nebih.gov.hu/nebih-api",
        setup_requirements=["The operator needs Nébih software approval, service access and an approved network connection or certificate.", "The farm owner supplies a token for the correct eGN diary only after operator setup is available.", "Choose a page of fields, then choose a recorded crop use to read its work records. Review the diary, year and farm before reusing anything."],
        limitations=["The adapter has not been tested with an authority account. Configuration does not establish approval or successful access.", "Only two read operations are implemented. No write, finalise, LPIS correction or CAP application is sent.", "Each read is a partial snapshot. Source codes, dates, units and coordinates are retained as supplied; they are not guessed or converted into confirmed farm facts.", "A farm-sharing invitation does not grant a government mandate. Disconnect here and revoke the token at Nébih when access should stop."],
        sources=[{"url": "https://portal.nebih.gov.hu/documents/10182/501576/DATAPLANT-EGN-WHITEBOOK_2026_v0.23.pdf", "title": "Nébih eGN 2026 v0.23 service manual"}, {"url": "https://portal.nebih.gov.hu/documents/10182/560688569/Nebih-API+csatlakozas+utmutato.pdf", "title": "Nébih API connection guide"}]).model_dump())
    return result


def _capability(identifier):
    for item in capabilities():
        if item["id"] == identifier:
            return item
    raise ApiError(404, "capability_not_found", "This connection capability is not available.")


def _public(record):
    record = deepcopy(record)
    record["data"].pop("credential_ciphertext", None)
    return record


def _connection(conn, identifier):
    record = fetch_record(conn, "connections", str(identifier))
    farm = fetch_record(conn, "farms", record["data"]["farm_id"])
    if farm["data"].get("country") != _capability(record["data"]["capability_id"])["country"]:
        raise ApiError(409, "connection_country_changed", "The farm country changed. Create a connection for the current country.")
    return record


def _grant(conn):
    return conn.execute("SELECT membership_fingerprint() AS fingerprint").fetchone()["fingerprint"]


@router.get("/capabilities")
def list_capabilities(country: str | None = None, workflow_id: Workflow | None = None, session: Session = Depends(require_session)):
    items = [item for item in capabilities() if (not country or item["country"] == country.upper()) and (not workflow_id or item["workflow_id"] == workflow_id)]
    return {"items": items, "total": len(items), "limit": len(items), "offset": 0, "notice": "A documented national API is not necessarily an implemented or authorised connection."}


@router.get("")
def list_connections(farm_id: UUID | None = None, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        if farm_id:
            fetch_record(conn, "farms", str(farm_id))
        result = list_records(conn, "connections", limit, offset, str(farm_id) if farm_id else None)
        result["items"] = [_public(item) for item in result["items"]]
        return result


@router.post("", status_code=201)
def create_connection(body: CreateConnection, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    capability = _capability(body.capability_id)
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", str(body.farm_id))
        if farm["data"].get("country") != capability["country"]:
            raise ApiError(422, "connection_country", "Select a connection for this farm's country.")
        return idempotent(conn, idempotency_key, "connection-create", body.model_dump(mode="json"), lambda: insert_record(conn, "connections", {
            "farm_id": str(body.farm_id), "capability_id": body.capability_id, "title": capability["title"], "status": "not_connected", "credentials_present": False,
            "created_by": session.user_id, "automatic_filing": False}))


@router.get("/{connection_id}")
def connection_detail(connection_id: UUID, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = _public(_connection(conn, connection_id))
        record["data"]["capability"] = _capability(record["data"]["capability_id"])
        return record


@router.post("/{connection_id}/activate")
def activate(connection_id: UUID, body: Revision, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        record = _connection(conn, connection_id)
        capability = _capability(record["data"]["capability_id"])
        if capability["mode"] == "private_read":
            if not capability["configuration_ready"] or not record["data"].get("credentials_present"):
                raise ApiError(409, "private_read_setup_required", "Operator setup and a saved diary token are needed before this read can be enabled.")
            return _public(update_record(conn, "connections", record["id"], body.expected_revision, {**record["data"], "status": "private_read_enabled"}))
        if not capability["live_read"]:
            raise ApiError(409, "adapter_not_available", "This authority integration is not live. Use a reviewed manual handoff; no credentials or filing action can activate it.")
        return _public(update_record(conn, "connections", record["id"], body.expected_revision, {**record["data"], "status": "public_read_ready"}))


@router.post("/{connection_id}/disconnect")
def disconnect(connection_id: UUID, body: Revision, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        record = _connection(conn, connection_id)
        data = {key: value for key, value in record["data"].items() if key != "credential_ciphertext"}
        data.update(status="not_connected", credentials_present=False)
        return _public(update_record(conn, "connections", record["id"], body.expected_revision, data))


@router.post("/{connection_id}/credentials")
def save_credentials(connection_id: UUID, body: Credentials, request: Request, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    with transaction(session) as conn:
        record = _connection(conn, connection_id)
        values = {key: value.get_secret_value() for key, value in ((key, getattr(body, key)) for key in ("username", "password", "api_key")) if value is not None}
        private = record["data"]["capability_id"] == "hu-nebih-egn-read"
        if private:
            _human_browser(request)
            if not nebih.configured():
                raise ApiError(409, "private_read_setup_required", "Nébih operator setup is not available. Do not enter a diary token yet.")
            if set(values) != {"api_key"} or not 1 <= len(values["api_key"]) <= 50 or any(ord(char) < 33 for char in values["api_key"]):
                raise ApiError(422, "invalid_credentials", "Provide only the token copied from the correct eGN diary, up to 50 characters.")
        if not values or any(not value or len(value) > 8192 for value in values.values()):
            raise ApiError(422, "invalid_credentials", "Provide bounded, non-empty credential values.")
        encrypted = encrypt_credentials(session.workspace_id, record["id"], values)
        notice = "Diary token stored encrypted and unverified. Enable read access separately; no authority request has been made." if private else "Stored encrypted and unverified. No authenticated authority adapter is enabled."
        return _public(update_record(conn, "connections", record["id"], body.expected_revision, {**record["data"], "credential_ciphertext": encrypted, "credentials_present": True, "status": "not_connected", "credential_notice": notice}))


def _private_diary(conn, connection_id, revision, session):
    # Token replacement/disconnect cannot overtake an in-flight authorised read.
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='connections' AND deleted_at IS NULL FOR SHARE", (connection_id,))
    record = _connection(conn, connection_id)
    if record["revision"] != revision:
        raise ApiError(409, "revision_conflict", "This connection changed. Review its current state before reading again.")
    if record["data"].get("capability_id") != "hu-nebih-egn-read" or record["data"].get("status") != "private_read_enabled":
        raise ApiError(409, "read_not_enabled", "Enable the Nébih diary read for this farm first.")
    if not nebih.configured():
        raise ApiError(503, "private_read_setup_required", "Nébih operator setup is unavailable. No authority request was made.")
    credentials = decrypt_credentials(str(session.workspace_id), record["id"], record["data"].get("credential_ciphertext", ""))
    token = credentials.get("api_key")
    if not isinstance(token, str) or not 1 <= len(token) <= 50:
        raise ApiError(409, "diary_token_required", "Ask the farm owner to save the correct diary token again.")
    return record, token


def _retain_diary_read(conn, record, result, kind, parent_id=None):
    return insert_record(conn, "connection_reads", {"farm_id": record["data"]["farm_id"], "connection_id": record["id"],
        "connection_revision": record["revision"], "provider": "hu-nebih-egn", "read_kind": kind, "field_read_id": parent_id,
        "read_at": _now(), "result": result, "status": "needs_attention" if result["blocked"] else "unreviewed_candidates"})


@router.post("/{connection_id}/read-diary")
def read_diary(connection_id: UUID, body: ReadDiary, request: Request, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    _human_browser(request)
    with transaction(session) as conn:
        record, token = _private_diary(conn, connection_id, body.expected_revision, session)
        return _retain_diary_read(conn, record, nebih.read_diary(token, body.page, body.page_size), "fields")


@router.post("/{connection_id}/read-diary-operations")
def read_diary_operations(connection_id: UUID, body: ReadDiaryOperations, request: Request, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    _human_browser(request)
    with transaction(session) as conn:
        record, token = _private_diary(conn, connection_id, body.expected_revision, session)
        parent = fetch_record(conn, "connection_reads", str(body.field_read_id))
        data = parent["data"]
        matches = (data.get("provider") == "hu-nebih-egn" and data.get("read_kind") == "fields"
            and data.get("connection_id") == record["id"] and data.get("farm_id") == record["data"]["farm_id"]
            and data.get("connection_revision") == record["revision"] and not data.get("result", {}).get("blocked", True))
        sites = data.get("result", {}).get("sites", []) if matches else []
        if not any(site.get("id") == body.site_id and any(use.get("id") == body.use_id for use in site.get("uses", [])) for site in sites):
            raise ApiError(409, "diary_selection_changed", "Choose a recorded crop use from a fresh field read for this connection.")
        result = nebih.read_operations(token, body.site_id, body.use_id)
        return _retain_diary_read(conn, record, result, "operations", parent["id"])


@router.post("/{connection_id}/read")
def public_read(connection_id: UUID, body: ReadParcels, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        record = _connection(conn, connection_id)
        if record["data"].get("capability_id") != "nl-pdok-brp-public" or record["data"].get("status") != "public_read_ready":
            raise ApiError(409, "read_not_enabled", "Activate an implemented public-read connection first.")
        # No source values, private parcel identifiers or credentials are sent.
        result = read_parcels(body.bbox, body.limit)
        return insert_record(conn, "connection_reads", {"farm_id": record["data"]["farm_id"], "connection_id": record["id"], "read_at": _now(), "bbox": body.bbox, "result": result, "status": "unreviewed_candidates"})


@router.get("/{connection_id}/reads")
def read_history(connection_id: UUID, limit: int = Query(10, ge=1, le=50), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        _connection(conn, connection_id)
        count = conn.execute("SELECT count(*) AS count FROM records WHERE kind='connection_reads' AND data->>'connection_id'=%s AND deleted_at IS NULL", (str(connection_id),)).fetchone()["count"]
        rows = conn.execute("SELECT id FROM records WHERE kind='connection_reads' AND data->>'connection_id'=%s AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s", (str(connection_id), limit, offset)).fetchall()
        return {"items": [fetch_record(conn, "connection_reads", row["id"]) for row in rows], "total": count, "limit": limit, "offset": offset}


def _binding(conn, record, report_id, session):
    from .reporting import _blockers, _farm_lock
    report = fetch_record(conn, "reports", str(report_id))
    _farm_lock(conn, session, record["data"]["farm_id"])
    # Serialise approval against both reviewed facts and other source edits.
    sources = report["data"].get("validation_sources", {})
    ids = {record["id"], report["id"], record["data"]["farm_id"]}
    ids.update(sources.get("facts", {}))
    ids.update(sources.get("documents", {}))
    ids.update(sources.get("operations", {}))
    if sources.get("request"):
        ids.add(sources["request"]["id"])
    conn.execute("SELECT id FROM records WHERE id = ANY(%s::uuid[]) ORDER BY id FOR SHARE", (sorted(ids),)).fetchall()
    report = fetch_record(conn, "reports", str(report_id))
    data = report["data"]
    if data.get("farm_id") != record["data"]["farm_id"] or data.get("status") != "issued" or data.get("approval", {}).get("snapshot_checksum") != data.get("checksum"):
        raise ApiError(409, "issued_report_required", "Select an approved, issued report for this farm.")
    blockers = _blockers(conn, data)
    if blockers:
        raise ApiError(409, "handoff_sources_changed", "Report evidence changed or needs review. Prepare and approve a fresh report before handoff.", {"blockers": blockers})
    capability = _capability(record["data"]["capability_id"])
    pack = data["snapshot"]["pack"]
    if capability["mode"] != "portal_handoff" or pack.get("workflow_id") not in (None, capability["workflow_id"]):
        raise ApiError(422, "handoff_workflow", "Choose a manual handoff for this report's workflow.")
    return {"connection_id": record["id"], "connection_revision": record["revision"], "capability_checksum": _digest(capability), "report_id": report["id"], "report_revision": report["revision"], "report_checksum": data["checksum"], "validation_sources_checksum": _digest(data.get("validation_sources", {})), "membership_fingerprint": _grant(conn), "actor_id": session.user_id, "official_url": capability["official_url"]}


@router.post("/{connection_id}/preview", status_code=201)
def preview(connection_id: UUID, body: Preview, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        record = _connection(conn, connection_id)
        binding = _binding(conn, record, body.report_id, session)
        if binding["report_revision"] != body.expected_report_revision:
            raise ApiError(409, "revision_conflict", "The report changed. Refresh it before previewing.")
        report = fetch_record(conn, "reports", str(body.report_id))
        payload = {"binding": binding, "report_snapshot": report["data"]["snapshot"], "action": "manual_handoff", "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(), "notice": "Approve preparation only. Sign in to the official portal separately; nothing will be sent or prefilled."}
        return insert_record(conn, "connection_previews", {"farm_id": record["data"]["farm_id"], **payload, "checksum": _digest(payload)})


def _validate_preview(conn, connection_id, preview_id, checksum, session):
    record = _connection(conn, connection_id)
    retained = fetch_record(conn, "connection_previews", str(preview_id))
    data = retained["data"]
    payload = {key: data[key] for key in ("binding", "report_snapshot", "action", "expires_at", "notice")}
    if data.get("checksum") != checksum or _digest(payload) != checksum or datetime.fromisoformat(data["expires_at"]) <= datetime.now(timezone.utc):
        raise ApiError(409, "preview_expired", "This preview expired or changed. Prepare and review another preview.")
    current = _binding(conn, record, data["binding"]["report_id"], session)
    if current != data["binding"]:
        raise ApiError(409, "preview_stale", "Connection, evidence, identity or permissions changed. Review a new preview.")
    return retained


def _human_browser(request):
    if request.headers.get("authorization") or not request.cookies.get("funkyfarm_session"):
        raise ApiError(403, "human_browser_approval_required", "Review and approve this exact preview in your signed-in browser. Native or assistant bearer credentials cannot approve it.")


@router.post("/{connection_id}/approve", status_code=201)
def approve(connection_id: UUID, body: Approval, request: Request, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    _human_browser(request)
    with transaction(session) as conn:
        retained = _validate_preview(conn, connection_id, body.preview_id, body.expected_checksum, session)
        return idempotent(conn, idempotency_key, "connection-approve:" + str(connection_id), body.model_dump(mode="json"), lambda: insert_record(conn, "connection_approvals", {"farm_id": retained["data"]["farm_id"], "connection_id": str(connection_id), "preview_id": retained["id"], "checksum": body.expected_checksum, "actor_id": session.user_id, "approved_at": _now(), "action": "manual_handoff"}))


@router.post("/{connection_id}/handoff", status_code=201)
def handoff(connection_id: UUID, body: Handoff, request: Request, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    _human_browser(request)
    with transaction(session) as conn:
        approval = fetch_record(conn, "connection_approvals", str(body.approval_id))
        if approval["data"].get("connection_id") != str(connection_id) or approval["data"].get("checksum") != body.expected_checksum or approval["data"].get("actor_id") != session.user_id:
            raise ApiError(409, "approval_mismatch", "Use your approval for this connection and exact preview.")
        retained = _validate_preview(conn, connection_id, approval["data"]["preview_id"], body.expected_checksum, session)
        binding = retained["data"]["binding"]
        return idempotent(conn, idempotency_key or str(body.approval_id), "connection-handoff:" + str(connection_id), body.model_dump(mode="json"), lambda: insert_record(conn, "connection_handoffs", {"farm_id": retained["data"]["farm_id"], "connection_id": str(connection_id), "approval_id": str(body.approval_id), "preview_checksum": body.expected_checksum, "report_id": binding["report_id"], "official_url": binding["official_url"], "downloads": {format: f"/reports/{binding['report_id']}/download?format={format}" for format in ("pdf", "csv", "json", "xlsx")}, "status": "prepared_for_manual_handoff", "prepared_at": _now(), "automatic_filing": False, "authority_acceptance_verified": False, "notice": "Nothing was sent. Download the evidence dossier, then review and complete the authority's own filing flow. Do not retry an uncertain external submission blindly; check the authority receipt."}))
