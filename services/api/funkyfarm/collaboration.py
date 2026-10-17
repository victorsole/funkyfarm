"""Explicit delegation, recipient capabilities and deliberately published help."""

from datetime import date, datetime, timedelta, timezone
import secrets
from typing import Literal
from urllib.parse import quote
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Query, Response
from fastapi.responses import StreamingResponse
from psycopg.types.json import Jsonb
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, json_safe, list_records, transaction, update_record
from .models import ApiError, StrictModel
from .records import validate_data
from .security import Session, _email, require_roles, require_session, token_hash

router = APIRouter(tags=["collaboration"])
MANDATE_NOTICE = "Workspace access is the farmer's permission to use this application. It does not establish a government mandate or a right to act before an authority."
EU_COUNTRIES = frozenset("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split())
COMMUNITY_CATEGORIES = Literal["general", "paperwork", "cap", "inspections", "sustainability", "records"]
PUBLICATION_NOTICE = "Only the text you deliberately publish is shared with other signed-in members. Do not include private farm details, document links, credentials or personal information. Community replies are not authority decisions."


class InvitationInput(StrictModel):
    email: str = Field(min_length=3, max_length=254)
    role: Literal["adviser", "worker"] = "adviser"
    # NULL is an explicit whole-workspace grant; omission is never consent.
    farm_ids: list[UUID] | None = Field(..., max_length=100)
    permissions: list[Literal["read", "review"]] = Field(default_factory=lambda: ["read"], min_length=1, max_length=2)
    expires_in_days: int = Field(default=7, ge=1, le=30)


class TokenInput(StrictModel):
    token: str = Field(min_length=32, max_length=200, pattern=r"^[A-Za-z0-9_-]+$")


class ShareInput(StrictModel):
    report_id: UUID | None = None
    document_ids: list[UUID] = Field(default_factory=list, max_length=25)
    recipient_email: str = Field(min_length=3, max_length=254)
    expires_in_days: int = Field(default=7, ge=1, le=30)


class AskFarmerInput(StrictModel):
    farm_id: UUID
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(min_length=1, max_length=4000)
    request_id: UUID | None = None
    due_date: date | None = None


class QuestionInput(StrictModel):
    title: str = Field(min_length=1, max_length=180)
    body: str = Field(min_length=1, max_length=8000)
    topic: str = Field(default="general", min_length=1, max_length=60)
    publish: bool


class ReplyInput(StrictModel):
    body: str = Field(min_length=1, max_length=8000)
    publish: bool


class CommunityQuestionInput(StrictModel):
    title: str = Field(min_length=1, max_length=180)
    body: str = Field(min_length=1, max_length=8000)
    category: COMMUNITY_CATEGORIES = "general"
    country: str | None = Field(default=None, min_length=2, max_length=2)
    publish: Literal[True]


class CommunityReplyInput(StrictModel):
    body: str = Field(min_length=1, max_length=8000)
    publish: Literal[True]


class PrivateQuestionInput(StrictModel):
    farm_id: UUID
    recipient_id: UUID
    title: str = Field(min_length=1, max_length=180)
    body: str = Field(min_length=1, max_length=8000)


class PrivateReplyInput(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    body: str = Field(min_length=1, max_length=8000)


class PrivateCloseInput(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)


class AdviserProfileInput(StrictModel):
    display_name: str = Field(min_length=1, max_length=120)
    bio: str = Field(min_length=1, max_length=4000)
    countries: list[str] = Field(default_factory=list, max_length=27)
    languages: list[str] = Field(default_factory=list, max_length=24)
    qualification_claim: str = Field(default="", max_length=2000)
    publish: bool


class ModerationInput(StrictModel):
    status: Literal["published", "hidden"]
    reason: str = Field(min_length=1, max_length=2000)


class QualificationInput(StrictModel):
    decision: Literal["checked", "rejected"]
    evidence_reference: str = Field(min_length=1, max_length=2000)
    note: str = Field(min_length=1, max_length=4000)
    issuer: str = Field(min_length=1, max_length=240)
    credential_name: str = Field(min_length=1, max_length=240)
    expires_on: date | None = Field(...)


class FlagInput(StrictModel):
    reason: str = Field(min_length=1, max_length=2000)


def _now():
    return datetime.now(timezone.utc)


def _text(value: str):
    value = value.strip()
    if not value:
        raise ApiError(422, "empty_text", "Enter text before saving.")
    return value


def _private_record(record):
    result = {**record, "data": dict(record["data"])}
    result["data"].pop("token_hash", None)
    return result


def _list_private(kind, session, limit, offset):
    require_roles(session, "owner")
    with transaction(session) as conn:
        page = list_records(conn, kind, limit, offset)
    page["items"] = [_private_record(item) for item in page["items"]]
    return page


@router.get("/workspaces")
def workspaces(session: Session = Depends(require_session)):
    with transaction(session) as conn:
        rows = conn.execute("SELECT * FROM workspace_list()").fetchall()
    return {"items": json_safe(rows), "mandate_notice": MANDATE_NOTICE}


@router.get("/adviser/overview")
def adviser_overview(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0),
                     session: Session = Depends(require_session)):
    from dataclasses import replace

    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Open the signed-in adviser desk to view client workspaces.")
    with transaction(session) as conn:
        memberships = conn.execute("SELECT * FROM workspace_list()").fetchall()
    memberships = [row for row in memberships if row["role"] in {"owner", "adviser"}]
    clients = []
    for workspace in memberships[offset:offset + limit]:
        scoped = replace(session, workspace_id=str(workspace["id"]), role=workspace["role"])
        try:
            with transaction(scoped) as conn:
                # Each client uses a separate server-authorized RLS transaction.
                # Returned rows and counts therefore retain the current farm grant.
                pages = {kind: list_records(conn, kind, 100, 0) for kind in ("farms", "requests", "tasks", "admin_cases")}
                report_page = list_records(conn, "reports", 100, 0)
                reviews = conn.execute(
                    "SELECT kind,count(*) AS total FROM records WHERE kind IN ('facts','operations','purchases','sales') "
                    "AND deleted_at IS NULL AND data->>'review_status'='proposed' GROUP BY kind"
                ).fetchall()
                case_rows = conn.execute(
                    "SELECT data->>'status' AS status,count(*) AS total FROM records "
                    "WHERE kind='admin_cases' AND deleted_at IS NULL GROUP BY data->>'status'"
                ).fetchall()
        except ApiError as error:
            if error.status == 403:
                continue  # A grant revoked after the membership list supplies no client data.
            raise
        counts = {"facts": 0, "operations": 0, "purchases": 0, "sales": 0}
        counts.update({row["kind"]: row["total"] for row in reviews})
        missing = []
        for report in report_page["items"]:
            if report["data"].get("status") != "draft":
                continue
            for blocker in report["data"].get("blockers", []):
                if blocker.get("code") not in {"missing_fact", "missing_requirement", "missing_evidence"}:
                    continue
                missing.append({"farm_id": report["data"].get("farm_id"), "request_id": report["data"].get("request_id"), "report_id": report["id"],
                                "code": blocker["code"], "message": blocker["message"], "field": blocker.get("field"),
                                "checked_at": report["updated_at"], "basis": "saved_draft_check"})
        clients.append({"workspace": json_safe(workspace),
                        **{kind: page["items"] for kind, page in pages.items()},
                        "missing_information": missing[:100],
                        "case_counts": {row["status"] or "unknown": row["total"] for row in case_rows},
                        "review_counts": counts, "totals": {kind: page["total"] for kind, page in pages.items()},
                        "truncated": len(missing) > 100 or report_page["total"] > len(report_page["items"]) or any(page["total"] > len(page["items"]) for page in pages.values())})
    return {"clients": clients, "total": len(memberships), "limit": limit, "offset": offset,
            "mandate_notice": MANDATE_NOTICE}


def _adviser_memberships(session):
    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Open the signed-in adviser desk to view client farms.")
    with transaction(session) as conn:
        rows = conn.execute("SELECT * FROM workspace_list()").fetchall()
    return [row for row in rows if row["role"] in {"owner", "adviser"}]


def _adviser_workspace(session, workspace_id):
    from dataclasses import replace

    workspace = next((row for row in _adviser_memberships(session) if str(row["id"]) == str(workspace_id)), None)
    if workspace is None:
        raise ApiError(404, "not_found", "This client workspace is not available through your current access.")
    return replace(session, workspace_id=str(workspace["id"]), role=workspace["role"]), json_safe(workspace)


@router.get("/adviser/clients")
def adviser_clients(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0),
                    session: Session = Depends(require_session)):
    memberships = sorted(_adviser_memberships(session), key=lambda item: (item["name"].casefold(), str(item["id"])))
    return {"items": json_safe(memberships[offset:offset + limit]), "total": len(memberships),
            "limit": limit, "offset": offset, "mandate_notice": MANDATE_NOTICE}


@router.get("/adviser/farms")
def adviser_farms(workspace_id: UUID, search: str = Query("", max_length=160),
                  limit: int = Query(25, ge=1, le=50), offset: int = Query(0, ge=0),
                  session: Session = Depends(require_session)):
    scoped, workspace = _adviser_workspace(session, workspace_id)
    needle = search.strip().lower()
    with transaction(scoped) as conn:
        where = ("kind='farms' AND deleted_at IS NULL AND "
                 "strpos(lower(concat_ws(' ',data->>'name',data->>'country',data->>'region')),%s)>0")
        total = conn.execute(f"SELECT count(*) AS total FROM records WHERE {where}", (needle,)).fetchone()["total"]
        rows = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
                            f"WHERE {where} ORDER BY lower(data->>'name'),id LIMIT %s OFFSET %s",
                            (needle, limit, offset)).fetchall()
    return {"workspace": workspace, "items": json_safe(rows), "total": total, "limit": limit,
            "offset": offset, "search": search.strip()}


@router.get("/adviser/farms/{farm_id}")
def adviser_farm_detail(farm_id: UUID, workspace_id: UUID, limit: int = Query(25, ge=1, le=50),
                        tasks_offset: int = Query(0, ge=0), requests_offset: int = Query(0, ge=0),
                        cases_offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    scoped, workspace = _adviser_workspace(session, workspace_id)
    farm_key = str(farm_id)
    today = datetime.now(timezone.utc).date()
    upcoming = today + timedelta(days=30)
    with transaction(scoped) as conn:
        farm = fetch_record(conn, "farms", farm_key)
        pages = {kind: list_records(conn, kind, limit, offset, farm_key) for kind, offset in (
            ("tasks", tasks_offset), ("requests", requests_offset), ("admin_cases", cases_offset))}
        review_rows = conn.execute(
            "SELECT kind,count(*) AS total FROM records WHERE deleted_at IS NULL "
            "AND kind IN ('facts','operations','purchases','sales') AND data->>'farm_id'=%s "
            "AND data->>'review_status'='proposed' GROUP BY kind", (farm_key,)).fetchall()
        case_rows = conn.execute(
            "SELECT data->>'status' AS status,count(*) AS total FROM records WHERE kind='admin_cases' "
            "AND deleted_at IS NULL AND data->>'farm_id'=%s GROUP BY data->>'status'", (farm_key,)).fetchall()
        # Compare validated ISO dates as text: old records without dates remain unknown.
        active = ("SELECT id,kind,data->>'title' AS title,CASE WHEN kind='tasks' THEN data->>'due_date' "
                  "ELSE data->>'deadline' END AS recorded_date FROM records WHERE deleted_at IS NULL "
                  "AND kind IN ('tasks','requests','admin_cases') AND data->>'farm_id'=%s "
                  "AND coalesce(data->>'status','open') NOT IN "
                  "('done','complete','completed','cancelled','responded','accepted_recorded','receipt_saved')")
        schedule = conn.execute(
            "WITH active AS (" + active + ") SELECT "
            "count(*) FILTER (WHERE recorded_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND recorded_date<%s) AS overdue, "
            "count(*) FILTER (WHERE recorded_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND recorded_date>=%s AND recorded_date<=%s) AS upcoming, "
            "count(*) FILTER (WHERE recorded_date IS NULL OR recorded_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') AS undated FROM active",
            (farm_key, today.isoformat(), today.isoformat(), upcoming.isoformat())).fetchone()
        due_items = conn.execute(
            "WITH active AS (" + active + ") SELECT * FROM active "
            "WHERE recorded_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' ORDER BY recorded_date,id LIMIT 12", (farm_key,)).fetchall()
        report_page = list_records(conn, "reports", 100, 0, farm_key)
        missing = [{"report_id": report["id"], "message": blocker["message"], "checked_at": report["updated_at"]}
                   for report in report_page["items"] if report["data"].get("status") == "draft"
                   for blocker in report["data"].get("blockers", [])
                   if blocker.get("code") in {"missing_fact", "missing_requirement", "missing_evidence"}][:100]
    counts = {kind: 0 for kind in ("facts", "operations", "purchases", "sales")}
    counts.update({row["kind"]: row["total"] for row in review_rows})
    return {"workspace": workspace, "farm": farm, **pages, "review_counts": counts,
            "case_counts": {row["status"] or "unknown": row["total"] for row in case_rows},
            "schedule": {**schedule, "today": today.isoformat(), "through": upcoming.isoformat(), "items": json_safe(due_items)},
            "missing_information": missing, "reports_truncated": report_page["total"] > len(report_page["items"]),
            "mandate_notice": MANDATE_NOTICE}


@router.post("/adviser/ask-farmer", status_code=201)
def ask_farmer(body: AskFarmerInput, session: Session = Depends(require_session),
               idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        def create():
            data = {"farm_id": str(body.farm_id), "title": _text(body.title),
                    "description": _text(body.description), "assignee": "farmer", "status": "open",
                    "request_id": str(body.request_id) if body.request_id else None,
                    "due_date": body.due_date.isoformat() if body.due_date else None}
            # Validation checks both linked identifiers against the currently allowed farm.
            data = validate_data(conn, "tasks", data)
            data.update(asked_by=session.user_id, asked_at=_now().isoformat(), purpose="missing_information")
            return insert_record(conn, "tasks", data)
        return idempotent(conn, idempotency_key, "adviser-ask-farmer", body.model_dump(mode="json"), create)


def _adviser_recipient(conn, farm_id, recipient_id):
    rows = conn.execute("SELECT * FROM adviser_recipients(%s)", (farm_id,)).fetchall()
    recipient = next((row for row in rows if str(row["user_id"]) == str(recipient_id)), None)
    if recipient is None:
        raise ApiError(403, "adviser_grant_required", "Choose an adviser who already has access to this farm. Asking a question does not grant access.")
    return recipient


@router.get("/adviser/recipients")
def adviser_recipients(farm_id: UUID, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        fetch_record(conn, "farms", str(farm_id))
        rows = conn.execute("SELECT * FROM adviser_recipients(%s)", (farm_id,)).fetchall()
    return {"items": json_safe(rows), "notice": "Only existing farm grants are listed. A private question grants no additional access."}


@router.get("/adviser/questions")
def private_questions(farm_id: UUID | None = None, limit: int = Query(20, ge=1, le=50),
                      offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        if farm_id:
            fetch_record(conn, "farms", str(farm_id))
        return list_records(conn, "adviser_questions", limit, offset, str(farm_id) if farm_id else None)


@router.post("/adviser/questions", status_code=201)
def ask_adviser(body: PrivateQuestionInput, session: Session = Depends(require_session),
                idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner")
    with transaction(session) as conn:
        def create():
            fetch_record(conn, "farms", str(body.farm_id))
            _adviser_recipient(conn, body.farm_id, body.recipient_id)
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:{session.user_id}:private-questions",))
            recent = conn.execute("SELECT count(*) AS total FROM records WHERE kind='adviser_questions' AND data->>'asked_by'=%s "
                                  "AND created_at>now()-interval '1 day'", (session.user_id,)).fetchone()["total"]
            if recent >= 20:
                raise ApiError(429, "private_question_limit", "You can send at most 20 private questions per day in this workspace.")
            return insert_record(conn, "adviser_questions", {"farm_id": str(body.farm_id), "asked_by": session.user_id,
                "recipient_id": str(body.recipient_id), "title": _text(body.title), "body": _text(body.body),
                "status": "open", "responses": []})
        return idempotent(conn, idempotency_key, "ask-adviser", body.model_dump(mode="json"), create)


@router.get("/adviser/questions/{question_id}")
def private_question(question_id: UUID, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        return fetch_record(conn, "adviser_questions", str(question_id))


@router.post("/adviser/questions/{question_id}/reply")
def private_reply(question_id: UUID, body: PrivateReplyInput, session: Session = Depends(require_session),
                  idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        def create():
            conn.execute("SELECT id FROM records WHERE id=%s AND kind='adviser_questions' FOR UPDATE", (question_id,)).fetchone()
            record = fetch_record(conn, "adviser_questions", str(question_id))
            data = record["data"]
            if session.role != "owner" and data["recipient_id"] != session.user_id:
                raise ApiError(404, "not_found", "This private question was not found.")
            _adviser_recipient(conn, UUID(data["farm_id"]), UUID(data["recipient_id"]))
            if data["status"] == "closed":
                raise ApiError(409, "question_closed", "This private question is closed. Ask a new question when needed.")
            responses = data.get("responses", [])
            if len(responses) >= 50:
                raise ApiError(429, "reply_limit", "This question has reached its 50-reply limit. Close it and start a new question.")
            recent = sum(item["author_id"] == session.user_id and datetime.fromisoformat(item["at"]) > _now() - timedelta(minutes=15) for item in responses)
            if recent >= 5:
                raise ApiError(429, "reply_rate_limit", "Wait before adding more replies to this question.")
            response = {"author_id": session.user_id, "body": _text(body.body), "at": _now().isoformat()}
            status = "answered" if session.user_id == data["recipient_id"] else "open"
            return update_record(conn, "adviser_questions", record["id"], body.expected_revision,
                                 {**data, "responses": [*responses, response], "status": status})
        return idempotent(conn, idempotency_key, f"adviser-reply:{question_id}", body.model_dump(mode="json"), create)


@router.post("/adviser/questions/{question_id}/close")
def close_private_question(question_id: UUID, body: PrivateCloseInput, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    with transaction(session) as conn:
        record = fetch_record(conn, "adviser_questions", str(question_id))
        return update_record(conn, "adviser_questions", record["id"], body.expected_revision, {**record["data"], "status": "closed"})


@router.get("/invitations")
def invitations(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                session: Session = Depends(require_session)):
    return _list_private("invitations", session, limit, offset)


@router.post("/invitations", status_code=201)
def invite(body: InvitationInput, response: Response, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    email = _email(body.email)
    if body.farm_ids == []:
        raise ApiError(422, "empty_grant", "Select at least one farm, or explicitly grant the whole workspace.")
    permissions = sorted(set(body.permissions) | {"read"})
    token = secrets.token_urlsafe(32)
    data = {"email": email, "role": body.role, "farm_ids": None if body.farm_ids is None else sorted(set(map(str, body.farm_ids))),
            "permissions": permissions, "token_hash": token_hash(token),
            "expires_at": (_now() + timedelta(days=body.expires_in_days)).isoformat(),
            "revoked_at": None, "accepted_at": None, "invited_by": session.user_id}
    with transaction(session) as conn:
        for farm_id in data["farm_ids"] or []:
            fetch_record(conn, "farms", farm_id)
        record = insert_record(conn, "invitations", data)
    response.headers["Cache-Control"] = "no-store"
    return {"invitation": _private_record(record), "token": token, "mandate_notice": MANDATE_NOTICE}


@router.post("/invitations/accept")
def accept_invitation(body: TokenInput, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        workspace_id = conn.execute("SELECT accept_invitation(%s) AS id", (token_hash(body.token),)).fetchone()["id"]
    if workspace_id is None:
        raise ApiError(404, "invitation_unavailable", "This invitation is expired, revoked, used or addressed to another account.")
    return {"workspace_id": str(workspace_id), "accepted": True,
            "message": "Access was added. Your personal workspace and its records remain separate.",
            "mandate_notice": MANDATE_NOTICE}


@router.post("/invitations/{invitation_id}/revoke")
def revoke_invitation(invitation_id: UUID, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    with transaction(session) as conn:
        row = conn.execute("SELECT revoke_invitation(%s) AS invitation", (invitation_id,)).fetchone()["invitation"]
    if row is None:
        raise ApiError(404, "not_found", "This invitation was not found.")
    return _private_record(json_safe(row))


@router.get("/shares")
def shares(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
           session: Session = Depends(require_session)):
    return _list_private("shares", session, limit, offset)


@router.post("/shares", status_code=201)
def share_report(body: ShareInput, response: Response, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    if body.report_id is None and not body.document_ids:
        raise ApiError(422, "empty_share", "Select an issued report or at least one document to share.")
    token = secrets.token_urlsafe(32)
    with transaction(session) as conn:
        if body.report_id is not None:
            report = fetch_record(conn, "reports", str(body.report_id))
            if report["data"].get("status") != "issued":
                raise ApiError(409, "report_not_approved", "Approve this report before sharing its retained snapshot.")
        document_ids = sorted(set(map(str, body.document_ids)))
        for document_id in document_ids:
            fetch_record(conn, "documents", document_id)
        data = {"report_id": str(body.report_id) if body.report_id else None, "document_ids": document_ids,
                "recipient_email": _email(body.recipient_email),
                "token_hash": token_hash(token), "expires_at": (_now() + timedelta(days=body.expires_in_days)).isoformat(),
                "revoked_at": None, "created_by": session.user_id}
        record = insert_record(conn, "shares", data)
    response.headers["Cache-Control"] = "no-store"
    return {"share": _private_record(record), "token": token,
            "message": "The named recipient must sign in. Only your selected report and documents are shared, without granting workspace access."}


@router.post("/shares/{share_id}/revoke")
def revoke_share(share_id: UUID, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    with transaction(session) as conn:
        record = fetch_record(conn, "shares", str(share_id))
        data = {**record["data"], "revoked_at": record["data"].get("revoked_at") or _now().isoformat()}
        result = update_record(conn, "shares", str(share_id), record["revision"], data)
    return _private_record(result)


def _capability_hash(token: str):
    if not 32 <= len(token) <= 200 or any(char not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for char in token):
        raise ApiError(404, "share_unavailable", "This shared selection is not available.")
    return token_hash(token)


def _shared_selection(token: str, session):
    hashed = _capability_hash(token)
    with transaction(session) as conn:
        result = conn.execute("SELECT shared_selection(%s) AS result", (hashed,)).fetchone()["result"]
    if result is None:
        raise ApiError(404, "share_unavailable", "This shared selection is expired, revoked or addressed to another account.")
    result = json_safe(result)
    public = {key: result[key] for key in ("share_id", "recipient_email", "expires_at") if key in result}
    public["documents"] = [{key: document[key] for key in ("id", "filename", "media_type", "size_bytes", "sha256") if key in document}
                           for document in result.get("documents", [])]
    report = result.get("report")
    public["report"] = None
    # Report records retain private validation sources and internal ownership data.
    # A recipient receives only the issued response, matching downloadable exports.
    if report:
        public["report"] = {key: report[key] for key in ("id", "kind", "revision", "created_at", "updated_at") if key in report}
        public["report"]["data"] = {key: report["data"][key] for key in ("status", "snapshot", "checksum", "approval", "filing_status") if key in report["data"]}
    return public


@router.get("/shares/access/{token}")
def access_share(token: str, response: Response, session: Session = Depends(require_session)):
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return _shared_selection(token, session)


@router.get("/shares/access/{token}/download")
def download_share(token: str, format: Literal["pdf", "csv", "json", "xlsx"] = "pdf",
                   session: Session = Depends(require_session)):
    from .reporting import render_report_download

    shared = _shared_selection(token, session)
    if not shared.get("report"):
        raise ApiError(404, "report_not_shared", "This selection does not include a report.")
    response = render_report_download(shared["report"], format, require_issued=True)
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@router.get("/shares/access/{token}/documents/{document_id}/download")
def download_shared_document(token: str, document_id: UUID, session: Session = Depends(require_session)):
    from .documents import _filename, _open_original

    with transaction(session) as conn:
        result = conn.execute("SELECT shared_document(%s,%s) AS result", (_capability_hash(token), document_id)).fetchone()["result"]
        if result is None:
            raise ApiError(404, "share_unavailable", "This selected document is expired, revoked or addressed to another account.")
        result = json_safe(result)
        # The bounded resolver authorizes this exact file. No workspace record query
        # or membership is granted by the synthetic file-namespace context.
        scoped = Session(session.user_id, result["workspace_id"], "recipient", session.csrf_token)
        record = result["document"]
        handle, _ = _open_original(scoped, record)

    def chunks():
        try:
            while value := handle.read(64 * 1024):
                yield value
        finally:
            handle.close()

    return StreamingResponse(chunks(), media_type="application/octet-stream", headers={
        "Content-Disposition": "attachment; filename=\"shared-document\"; filename*=UTF-8''" + quote(_filename(record["data"]["filename"]), safe=""),
        "Content-Length": str(record["data"]["size_bytes"]), "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
    })


def _qualification(row):
    data = row["data"]
    status = "unverified"
    expiry = data.get("qualification_expires_on")
    complete_review = (data.get("qualification_status") == "checked" and data.get("qualification_issuer")
                       and data.get("qualification_credential") and "qualification_expires_on" in data
                       and data.get("qualification_evidence") and data.get("reviewed_at")
                       and data.get("reviewed_by") and str(data["reviewed_by"]) != str(row["author_id"]))
    if data.get("qualification_status") == "rejected":
        status = "rejected"
    elif complete_review:
        try:
            status = "expired" if expiry and date.fromisoformat(expiry) < _now().date() else "evidence_reviewed"
        except (ValueError, TypeError):
            status = "unverified"
    return {"status": status, "issuer": data.get("qualification_issuer") if complete_review else None,
            "credential_name": data.get("qualification_credential") if complete_review else None,
            "expires_on": expiry if complete_review else None, "reviewed_at": data.get("reviewed_at") if complete_review else None,
            "evidence_present": bool(data.get("qualification_evidence")) if complete_review else False,
            "notice": "Human review of supplied credential evidence is not an authority endorsement or a guarantee of expertise for your case." if status == "evidence_reviewed" else "Self-declared adviser. Current independently reviewed credential evidence is not established."}


def _public_result(row, session):
    row = json_safe(row)
    fields = {"question": {"title", "body", "topic", "category", "country"},
              "reply": {"question_id", "body"},
              "adviser_profile": {"display_name", "bio", "countries", "languages", "qualification_claim"}}
    data = {key: value for key, value in row["data"].items() if key in fields[row["kind"]]}
    if row["kind"] == "question":
        data.setdefault("category", data.get("topic") if data.get("topic") in COMMUNITY_CATEGORIES.__args__ else "general")
        data.setdefault("country", None)
    result = {"id": row["id"], "kind": row["kind"], "data": data, "status": row["status"],
              "created_at": row["created_at"], "updated_at": row["updated_at"],
              "is_author": str(row["author_id"]) == session.user_id}
    if row["kind"] == "adviser_profile":
        result["qualification"] = _qualification(row)
    return result


def _public_get(conn, content_id, *, kind=None, published=False):
    # RLS exposes only deliberately published material and the author's own drafts.
    row = conn.execute("SELECT * FROM public_content WHERE id=%s", (content_id,)).fetchone()
    if row is None or (kind and row["kind"] != kind) or (published and row["status"] != "published"):
        raise ApiError(404, "not_found", "This published item was not found.")
    return row


def _publication_budget(conn, session):
    # Public authorship is account-scoped, so changing farm/workspace cannot reset it.
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.user_id}:community-publication",))
    counts = conn.execute("SELECT count(*) FILTER (WHERE created_at>now()-interval '15 minutes') AS recent,"
                          "count(*) FILTER (WHERE created_at>now()-interval '1 day') AS daily "
                          "FROM public_content WHERE author_id=%s", (session.user_id,)).fetchone()
    if counts["recent"] >= 10 or counts["daily"] >= 50:
        raise ApiError(429, "community_rate_limit", "Wait before posting again. An account can publish at most 10 items in 15 minutes and 50 per day.")


def _public_insert(conn, session, kind, data, publish):
    if kind == "reply":
        parent_id = UUID(data["question_id"])
        conn.execute("SELECT id FROM public_content WHERE id=%s FOR SHARE", (parent_id,)).fetchone()
        _public_get(conn, parent_id, kind="question", published=True)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{parent_id}:community-replies",))
        count = conn.execute("SELECT count(*) AS total FROM public_content WHERE kind='reply' AND data->>'question_id'=%s",
                             (str(parent_id),)).fetchone()["total"]
        if count >= 200:
            raise ApiError(429, "community_reply_limit", "This question has reached its 200-reply limit. Start a new question for further discussion.")
    _publication_budget(conn, session)
    row = conn.execute("INSERT INTO public_content(id,author_id,kind,data,status) VALUES (%s,%s,%s,%s,%s) RETURNING *",
                       (uuid4(), session.user_id, kind, Jsonb(data), "published" if publish else "draft")).fetchone()
    return _public_result(row, session)


def _country(value):
    if value is not None and value not in EU_COUNTRIES:
        raise ApiError(422, "invalid_country", "Choose an EU country code, or leave the country unspecified.")
    return value


@router.get("/community")
def community(category: COMMUNITY_CATEGORIES | None = None, country: str | None = Query(None, min_length=2, max_length=2),
              limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    _country(country)
    where = "kind='question' AND status='published'"
    args = []
    if category:
        where += " AND COALESCE(data->>'category',data->>'topic','general')=%s"
        args.append(category)
    if country:
        where += " AND data->>'country'=%s"
        args.append(country)
    with transaction(session) as conn:
        total = conn.execute(f"SELECT count(*) AS total FROM public_content WHERE {where}", args).fetchone()["total"]
        rows = conn.execute(f"SELECT * FROM public_content WHERE {where} ORDER BY created_at DESC,id LIMIT %s OFFSET %s",
                            [*args, limit, offset]).fetchall()
    return {"items": [_public_result(row, session) for row in rows], "total": total, "limit": limit, "offset": offset,
            "notice": PUBLICATION_NOTICE}


@router.get("/community/mine")
def own_community(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        args = (session.user_id,)
        total = conn.execute("SELECT count(*) AS total FROM public_content WHERE author_id=%s AND kind IN ('question','reply')", args).fetchone()["total"]
        rows = conn.execute("SELECT * FROM public_content WHERE author_id=%s AND kind IN ('question','reply') "
                            "ORDER BY created_at DESC,id LIMIT %s OFFSET %s", (*args, limit, offset)).fetchall()
    return {"items": [_public_result(row, session) for row in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/community/moderation/reports")
def moderation_reports(limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        result = conn.execute("SELECT community_reports_queue(%s,%s) AS result", (limit, offset)).fetchone()["result"]
    if result is None:
        raise ApiError(403, "independent_reviewer_required", "Only a configured independent moderator can view reports.")
    result = json_safe(result)
    for item in result["items"]:
        item["content"] = _public_result(item["content"], session)
    return result


@router.post("/community", status_code=201)
def post_community(body: CommunityQuestionInput, session: Session = Depends(require_session),
                   idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    data = {"title": _text(body.title), "body": _text(body.body), "category": body.category,
            "country": _country(body.country)}
    with transaction(session) as conn:
        return idempotent(conn, idempotency_key, "community-question", body.model_dump(mode="json"),
                          lambda: _public_insert(conn, session, "question", data, True))


@router.get("/community/{question_id}")
def community_question(question_id: UUID, session: Session = Depends(require_session)):
    return question(question_id, session)


@router.post("/community/{question_id}/replies", status_code=201)
def post_community_reply(question_id: UUID, body: CommunityReplyInput, session: Session = Depends(require_session),
                         idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    with transaction(session) as conn:
        def create():
            # Lock publication state so a withdrawal cannot race a new public reply.
            conn.execute("SELECT id FROM public_content WHERE id=%s FOR SHARE", (question_id,)).fetchone()
            _public_get(conn, question_id, kind="question", published=True)
            return _public_insert(conn, session, "reply", {"question_id": str(question_id), "body": _text(body.body)}, True)
        return idempotent(conn, idempotency_key, f"community-reply:{question_id}", body.model_dump(mode="json"), create)


@router.get("/knowledge")
def knowledge(topic: str | None = Query(None, max_length=60), limit: int = Query(50, ge=1, le=100),
              offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    where = "kind='question' AND status='published'"
    args = []
    if topic:
        where += " AND data->>'topic'=%s"
        args.append(topic)
    with transaction(session) as conn:
        total = conn.execute(f"SELECT count(*) AS total FROM public_content WHERE {where}", args).fetchone()["total"]
        rows = conn.execute(f"SELECT * FROM public_content WHERE {where} ORDER BY created_at DESC,id LIMIT %s OFFSET %s",
                            [*args, limit, offset]).fetchall()
    return {"items": [_public_result(row, session) for row in rows], "total": total, "limit": limit, "offset": offset}


@router.post("/knowledge", status_code=201)
def publish_question(body: QuestionInput, session: Session = Depends(require_session)):
    data = {"title": _text(body.title), "body": _text(body.body), "topic": _text(body.topic)}
    with transaction(session) as conn:
        return _public_insert(conn, session, "question", data, body.publish)


@router.get("/knowledge/{question_id}")
def question(question_id: UUID, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        item = _public_get(conn, question_id, kind="question", published=True)
        replies = conn.execute("SELECT * FROM public_content WHERE kind='reply' AND status='published' AND data->>'question_id'=%s "
                               "ORDER BY created_at,id LIMIT 200", (str(question_id),)).fetchall()
    return {"question": _public_result(item, session), "replies": [_public_result(row, session) for row in replies]}


@router.post("/knowledge/{question_id}/replies", status_code=201)
def reply(question_id: UUID, body: ReplyInput, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        _public_get(conn, question_id, kind="question", published=True)
        return _public_insert(conn, session, "reply", {"question_id": str(question_id), "body": _text(body.body)}, body.publish)


@router.post("/community/{content_id}/withdraw")
@router.post("/knowledge/{content_id}/withdraw")
def withdraw(content_id: UUID, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        row = _public_get(conn, content_id)
        if str(row["author_id"]) != session.user_id:
            raise ApiError(403, "author_required", "Only the author can withdraw this content.")
        row = conn.execute("UPDATE public_content SET status='withdrawn',updated_at=clock_timestamp() WHERE id=%s RETURNING *",
                           (content_id,)).fetchone()
    return _public_result(row, session)


@router.post("/community/{content_id}/report", status_code=201)
@router.post("/knowledge/{content_id}/flag", status_code=201)
def flag(content_id: UUID, body: FlagInput, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        _public_get(conn, content_id, published=True)
        # Reports live in a dedicated moderator-only table, never a public post
        # or the private farm namespace of the author/reporter.
        identifier = conn.execute("SELECT report_public_content(%s,%s) AS id", (content_id, _text(body.reason))).fetchone()["id"]
    return {"id": str(identifier), "recorded": True}


@router.post("/community/{content_id}/moderate")
@router.post("/knowledge/{content_id}/moderate")
def moderate(content_id: UUID, body: ModerationInput, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        row = conn.execute("SELECT moderate_public_content(%s,%s,%s) AS result",
                           (content_id, body.status, _text(body.reason))).fetchone()["result"]
    if row is None:
        raise ApiError(403, "independent_reviewer_required", "A configured independent moderator must review this item.")
    return _public_result(row, session)


@router.get("/advisers")
def advisers(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
             session: Session = Depends(require_session)):
    with transaction(session) as conn:
        total = conn.execute("SELECT count(*) AS total FROM public_content WHERE kind='adviser_profile' AND status='published'").fetchone()["total"]
        rows = conn.execute("SELECT * FROM public_content WHERE kind='adviser_profile' AND status='published' "
                            "ORDER BY created_at DESC,id LIMIT %s OFFSET %s", (limit, offset)).fetchall()
    return {"items": [_public_result(row, session) for row in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/advisers/profile")
def own_adviser_profile(session: Session = Depends(require_session)):
    with transaction(session) as conn:
        rows = conn.execute("SELECT * FROM public_content WHERE kind='adviser_profile' AND author_id=%s ORDER BY created_at DESC",
                            (session.user_id,)).fetchall()
    return {"items": [_public_result(row, session) for row in rows]}


@router.post("/advisers/profile", status_code=201)
def adviser_profile(body: AdviserProfileInput, session: Session = Depends(require_session)):
    countries = sorted(set(code.upper() for code in body.countries))
    languages = sorted(set(code.lower() for code in body.languages))
    if any(len(code) != 2 or not code.isalpha() for code in countries + languages):
        raise ApiError(422, "invalid_profile_codes", "Use two-letter country and language codes.")
    data = {"display_name": _text(body.display_name), "bio": _text(body.bio), "countries": countries,
            "languages": languages, "qualification_claim": body.qualification_claim.strip(),
            "qualification_status": "unverified"}
    with transaction(session) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.user_id}:community-publication",))
        if conn.execute("SELECT 1 FROM public_content WHERE kind='adviser_profile' AND author_id=%s AND status!='withdrawn'",
                        (session.user_id,)).fetchone():
            raise ApiError(409, "profile_exists", "Withdraw your existing profile before publishing a replacement.")
        return _public_insert(conn, session, "adviser_profile", data, body.publish)


@router.post("/advisers/{profile_id}/qualification-review")
def review_qualification(profile_id: UUID, body: QualificationInput, session: Session = Depends(require_session)):
    if body.decision == "checked" and body.expires_on is not None and body.expires_on < _now().date():
        raise ApiError(422, "qualification_expired", "Expired evidence cannot establish a current reviewed qualification.")
    with transaction(session) as conn:
        row = conn.execute("SELECT review_adviser_qualification(%s,%s,%s,%s,%s,%s,%s::date) AS result",
                           (profile_id, body.decision, _text(body.evidence_reference), _text(body.note),
                            _text(body.issuer), _text(body.credential_name), body.expires_on)).fetchone()["result"]
    if row is None:
        raise ApiError(403, "independent_reviewer_required", "Only a configured independent reviewer can check these qualifications.")
    return _public_result(row, session)
