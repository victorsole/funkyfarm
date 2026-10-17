"""Private, human-reviewed administrative cases; never an authority integration."""

from copy import deepcopy
from datetime import date, datetime, timezone
import json
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Query
from pydantic import Field, field_validator

from .db import fetch_record, idempotent, insert_record, json_safe, transaction, update_record
from .models import ApiError, StrictModel
from .records import matches_reporting_period
from .reporting import _blockers, digest
from .security import Session, require_roles, require_session
from .cap_corrections import CapContext, answer_page, answer_review, correction_guide, validate_cap_context

router = APIRouter(prefix="/cases", tags=["guided administrative cases"])
NOTICE = "Preparation and human-recorded external events only. Nothing here sends a submission, changes official LPIS, verifies authority acceptance or establishes complete national legal compliance."
EXTERNAL_NOTICE = "Sending and response statuses were recorded by a person and have not been independently verified with an authority."
EDITABLE = {"draft", "needs_changes"}
MAX_DEPENDENCIES = 512
REFERENCE_KINDS = Literal["documents", "requests", "reports", "field_change_proposals", "facts", "operations", "checklists", "tasks"]
TRANSITIONS = {
    "sent": ({"ready_to_send"}, "sent"),
    "receipt": ({"sent", "receipt_saved"}, "receipt_saved"),
    "accepted": ({"sent", "receipt_saved"}, "accepted_recorded"),
    "needs_changes": ({"sent", "receipt_saved", "accepted_recorded"}, "needs_changes"),
    "reopen": ({"ready_to_send", "sent", "receipt_saved", "accepted_recorded", "needs_changes", "cancelled"}, "draft"),
    "cancelled": ({"draft", "ready_to_send", "sent", "receipt_saved", "needs_changes", "accepted_recorded"}, "cancelled"),
}


class CaseInput(StrictModel):
    @field_validator("deadline", "original_submitted_at", "date", "due_date", mode="before", check_fields=False)
    @classmethod
    def calendar_date(cls, value):
        if value is not None and (not isinstance(value, (str, date)) or isinstance(value, str) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
            raise ValueError("Use an actual ISO calendar date, YYYY-MM-DD.")
        return value


class Reference(StrictModel):
    kind: REFERENCE_KINDS
    id: UUID
    revision: int = Field(ge=1, strict=True)
    role: Literal["original", "notice", "change", "response", "evidence"]


class CreateCase(CaseInput):
    farm_id: UUID
    title: str = Field(min_length=1, max_length=240)
    job_type: Literal["fields", "correction", "inspection"]
    reporting_year: int = Field(ge=1900, le=2200, strict=True)
    authority: str | None = Field(default=None, max_length=240)
    scheme: str | None = Field(default=None, max_length=240)
    deadline: date | None = None
    original_reference: str | None = Field(default=None, max_length=240)
    original_submitted_at: date | None = None
    original_statement: str | None = Field(default=None, max_length=4000)
    cap_context: CapContext | None = None
    focused_review_required: bool = Field(default=False, strict=True)
    reason: str | None = Field(default=None, max_length=4000)
    references: list[Reference] = Field(default_factory=list, max_length=100)


class CasePatch(CaseInput):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    authority: str | None = Field(default=None, max_length=240)
    scheme: str | None = Field(default=None, max_length=240)
    deadline: date | None = None
    original_reference: str | None = Field(default=None, max_length=240)
    original_submitted_at: date | None = None
    original_statement: str | None = Field(default=None, max_length=4000)
    cap_context: CapContext | None = None
    focused_review_required: bool | None = Field(default=None, strict=True)
    reason: str | None = Field(default=None, max_length=4000)
    references: list[Reference] | None = Field(default=None, max_length=100)


class EditCase(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    data: CasePatch


class ReviewCase(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    expected_fingerprint: str = Field(pattern="^[0-9a-f]{64}$")
    acknowledged: bool = Field(strict=True)


class ReviewAnswers(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    fingerprint: str = Field(pattern="^[0-9a-f]{64}$")
    checked_ids: list[Annotated[str, Field(min_length=1, max_length=200)]] = Field(max_length=512)


class AddItem(CaseInput):
    expected_revision: int = Field(ge=1, strict=True)
    kind: Literal["requested_record", "finding", "action"]
    title: str = Field(min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=4000)
    due_date: date | None = None


class ReviewItem(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    status: Literal["in_progress", "resolved", "cancelled"]
    note: str = Field(min_length=1, max_length=4000)
    document_ids: list[UUID] = Field(default_factory=list, max_length=100)
    document_revisions: dict[UUID, Annotated[int, Field(ge=1, strict=True)]] = Field(default_factory=dict, max_length=100)
    acknowledged: bool = Field(strict=True)


class ExternalEvent(CaseInput):
    expected_revision: int = Field(ge=1, strict=True)
    action: Literal["sent", "receipt", "needs_changes", "accepted", "reopen", "cancelled"]
    date: date
    note: str = Field(min_length=1, max_length=4000)
    reference: str | None = Field(default=None, max_length=240)
    document_id: UUID | None = None
    document_revision: int | None = Field(default=None, ge=1, strict=True)
    acknowledged: bool = Field(strict=True)


def _human(session):
    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Open the signed-in application to work on an administrative case.")


def _write(conn, session, farm):
    _human(session)
    require_roles(session, "owner", "adviser")
    allowed = conn.execute("SELECT record_access(%s,'farms',%s::jsonb,true) AS allowed",
        (farm["id"], json.dumps(farm["data"]))).fetchone()["allowed"]
    if not allowed:
        raise ApiError(403, "review_permission_required", "Your current farm grant does not allow case changes.")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _nonblank(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ApiError(422, "case_value_required", f"Enter {label} before continuing.")


def _actual(value, label):
    if value is not None and date.fromisoformat(str(value)) > date.today():
        raise ApiError(422, "case_actual_date", f"Use the actual past or current {label}, not a future date.")


def _ack(value):
    if value is not True:
        raise ApiError(422, "case_acknowledgement_required", "Explicitly acknowledge this review or manually recorded event.")


def _bounded(data):
    if len(json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 512_000:
        raise ApiError(422, "case_too_large", "This case or history entry exceeds the app's bounded record size. Keep the detailed originals as linked documents.")
    return data


def _content(data):
    content = {key: deepcopy(data.get(key)) for key in ("farm_id", "title", "job_type", "reporting_year", "authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason", "references", "items")}
    # Do not rewrite the content hashes of pre-existing reviewed cases.
    for key in ("original_statement", "cap_context", "focused_review_required", "answer_review"):
        if key in data:
            content[key] = deepcopy(data[key])
    return content


def _case(conn, case_id):
    item = fetch_record(conn, "admin_cases", str(case_id))
    fetch_record(conn, "farms", item["data"]["farm_id"])
    return item


def _lock(conn, session, case_id, expected_revision):
    item = _case(conn, case_id)
    farm = fetch_record(conn, "farms", item["data"]["farm_id"])
    _write(conn, session, farm)
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm['id']}",))
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='admin_cases' AND deleted_at IS NULL FOR UPDATE", (UUID(item["id"]),))
    item = _case(conn, case_id)
    if item["revision"] != expected_revision:
        raise ApiError(409, "revision_conflict", "This case changed. Reload the saved case before continuing.", {"current_revision": item["revision"]})
    return item


def _editable(item):
    if item["data"]["status"] not in EDITABLE:
        raise ApiError(409, "case_not_editable", "Reopen this case before changing its prepared selections or items.")


def _same_farm(conn, kind, record_id, farm_id):
    item = fetch_record(conn, kind, str(record_id))
    if item["data"].get("farm_id") != farm_id:
        raise ApiError(422, "case_reference_scope", "Select a record assigned to this same farm. Unassigned or other-farm documents cannot be used here.")
    return item


def _references(conn, references, farm_id):
    seen = set()
    for reference in references:
        identity = (reference["kind"], reference["id"], reference["role"])
        if identity in seen:
            raise ApiError(422, "duplicate_case_reference", "Select each record and role only once.")
        seen.add(identity)
    ids = sorted({reference["id"] for reference in references})
    if ids:
        conn.execute("SELECT id FROM records WHERE id=ANY(%s::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE", (ids,)).fetchall()
    for reference in references:
        item = _same_farm(conn, reference["kind"], reference["id"], farm_id)
        if item["revision"] != reference["revision"]:
            raise ApiError(409, "case_reference_changed", "A selected record changed. Select its current revision before saving.", {"record_id": item["id"], "current_revision": item["revision"]})


def _href(kind, record_id, farm_id, revision=None):
    if kind == "documents":
        return f"/app/documents/{record_id}"
    if kind == "requests":
        return f"/app/paperwork/{record_id}"
    if kind == "reports":
        return f"/app/reports/{record_id}"
    if kind == "operations":
        return f"/app/record-work?farm_id={farm_id}&operation_id={record_id}"
    if kind == "field_change_proposals":
        version = f"&expected_revision={revision}" if revision is not None else ""
        return f"/app/fields/{farm_id}?proposal_id={record_id}{version}#boundaries-{farm_id}"
    if kind in {"checklists", "tasks"}:
        return f"/app/checks?farm_id={farm_id}"
    return f"/app/fields/{farm_id}" + ("#facts" if kind == "facts" else "")


def _report_ids(report):
    data = report["data"]
    result = {data.get("farm_id"), data.get("request_id")}
    sources = data.get("validation_sources", {})
    for kind in ("facts", "documents", "operations", "records", "journal_documents"):
        result.update(sources.get(kind, {}).keys())
    snapshot = data.get("snapshot", {})
    for kind in ("facts", "operations", "evidence"):
        result.update(item.get("id") for item in snapshot.get(kind, []) if isinstance(item, dict))
    for kind in ("farm", "request"):
        if isinstance(snapshot.get(kind), dict):
            result.add(snapshot[kind].get("id"))
    return {str(value) for value in result if value}


def _context(conn, item, *, lock=False):
    """Load only explicit scoped selections plus the reporting seam's dependencies."""
    data, farm_id = item["data"], item["data"]["farm_id"]
    farm = fetch_record(conn, "farms", farm_id)
    records = {}
    ids = {farm_id}
    for reference in data["references"]:
        try:
            linked = _same_farm(conn, reference["kind"], reference["id"], farm_id)
        except ApiError as exc:
            if exc.status not in {404, 422}:
                raise
            linked = None
        records[(reference["kind"], reference["id"])] = linked
        ids.add(reference["id"])
        if linked and reference["kind"] == "reports":
            ids.update(_report_ids(linked))
    for entry in data.get("items", []):
        ids.update(pin["id"] for pin in entry.get("document_pins", []))
    by_id = {}
    pending = set(ids)
    while pending:
        if len(ids) > MAX_DEPENDENCIES:
            raise ApiError(422, "case_dependency_limit", "This case depends on more than 512 records. Prepare a narrower case or review its separate reports individually.")
        rows = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
            "WHERE id=ANY(%s::uuid[]) AND deleted_at IS NULL ORDER BY id", (sorted(pending),)).fetchall()
        pending = set()
        for row in json_safe(rows):
            if row["id"] != farm_id and row["data"].get("farm_id") != farm_id:
                continue
            by_id[row["id"]] = row
            value = row["data"]
            candidates = [value.get("document_id")]
            if row["kind"] == "requests":
                candidates.extend((value.get("source_document_id"), *value.get("document_ids", [])))
                candidates.extend(source.get("document_id") for source in value.get("source_documents", []) if isinstance(source, dict))
            if row["kind"] == "field_change_proposals" and isinstance(value.get("import_source"), dict):
                candidates.append(value["import_source"].get("id"))
            for source in value.get("sources", []):
                if isinstance(source, dict):
                    candidates.extend((source.get("document_id"), source.get("record_id")))
            for candidate in candidates:
                try:
                    identifier = str(UUID(str(candidate)))
                except (ValueError, TypeError):
                    continue
                if identifier not in ids:
                    ids.add(identifier)
                    pending.add(identifier)
    if lock:
        conn.execute("SELECT id FROM records WHERE id=ANY(%s::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE", (sorted(ids),)).fetchall()
        fresh = _context(conn, _case(conn, item["id"]))
        if not set(fresh[3]).issubset(ids):
            raise ApiError(409, "case_checks_changed", "The source selection changed while waiting. Reload the current case checks.")
        return fresh
    bindings = [{"id": row["id"], "kind": row["kind"], "revision": row["revision"], "checksum": digest(row["data"])} for row in sorted(by_id.values(), key=lambda value: value["id"])]
    return farm, records, bindings, by_id


def _checks(conn, item, *, lock=False):
    data, farm_id = item["data"], item["data"]["farm_id"]
    farm, records, bindings, by_id = _context(conn, item, lock=lock)
    issues, views, states = [], [], []

    def add(code, message, *, severity="error", href=None):
        issue = {"code": code, "severity": severity, "message": message}
        if href:
            issue["href"] = href
        if issue not in issues:
            issues.append(issue)

    current = []
    for reference in data["references"]:
        linked = records[(reference["kind"], reference["id"])]
        view = {**reference, "title": "Unavailable linked record", "current_revision": None, "current": False, "href": None}
        if not linked:
            add("case_reference_unavailable", "A selected record is unavailable in this farm. Replace or remove that selection.")
            views.append(view)
            continue
        value = linked["data"]
        href = _href(reference["kind"], reference["id"], farm_id, reference["revision"])
        view.update(title=str(value.get("title") or value.get("label") or value.get("name") or value.get("filename") or reference["kind"])[:240],
            current_revision=linked["revision"], current=linked["revision"] == reference["revision"], href=href)
        views.append(view)
        if not view["current"]:
            add("case_reference_changed", "A selected record changed. Refresh its selection before reviewing this case.", href=href)
        else:
            current.append(reference)
        if reference["kind"] == "reports":
            if value.get("status") != "issued":
                add("case_report_unapproved", "Approve the report separately before using it as a prepared response or submitted original.", href=href)
            for attachment in value.get("snapshot", {}).get("evidence", []):
                original = by_id.get(attachment.get("id"))
                if not original or original["kind"] != "documents":
                    add("case_report_attachment_unavailable", "An attachment selected in this report is not available on this same farm. Link and review the original explicitly before preparing its folder.", href=href)
            try:
                blockers = _blockers(conn, value)
            except ApiError as exc:
                if exc.status not in {404, 409, 422}:
                    raise
                blockers = [{"code": "source_unavailable", "message": "A report dependency is unavailable. Review the report's source evidence."}]
            states.append({"id": linked["id"], "revision": linked["revision"], "status": value.get("status"),
                "checksum": value.get("checksum"), "blockers": digest(blockers)})
            if blockers:
                historical = reference["role"] == "original" and value.get("status") == "issued"
                add("case_original_report_changed" if historical else "case_report_sources_changed",
                    "The issued original's underlying records changed. Its original remains retained; review the correction against the current response." if historical else "A linked report has outstanding or changed source dependencies. Prepare and approve its current response separately.",
                    severity="warning" if historical else "error", href=href)
        if reference["kind"] in {"facts", "operations"}:
            if value.get("review_status") != "confirmed":
                add("case_unconfirmed_evidence", "Confirm the selected farm answer or activity through its separate human review first.", href=href)
            if reference["role"] != "original":
                from .compliance import _source_issues
                for source_issue in _source_issues(linked, None, farm_id, by_id, required=True):
                    add("case_evidence_" + source_issue["code"], source_issue["message"], href=href)
                temporal = value if reference["kind"] == "facts" else {**value, "temporal_basis": value.get("temporal_basis") or "calendar_date", "period": value.get("period") or value.get("date")}
                if not matches_reporting_period(temporal, data["reporting_year"]):
                    add("case_evidence_period", "Use evidence with the actual observation date or campaign year for this case. Static references remain standing details.", href=href)
                if value.get("superseded_by"):
                    add("case_evidence_superseded", "Select the reviewed current correction rather than this superseded answer.", href=href)
                if reference["kind"] == "operations":
                    successor = conn.execute("SELECT id FROM records WHERE kind='operations' AND deleted_at IS NULL AND data->>'farm_id'=%s "
                        "AND data->>'supersedes_id'=%s AND data->>'review_status'='confirmed' LIMIT 1", (farm_id, linked["id"])).fetchone()
                    if successor:
                        add("case_evidence_superseded", "Select the separately confirmed current application correction.", href=href)
        if reference["kind"] == "field_change_proposals":
            if reference["role"] != "original" and value.get("status") in {"discarded", "cancelled"}:
                add("case_field_discarded", "A discarded private field proposal cannot serve as a prepared change.", href=href)
            elif reference["role"] != "original" and value.get("status") == "proposed" and value.get("base_farm_revision") != farm["revision"]:
                add("case_field_context_changed", "The farm changed after this private proposal. Compare and refresh the proposal before preparing the handoff.", href=href)
        if reference["role"] != "original" and reference["kind"] in {"reports", "requests", "checklists"} and value.get("reporting_year") not in (None, data["reporting_year"]):
            add("case_reference_period", "Select the response or requested records for this case's explicit reporting year.", href=href)
    if data["job_type"] == "correction":
        if data.get("focused_review_required") and not (data.get("original_statement") or "").strip():
            add("case_original_statement_required", "State what you actually filed originally before preparing this as a post-filing correction. An issued app report alone is not proof of filing.", href=f"/app/cases/{item['id']}/correction?step=1")
        if not (data.get("original_reference") or "").strip() and not any(ref["role"] == "original" for ref in current):
            add("case_original_required", "Add the original submitted reference or select its original record.")
        if not (data.get("reason") or "").strip():
            add("case_reason_required", "Explain what was wrong and what you are correcting.")
        if not any(ref["role"] in {"response", "change"} for ref in current):
            add("case_response_required", "Select the reviewed response or private change you plan to hand over.")
    elif data["job_type"] == "fields":
        if not any(ref["kind"] == "field_change_proposals" and ref["role"] != "original" for ref in current):
            add("case_field_proposal_required", "Select the actual private field proposal you want to check and hand over.", href=f"/app/fields/{farm_id}")
    elif not any(ref["role"] == "notice" or ref["kind"] in {"requests", "checklists"} for ref in current):
        add("case_inspection_scope_required", "Select the inspection notice, request or checklist that describes the requested records.")
    if data["job_type"] == "inspection":
        notice_ids = {ref["id"] for ref in current if ref["role"] == "notice"}
        evidence = any(ref["role"] in {"response", "evidence"} and ref["kind"] in {"documents", "facts", "operations", "reports"}
                       and ref["id"] not in notice_ids for ref in current)
        resolved = any(entry["status"] == "resolved" and entry.get("document_pins") for entry in data.get("items", []))
        if not evidence and not resolved:
            add("case_inspection_records_required", "Add the requested records or prepare the response before reviewing. The inspection letter alone is not the completed packet.")
        for ref in current:
            if ref["kind"] != "requests" or not records[(ref["kind"], ref["id"])]["data"].get("requirements"):
                continue
            matching = any(candidate["kind"] == "reports" and candidate["role"] == "response"
                           and records[(candidate["kind"], candidate["id"])]["data"].get("request_id") == ref["id"] for candidate in current)
            if not matching:
                add("case_inspection_response_required", "Prepare and separately approve the response to the linked inspection request, so its known missing answers are checked.", href=_href("requests", ref["id"], farm_id))
    binding_by_id = {binding["id"]: binding for binding in bindings}
    for entry in data.get("items", []):
        if entry["status"] not in {"resolved", "cancelled"}:
            add("case_item_open", f"Finish or explicitly set aside the case item: {entry['title']}.")
        for pin in entry.get("document_pins", []):
            binding = binding_by_id.get(pin["id"])
            if not binding or binding["kind"] != "documents" or binding["revision"] != pin["revision"]:
                add("case_item_evidence_changed", "An item's reviewed document changed or is unavailable. Review that item against its current evidence.")
    answers = None
    if data.get("focused_review_required"):
        answers = answer_review(item, farm, records, bindings, _content(data))
        if not answers["all_checked"]:
            add("case_answers_unchecked", "Open the focused answer review and explicitly check every current answer and boundary map before reviewing this case.", href=f"/app/cases/{item['id']}/correction?step=4")
    guide = correction_guide(item, records) if data.get("cap_context") is not None else None
    if guide and guide["evaluation"]["status"] != "may_prepare":
        add("case_correction_guidance", guide["evaluation"]["explanation"], severity="warning", href=f"/app/cases/{item['id']}/correction?step=3")
    add("case_national_coverage_unverified", "This checks the selected app records only. Confirm the applicable national requirements, requested records and official process with the recipient or adviser.", severity="warning")
    fingerprint_input = {"case_id": item["id"], "content": _content(data), "farm_revision": farm["revision"], "bindings": bindings, "report_states": states, "issues": issues}
    if guide:
        fingerprint_input["correction_guide"] = guide["evaluation"]
    fingerprint = digest(fingerprint_input)
    can_review = not any(issue["severity"] == "error" for issue in issues)
    return {"case_id": item["id"], "case_revision": item["revision"], "fingerprint": fingerprint, "can_review": can_review,
        "issues": issues, "references": views, "next_action": "Review this prepared selection" if can_review else next(issue["message"] for issue in issues if issue["severity"] == "error"),
        "notice": NOTICE, **({"answer_review": {key: answers[key] for key in ("fingerprint", "total", "checked_count", "all_checked")}} if answers else {})}, bindings


def _audit(conn, case_record, session, action, **details):
    return insert_record(conn, "admin_case_events", _bounded({"farm_id": case_record["data"]["farm_id"], "case_id": case_record["id"],
        "case_revision": case_record["revision"], "action": action, "actor_id": session.user_id, "recorded_at": _now(),
        "content_hash": digest(_content(case_record["data"])), **details}))


def _save(conn, item, data):
    return update_record(conn, "admin_cases", item["id"], item["revision"], _bounded(data))


def _retry(conn, key, action, session, body, operation):
    return idempotent(conn, key, f"case:{action}:{session.user_id}", body.model_dump(mode="json"), operation)


def prepare_case_draft(conn, body: CreateCase):
    """Validation-only deterministic preparation for a human-visible proposal."""
    farm = fetch_record(conn, "farms", str(body.farm_id))
    data = body.model_dump(mode="json")
    _nonblank(data["title"], "a case title")
    _actual(data.get("original_submitted_at"), "original submission date")
    _references(conn, data["references"], farm["id"])
    validate_cap_context(data)
    return _bounded({**data, "items": [], "status": "draft", "review": None, "external_status_notice": EXTERNAL_NOTICE})


def create_case_draft(conn, session, body: CreateCase, expected_data=None):
    """Create only a draft in the caller's human transaction, with retained audit."""
    farm = fetch_record(conn, "farms", str(body.farm_id))
    _write(conn, session, farm)
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm['id']}",))
    prepared = prepare_case_draft(conn, body)
    if expected_data is not None and digest(prepared) != digest(expected_data):
        raise ApiError(409, "case_draft_changed", "The prepared case changed. Review a new draft proposal.")
    item = insert_record(conn, "admin_cases", prepared)
    _audit(conn, item, session, "created", changes=_content(item["data"]))
    return item


@router.get("")
def cases(farm_id: UUID | None = None, job_type: Literal["fields", "correction", "inspection"] | None = None,
          limit: int = Query(25, ge=1, le=100), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        where, args = "kind='admin_cases' AND deleted_at IS NULL", []
        if farm_id is not None:
            fetch_record(conn, "farms", str(farm_id))
            where += " AND data->>'farm_id'=%s"
            args.append(str(farm_id))
        if job_type:
            where += " AND data->>'job_type'=%s"
            args.append(job_type)
        total = conn.execute(f"SELECT count(*) AS n FROM records WHERE {where}", args).fetchone()["n"]
        display_fields = ",".join(f"'{key}',data->'{key}'" for key in (
            "farm_id", "title", "job_type", "reporting_year", "status", "deadline", "authority", "scheme", "original_reference", "external_status_notice"))
        projection = (f"jsonb_build_object({display_fields},"
            "'counts',jsonb_build_object('references',jsonb_array_length(data->'references'),'items',jsonb_array_length(data->'items'),"
            "'open_items',(SELECT count(*) FROM jsonb_array_elements(data->'items') i WHERE i->>'status' NOT IN ('resolved','cancelled'))))")
        rows = conn.execute(f"SELECT id,kind,workspace_id,revision,{projection} AS data,created_at,updated_at FROM records WHERE {where} ORDER BY updated_at DESC,id LIMIT %s OFFSET %s", [*args, limit, offset]).fetchall()
        return {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}


@router.post("", status_code=201)
def create_case(body: CreateCase, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        def perform():
            return create_case_draft(conn, session, body)
        return _retry(conn, idempotency_key, "create", session, body, perform)


@router.get("/{case_id}")
def case_detail(case_id: UUID, session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        return _case(conn, case_id)


@router.patch("/{case_id}")
def edit_case(case_id: UUID, body: EditCase, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        def perform():
            item = _lock(conn, session, case_id, body.expected_revision)
            _editable(item)
            patch = body.data.model_dump(mode="json", exclude_unset=True)
            if "title" in patch:
                _nonblank(patch["title"], "a case title")
            if "references" in patch and patch["references"] is None:
                raise ApiError(422, "case_references_required", "Use an empty list to clear the selected references.")
            if "focused_review_required" in patch and patch["focused_review_required"] is None:
                raise ApiError(422, "case_focus_required", "Choose whether this case requires focused answer review.")
            if item["data"].get("focused_review_required") and patch.get("focused_review_required") is False:
                raise ApiError(422, "case_focus_required", "Keep focused review enabled for this case. Check the actual current answers rather than bypassing their review.")
            data = {**item["data"], **patch, "review": None}
            _actual(data.get("original_submitted_at"), "original submission date")
            _references(conn, data["references"], data["farm_id"])
            validate_cap_context(data)
            updated = _save(conn, item, data)
            _audit(conn, updated, session, "updated", changes=patch)
            return updated
        return _retry(conn, idempotency_key, f"edit:{case_id}", session, body, perform)


@router.get("/{case_id}/correction-guide")
def case_correction_guide(case_id: UUID, session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        item = _case(conn, case_id)
        _, records, _, _ = _context(conn, item)
        return correction_guide(item, records)


@router.get("/{case_id}/answer-review")
def case_answer_review(case_id: UUID, limit: int = Query(5, ge=1, le=5), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        item = _case(conn, case_id)
        farm, records, bindings, _ = _context(conn, item)
        return answer_page(answer_review(item, farm, records, bindings, _content(item["data"])), limit, offset)


@router.post("/{case_id}/answer-review")
def record_answer_review(case_id: UUID, body: ReviewAnswers, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        def perform():
            item = _lock(conn, session, case_id, body.expected_revision)
            _editable(item)
            farm, records, bindings, _ = _context(conn, item, lock=True)
            result = answer_review(item, farm, records, bindings, _content(item["data"]))
            if result["fingerprint"] != body.fingerprint:
                raise ApiError(409, "case_answers_changed", "The case values or source revisions changed. Reload and compare the current answers; none of these checks were applied.")
            rows = {row["id"]: row for row in result["items"]}
            if len(set(body.checked_ids)) != len(body.checked_ids) or any(identifier not in rows for identifier in body.checked_ids):
                raise ApiError(422, "case_answer_selection", "Explicitly check only the displayed current answer IDs, without duplicates or unknown answers.")
            checks = {row["id"]: deepcopy(row["check"]) for row in result["items"] if row["checked"]}
            at = _now()
            for identifier in body.checked_ids:
                checks[identifier] = {"row_hash": rows[identifier]["row_hash"], "actor_id": session.user_id, "at": at}
            retained_rows = [{key: deepcopy(value) for key, value in row.items() if key not in {"checked", "check"}} for row in result["items"]]
            review = {"fingerprint": result["fingerprint"], "rows": retained_rows, "checks": checks}
            updated = _save(conn, item, {**item["data"], "answer_review": review, "review": None})
            _audit(conn, updated, session, "answers_checked", checked_ids=body.checked_ids, fingerprint=result["fingerprint"])
            result = answer_review(updated, farm, records, bindings, _content(updated["data"]))
            return {"case": updated, "answer_review": answer_page(result)}
        return _retry(conn, idempotency_key, f"answer-review:{case_id}", session, body, perform)


@router.get("/{case_id}/checks")
def case_checks(case_id: UUID, session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        return _checks(conn, _case(conn, case_id))[0]


@router.post("/{case_id}/review")
def review_case(case_id: UUID, body: ReviewCase, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    _ack(body.acknowledged)
    with transaction(session) as conn:
        def perform():
            item = _lock(conn, session, case_id, body.expected_revision)
            _editable(item)
            checked, bindings = _checks(conn, item, lock=True)
            if checked["fingerprint"] != body.expected_fingerprint:
                raise ApiError(409, "case_checks_changed", "The case or its sources changed. Review the current checks before continuing.", checked)
            if not checked["can_review"]:
                raise ApiError(422, "case_not_ready", "Resolve the case preparation issues before reviewing this selection.", checked)
            review = {"actor_id": session.user_id, "at": _now(), "fingerprint": checked["fingerprint"],
                "content_hash": digest(_content(item["data"])), "referenced_revisions": bindings}
            updated = _save(conn, item, {**item["data"], "status": "ready_to_send", "review": review})
            _audit(conn, updated, session, "reviewed", review=review)
            return updated
        return _retry(conn, idempotency_key, f"review:{case_id}", session, body, perform)


@router.post("/{case_id}/items", status_code=201)
def add_item(case_id: UUID, body: AddItem, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        def perform():
            item = _lock(conn, session, case_id, body.expected_revision)
            _editable(item)
            _nonblank(body.title, "an item title")
            if len(item["data"]["items"]) >= 100:
                raise ApiError(422, "case_item_limit", "A case can contain at most 100 requested records, findings and actions.")
            entry = {"id": str(uuid4()), **body.model_dump(mode="json", exclude={"expected_revision"}), "status": "open", "document_pins": []}
            updated = _save(conn, item, {**item["data"], "items": [*item["data"]["items"], entry], "review": None})
            _audit(conn, updated, session, "item_added", item=entry)
            return updated
        return _retry(conn, idempotency_key, f"item-add:{case_id}", session, body, perform)


@router.post("/{case_id}/items/{item_id}/review")
def review_item(case_id: UUID, item_id: UUID, body: ReviewItem, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    _ack(body.acknowledged)
    _nonblank(body.note, "what you checked or why this item was set aside")
    with transaction(session) as conn:
        def perform():
            item = _lock(conn, session, case_id, body.expected_revision)
            _editable(item)
            entries = deepcopy(item["data"]["items"])
            entry = next((value for value in entries if value["id"] == str(item_id)), None)
            if entry is None:
                raise ApiError(404, "case_item_not_found", "This case item was not found.")
            if body.status == "resolved" and not body.document_ids:
                raise ApiError(422, "case_item_evidence_required", "Select the actual documents supporting this item's resolution.")
            ids = sorted({str(value) for value in body.document_ids})
            revisions = {str(key): value for key, value in body.document_revisions.items()}
            if set(revisions) != set(ids):
                raise ApiError(422, "case_document_pins_required", "Keep the selected version for every supporting document, without extra or missing selections.")
            if ids:
                conn.execute("SELECT id FROM records WHERE id=ANY(%s::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE", (ids,)).fetchall()
            pins = [{"id": doc["id"], "revision": doc["revision"]} for doc in (_same_farm(conn, "documents", value, item["data"]["farm_id"]) for value in ids)]
            if any(pin["revision"] != revisions[pin["id"]] for pin in pins):
                raise ApiError(409, "case_reference_changed", "A selected document changed. Compare and select its current version before recording this item's progress.")
            entry.update(status=body.status, document_pins=pins, review={"actor_id": session.user_id, "at": _now(), "note": body.note})
            updated = _save(conn, item, {**item["data"], "items": entries, "review": None})
            _audit(conn, updated, session, "item_reviewed", item=entry)
            return updated
        return _retry(conn, idempotency_key, f"item-review:{case_id}:{item_id}", session, body, perform)


def _handoff(conn, item, fingerprint, *, retained_fields=False):
    from .catalogue import country_profiles
    farm = fetch_record(conn, "farms", item["data"]["farm_id"])
    _, profiles = country_profiles()
    profile = next((value for value in profiles if value["country"] == farm["data"].get("country")), {})
    official = profile.get("portal", {}).get("url")
    parsed = urlsplit(official or "")
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        official = None
    data = item["data"]
    fields = [{"label": label, "value": data.get(key)} for key, label in (("title", "Case"), ("job_type", "Job"), ("reporting_year", "Reporting year"),
        ("authority", "Authority named by the farmer"), ("scheme", "Scheme named by the farmer"), ("deadline", "Recorded deadline"),
        ("original_reference", "Original reference"), ("original_submitted_at", "Recorded original submission date"), ("reason", "Reason and changes"))]
    version_key = "retained_revision" if retained_fields else "expected_revision"
    downloads = [{"label": "Complete prepared folder (ZIP)",
        "href": f"/api/v1/cases/{item['id']}/packet?{version_key}={item['revision']}&reference_fingerprint={fingerprint}"}]
    seen = set()
    for reference in data["references"]:
        key = (reference["kind"], reference["id"])
        if key in seen:
            continue
        seen.add(key)
        if reference["kind"] == "reports":
            linked = _same_farm(conn, "reports", reference["id"], data["farm_id"])
            if linked["data"].get("status") == "issued":
                downloads.extend({"label": f"Report {reference['role']} ({format.upper()})", "href": f"/api/v1/reports/{reference['id']}/download?format={format}"} for format in ("pdf", "csv", "json", "xlsx"))
        elif reference["kind"] == "field_change_proposals":
            version_key = "retained_revision" if retained_fields else "expected_revision"
            downloads.extend({"label": f"{'Retained' if retained_fields else 'Private'} field {reference['role']} ({format})", "href": f"/api/v1/field-proposals/{reference['id']}/export?format={format}&{version_key}={reference['revision']}"} for format in ("geojson", "correction", "kml"))
    return {"case_id": item["id"], "notice": NOTICE + " The official link is starting information, not a verified sending page. Follow your original notice for the exact recipient and process.", "official_url": official, "fields": fields, "downloads": downloads, "reference_fingerprint": fingerprint}


def _current_review(conn, item, *, lock=False):
    checked, _ = _checks(conn, item, lock=lock)
    review = item["data"].get("review") or {}
    if not checked["can_review"] or review.get("fingerprint") != checked["fingerprint"] or review.get("content_hash") != digest(_content(item["data"])):
        raise ApiError(409, "case_review_stale", "This prepared selection changed. Reopen and review the current case before recording it as sent.", checked)
    return checked


@router.get("/{case_id}/handoff")
def case_handoff(case_id: UUID, session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        item = _case(conn, case_id)
        if item["data"]["status"] == "ready_to_send":
            checked = _current_review(conn, item)
            return {**_handoff(conn, item, checked["fingerprint"]), "origin": "current_review"}
        if event_id := item["data"].get("sent_event_id"):
            event = _same_farm(conn, "admin_case_events", event_id, item["data"]["farm_id"])
            if event["data"].get("case_id") != item["id"] or event["data"].get("action") != "sent":
                raise ApiError(409, "case_seal_invalid", "The retained sent bundle is unavailable.")
            return {**deepcopy(event["data"]["sealed_bundle"]["handoff"]), "origin": "sealed_sent_bundle",
                "notice": NOTICE + " This is the historical selection recorded as sent, not a fresh review of current sources."}
        raise ApiError(409, "case_not_reviewed", "Review the current prepared case before opening a handoff.")


@router.get("/{case_id}/events")
def case_events(case_id: UUID, limit: int = Query(25, ge=1, le=100), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        item = _case(conn, case_id)
        params = (item["id"], item["data"]["farm_id"])
        where = "kind='admin_case_events' AND deleted_at IS NULL AND data->>'case_id'=%s AND data->>'farm_id'=%s"
        total = conn.execute(f"SELECT count(*) AS n FROM records WHERE {where}", params).fetchone()["n"]
        rows = conn.execute(f"SELECT id,kind,workspace_id,revision,data-ARRAY['sealed_bundle','changes','item','review']::text[] AS data,created_at,updated_at FROM records WHERE {where} ORDER BY created_at DESC,id DESC LIMIT %s OFFSET %s", (*params, limit, offset)).fetchall()
        return {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}


@router.get("/{case_id}/events/{event_id}")
def case_event_detail(case_id: UUID, event_id: UUID, session: Session = Depends(require_session)):
    _human(session)
    with transaction(session) as conn:
        item = _case(conn, case_id)
        event = _same_farm(conn, "admin_case_events", event_id, item["data"]["farm_id"])
        if event["data"].get("case_id") != item["id"]:
            raise ApiError(404, "case_event_not_found", "This history entry was not found in this case.")
        return event


@router.post("/{case_id}/events", status_code=201)
def record_event(case_id: UUID, body: ExternalEvent, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _human(session)
    _ack(body.acknowledged)
    _nonblank(body.note, "what actually happened")
    _actual(body.date, "event date")
    with transaction(session) as conn:
        def perform():
            item = _lock(conn, session, case_id, body.expected_revision)
            allowed, status = TRANSITIONS[body.action]
            if item["data"]["status"] not in allowed:
                raise ApiError(409, "case_event_transition", "This recorded event does not follow the current case state. Reload the case before continuing.")
            if body.action == "sent" and item["data"].get("original_submitted_at") and body.date < date.fromisoformat(item["data"]["original_submitted_at"]):
                raise ApiError(422, "case_event_date", "A correction cannot have been sent before the recorded original submission. Check the actual dates.")
            if body.action in {"receipt", "accepted", "needs_changes"} and item["data"].get("sent_event_id"):
                sent = _same_farm(conn, "admin_case_events", item["data"]["sent_event_id"], item["data"]["farm_id"])
                if sent["data"].get("case_id") != item["id"] or sent["data"].get("action") != "sent":
                    raise ApiError(409, "case_seal_invalid", "The recorded sending for this case is unavailable.")
                if body.date < date.fromisoformat(sent["data"]["date"]):
                    raise ApiError(422, "case_event_date", "This response is dated before the recorded sending. Check the actual dates.")
            if bool(body.document_id) != bool(body.document_revision):
                raise ApiError(422, "case_document_pin_required", "Select both the actual document and its current revision.")
            if body.action in {"receipt", "accepted"}:
                _nonblank(body.reference, "the actual authority response reference")
                if not body.document_id:
                    raise ApiError(422, "case_response_document_required", "Select the actual receipt or acceptance document. A recorded status is not independent verification.")
            if body.document_id:
                conn.execute("SELECT id FROM records WHERE id=%s AND deleted_at IS NULL FOR SHARE", (body.document_id,)).fetchone()
                doc = _same_farm(conn, "documents", body.document_id, item["data"]["farm_id"])
                if doc["revision"] != body.document_revision:
                    raise ApiError(409, "case_reference_changed", "The response document changed. Review its current revision before recording the event.")
            extra = {}
            if body.action == "sent":
                checked = _current_review(conn, item, lock=True)
                extra["sealed_bundle"] = {"case_revision": item["revision"], "content": _content(item["data"]),
                    "review": deepcopy(item["data"]["review"]), "handoff": _handoff(conn, item, checked["fingerprint"], retained_fields=True)}
            data = {**item["data"], "status": status, "external_status_notice": EXTERNAL_NOTICE}
            if body.action in {"reopen", "needs_changes", "cancelled"}:
                data["review"] = None
            planned = {**item, "revision": item["revision"] + 1, "data": data}
            event = _audit(conn, planned, session, body.action, **body.model_dump(mode="json", exclude={"expected_revision", "action", "acknowledged"}), **extra)
            if body.action == "sent":
                data["sent_event_id"] = event["id"]
            updated = _save(conn, item, data)
            return {"case": updated, "event": event}
        return _retry(conn, idempotency_key, f"event:{case_id}", session, body, perform)
