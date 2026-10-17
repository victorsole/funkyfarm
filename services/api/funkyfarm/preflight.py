"""Private, deterministic request preparation checks; never filing or acceptance."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from .compliance import check_farm
from .db import transaction
from .models import ApiError
from .reporting import CreateReport, _get, _prepare, _record_uuid, _records, canonical, get_pack, now
from .security import Session, require_session


router = APIRouter(tags=["request-checks"])


def _selection(value, maximum):
    if value is None:
        return None
    result = []
    for part in value.split(","):
        if not part.strip():
            continue
        try:
            record_id = str(UUID(part.strip()))
        except ValueError:
            raise ApiError(422, "selection_invalid", "Select valid workspace records for this check.")
        if record_id not in result:
            result.append(record_id)
    if len(result) > maximum:
        raise ApiError(422, "selection_limit", "Select fewer records for one request check.")
    return result


def _workflow(value):
    value = str(value or "").lower().replace("-", "_")
    if any(part in value for part in ("pesticide", "plant_protection", "crop_protection", "input", "ppp")):
        return "inputs"
    if any(part in value for part in ("sustain", "certif", "organic")):
        return "sustainability"
    if any(part in value for part in ("inspect", "inspection")):
        return "inspection"
    if any(part in value for part in ("expense", "purchase", "invoice", "account", "ledger", "sale")):
        return "expenses"
    if value.startswith("cap") or "eligibility" in value or "aid" in value:
        return "cap"
    if any(part in value for part in ("annual", "farm_summary", "farm_evidence", "animal", "food_feed", "traceability")):
        return "annual"
    return value


def _reference(value):
    if not isinstance(value, dict):
        return None
    result = {key: value[key] for key in ("title", "edition", "version", "document_id", "fact_id", "record_id", "record_kind") if value.get(key) is not None}
    url = value.get("url")
    if isinstance(url, str) and url.startswith("https://"):
        result["url"] = url
    return result or None


def _document_ids(data):
    result = set()
    if record_id := _record_uuid(data.get("document_id")):
        result.add(record_id)
    for source in data.get("sources", []):
        if isinstance(source, dict) and (record_id := _record_uuid(source.get("document_id"))):
            result.add(record_id)
    return result


def check_request(conn, session, request_id, *, fact_ids=None, document_ids=None, operation_ids=None):
    """Read current scoped inputs and return actions. Does not persist a draft."""
    request = _get(conn, "requests", request_id)
    data = request["data"]
    farm = _get(conn, "farms", data.get("farm_id"))
    farm_id = str(farm["id"])
    request_id = str(request["id"])
    request_url = f"/app/paperwork/{request_id}"
    farm_url = f"/app/farm/{farm_id}"
    issues = []

    def add(code, message, *, severity="error", field=None, fix_url=None, source=None):
        issue = {"code": str(code), "severity": severity, "field": field, "message": str(message), "fix_url": fix_url or request_url, "source": _reference(source)}
        for existing in issues:
            same = all(existing[key] == issue[key] for key in ("code", "message", "source"))
            if same and (existing["field"] == field or existing["field"] is None or field is None):
                if existing["field"] is None:
                    existing["field"] = field
                rank = {"warning": 0, "adviser": 1, "error": 2}
                if rank[severity] > rank[existing["severity"]]:
                    existing["severity"] = severity
                return
        issues.append(issue)

    explicit_documents = document_ids is not None
    if document_ids is None:
        attached = data.get("document_ids", [])
        document_ids = [record_id for item in (attached if isinstance(attached, list) else []) if (record_id := _record_uuid(item))]
        if document_id := _record_uuid(data.get("document_id")):
            document_ids.append(document_id)
    document_ids = list(dict.fromkeys(str(item) for item in document_ids))
    pack = None
    prepared = None
    year = data.get("reporting_year")
    if not isinstance(data.get("title"), str) or not data["title"].strip():
        add("request_purpose_missing", "Describe what the recipient is asking you to provide.", field="title")
    if not isinstance(data.get("recipient"), str) or not data["recipient"].strip():
        add("recipient_missing", "Name the recipient before preparing the response.", field="recipient")
    farm_country = farm["data"].get("country")
    request_country = data.get("country")
    if farm_country and request_country and str(farm_country).casefold() != str(request_country).casefold():
        add("request_country_mismatch", "The request country differs from this farm's country. Confirm the farm and jurisdiction before preparing the response.", field="country")
    if not isinstance(year, int) or isinstance(year, bool) or not 2000 <= year <= 2200:
        add("reporting_year", "Choose the reporting year requested by the recipient.", field="reporting_year")
    if not data.get("pack_id"):
        add("pack_missing", "Choose the response format requested by the recipient.", field="pack_id")
    else:
        try:
            pack = get_pack(data["pack_id"])
        except ApiError as error:
            add(error.code, error.message, field="pack_id")
    if pack is not None and isinstance(year, int) and not isinstance(year, bool) and 2000 <= year <= 2200:
        try:
            body = CreateReport(farm_id=farm_id, request_id=request_id, pack_id=data["pack_id"], reporting_year=year, fact_ids=fact_ids, selected_document_ids=document_ids, operation_ids=operation_ids or [])
            prepared = _prepare(conn, body, session)
        except ApiError as error:
            if error.code == "pack_region":
                field = "pack_id" if farm["data"].get("region") else "region"
            elif error.code == "request_region":
                field = "region"
            else:
                field = "pack_id" if error.code.startswith("pack_") else None
            fact_id = (error.details or {}).get("fact_id")
            source = {"title": "Farm answer requiring source review", "fact_id": fact_id} if fact_id else None
            fix_url = farm_url + f"#fact-{fact_id}" if fact_id else farm_url if error.code == "pack_region" and field == "region" else request_url
            if operation_id := (error.details or {}).get("operation_id"):
                source = {"title": "Farm application requiring review", "record_id": operation_id, "record_kind": "operations"}
                fix_url = request_url + f"?journal_operation_id={operation_id}"
            add(error.code, error.message, field=field, fix_url=fix_url, source=source)
        if prepared:
            for blocker in prepared["blockers"]:
                source = None
                fix_url = request_url + "#questions"
                if blocker.get("document_id"):
                    source = {"title": "Selected supporting document", "document_id": blocker["document_id"]}
                    fix_url = f"/app/documents/{blocker['document_id']}"
                elif blocker.get("fact_id"):
                    source = {"title": "Farm answer and its source", "fact_id": blocker["fact_id"]}
                    fix_url = farm_url + f"#fact-{blocker['fact_id']}"
                elif blocker.get("operation_id"):
                    source = {"title": "Farm activity", "record_id": blocker["operation_id"], "record_kind": "operations"}
                    fix_url = request_url + f"?journal_operation_id={blocker['operation_id']}"
                elif blocker.get("record_id"):
                    source = {"title": "Source farm record", "record_id": blocker["record_id"], "record_kind": blocker.get("record_kind")}
                    fix_url = farm_url
                elif blocker["code"] in ("stale_context", "unresolved_conflict", "reconciliation_changed"):
                    fix_url = farm_url
                add(blocker["code"], blocker["message"], field=blocker.get("field"), fix_url=fix_url, source=source)
    selected_facts = prepared["snapshot"]["facts"] if prepared else []
    documents = []
    for document_id in document_ids:
        row = conn.execute("SELECT kind FROM records WHERE id=%s", (document_id,)).fetchone()
        if row is None or row["kind"] != "documents":
            add("document_unavailable", "A selected document is no longer available. Choose its replacement.", field="documents", fix_url="/app/documents")
            continue
        document = _get(conn, "documents", document_id)
        if document["data"].get("farm_id") not in (None, "", farm_id):
            add("evidence_farm", "Select documents belonging to this farm.", field="documents", fix_url="/app/documents")
            continue
        documents.append(document)
    # A fact's retained source revision can predate the newly prepared draft.
    # Compare that explicit reference with the current scoped record as well.
    for retained in selected_facts:
        fact = _get(conn, "facts", retained["id"])
        for source in fact["data"].get("sources", []):
            if not isinstance(source, dict) or source.get("revision") is None:
                continue
            source_id = _record_uuid(source.get("record_id")) or _record_uuid(source.get("document_id"))
            if not source_id:
                continue
            current = conn.execute("SELECT kind,revision FROM records WHERE id=%s", (source_id,)).fetchone()
            if current is None or current["revision"] != source["revision"]:
                add("source_revision_changed", "A source was revised after this answer was recorded. Review the answer against the current source.", field=fact["data"].get("key"), fix_url=farm_url + f"#fact-{fact['id']}", source={"title": "Answer with an earlier source revision", "fact_id": fact["id"]})
    hashes = defaultdict(list)
    for document in documents:
        if document["data"].get("sha256"):
            hashes[document["data"]["sha256"]].append(document)
    for same_content in hashes.values():
        if len(same_content) > 1:
            add("possible_duplicate_document", "Two selected documents have identical contents. Review whether the response needs both copies.", severity="warning", field="documents", fix_url="/app/documents", source={"title": "Possible repeated document", "document_id": same_content[0]["id"]})
    workflow = _workflow((pack or {}).get("workflow_id", data.get("pack_id")))
    compliance = check_farm(conn, session, farm_id, year=year) if isinstance(year, int) and not isinstance(year, bool) and 2000 <= year <= 2200 else {"obligations": [], "issues": [], "limits": ["Choose the reporting year before checking applicable obligations."]}
    obligations = [item for item in compliance.get("obligations", []) if _workflow(item.get("workflow_id")) == workflow]
    relevant_rules = {str(item.get("id")) for item in obligations}
    obligation_status = {str(item.get("id")): item.get("status") for item in obligations}
    references = {str(item.get("id")): next((source for source in item.get("citations", []) if isinstance(source, dict)), None) for item in obligations}
    for issue in compliance.get("issues", []):
        if issue.get("rule_id") is not None and str(issue["rule_id"]) not in relevant_rules:
            continue
        severity = issue.get("severity", "warning")
        if severity in ("adviser", "needs_adviser"):
            severity = "adviser"
        elif severity in ("error", "blocking", "needs_information"):
            severity = "error" if obligation_status.get(str(issue.get("rule_id"))) == "needs_information" else "adviser"
        else:
            severity = "warning"
        href = issue.get("href")
        add(issue.get("code", "farm_check"), issue.get("message", "Review the farm information used by this request."), severity=severity, fix_url=href if isinstance(href, str) and href.startswith("/app/") else farm_url, source=references.get(str(issue.get("rule_id"))))
    for obligation in obligations:
        if obligation.get("applicability") == "does_not_apply":
            continue
        for requirement in obligation.get("requirements", []):
            field = requirement.get("id")
            raw_issues = requirement.get("issues", [])
            for item in raw_issues:
                item = item if isinstance(item, dict) else {"message": str(item)}
                severity = item.get("severity", "error")
                if severity in ("warning", "info"):
                    severity = "warning"
                elif severity in ("adviser", "needs_adviser"):
                    severity = "adviser"
                else:
                    severity = "error" if requirement.get("status") in ("needs_information", "missing") or obligation.get("status") == "needs_information" else "adviser"
                add(item.get("code", "obligation_requirement"), item.get("message", f"Review {requirement.get('label', 'the required evidence')}."), severity=severity, field=field, fix_url=farm_url, source=references.get(str(obligation.get("id"))))
            if not raw_issues and requirement.get("status") in ("needs_information", "missing"):
                add("obligation_information", f"Provide or review {requirement.get('label', 'the information required by this obligation')}.", field=field, fix_url=farm_url, source=references.get(str(obligation.get("id"))))
            if requirement.get("status") in ("needs_adviser", "unresolved", "failed"):
                add("adviser_evidence_review", f"Ask an adviser to review {requirement.get('label', 'this required evidence')}.", severity="adviser", field=field, fix_url=f"/app/advisers?farm_id={farm_id}", source=references.get(str(obligation.get("id"))))
        if obligation.get("applicability") in ("unknown", "conflict"):
            add("applicability_unresolved", f"Review whether {obligation.get('title', 'the selected obligation')} applies to this farm.", field="applicability", fix_url=farm_url, source=references.get(str(obligation.get("id"))))
        if obligation.get("status") == "needs_adviser":
            add("adviser_review", f"An adviser needs to review {obligation.get('title', 'this obligation')} before you rely on the result.", severity="adviser", fix_url=f"/app/advisers?farm_id={farm_id}", source=references.get(str(obligation.get("id"))))
    capability = (pack or {}).get("capability")
    if capability == "reference_only":
        add("mapping_unavailable", "This pack provides references rather than a verified national form mapping. Ask an adviser which format the recipient needs.", severity="adviser", field="pack_id", fix_url=f"/app/advisers?farm_id={farm_id}", source=next((source for source in pack.get("sources", []) if isinstance(source, dict)), None))
    elif capability == "generic_dossier":
        add("general_dossier", "This is a general evidence dossier. Compare it with the recipient's requested format before delivery.", severity="warning", field="pack_id")
    purchases = _records(conn, "purchases", farm_id)
    relevant_purchase_ids = {record_id for record_id, state in (prepared or {}).get("validation_sources", {}).get("records", {}).items() if state["kind"] == "purchases"}
    selected_documents = set(document_ids)
    receipt_entries = defaultdict(list)
    for purchase in purchases:
        purchase_data = purchase["data"]
        if purchase_data.get("review_status") == "rejected":
            continue
        source_documents = _document_ids(purchase_data)
        purchase_date = purchase_data.get("date")
        in_year = False
        if isinstance(purchase_date, str):
            try:
                in_year = date.fromisoformat(purchase_date).year == year
            except ValueError:
                pass
        relevant = purchase["id"] in relevant_purchase_ids or bool(source_documents & selected_documents) or workflow == "expenses" and in_year
        if not relevant or not (source_documents or purchase_data.get("invoice_number") or purchase_data.get("external_id")):
            continue
        business_values = {key: value for key, value in purchase_data.items() if key not in ("farm_id", "document_id", "sources", "origin", "review_status", "review_note", "reviewed_at", "reviewed_by", "confirmed_at", "confirmed_by", "note", "notes", "supersedes_id", "superseded_by")}
        signature = canonical([sorted(source_documents), business_values])
        receipt_entries[signature].append(purchase)
    for entries in receipt_entries.values():
        if len(entries) > 1:
            add("possible_duplicate_receipt", "Multiple ledger entries have matching receipt details. Review them before reusing any totals; separate line items may be valid.", severity="warning", field="purchases", fix_url=farm_url, source={"title": "Receipt ledger entry to review", "record_id": entries[0]["id"], "record_kind": "purchases"})
    if workflow == "inputs" and relevant_purchase_ids:
        add("purchase_is_not_use", "A receipt records acquisition, not application. Confirm the separate activity or reviewed farm log showing what was actually used.", severity="warning", field="operations", fix_url=farm_url)
    deadline = data.get("deadline")
    if isinstance(deadline, str):
        try:
            if date.fromisoformat(deadline) < date.today() and data.get("status") != "responded":
                add("request_deadline_passed", "The recorded response deadline has passed. Check the recipient's instructions for the next action.", severity="adviser", field="deadline", fix_url=request_url)
        except ValueError:
            add("request_deadline_invalid", "Check the response date in the original request.", field="deadline")
    duplicate_codes = {"possible_duplicate_document", "possible_duplicate_receipt"}
    needs_information = any(issue["severity"] == "error" for issue in issues)
    needs_adviser = any(issue["severity"] == "adviser" for issue in issues)
    status = "needs_information" if needs_information else "needs_adviser" if needs_adviser else "ready_for_review"
    answer_codes = {"missing_fact", "missing_requirement", "wrong_unit", "wrong_temporal_basis", "requirement_unit", "requirement_temporal_basis", "requirement_period", "unreviewed_fact", "wrong_period", "no_facts"}
    evidence_codes = {"missing_evidence", "source_unavailable", "source_revision_changed", "source_kind_mismatch", "document_unavailable", "possible_duplicate_document", "possible_duplicate_receipt", "stale_source_record", "unreviewed_source_record"}
    steps = [
        {"id": "scope", "label": "Confirm the recipient, country, region, period and response format", "status": "pending" if any(issue["field"] in ("title", "recipient", "pack_id", "country", "region", "reporting_year") and issue["severity"] == "error" for issue in issues) else "complete", "fix_url": request_url},
        {"id": "answers", "label": "Review the required farm answers and their exact units and dates", "status": "pending" if any(issue["code"] in answer_codes for issue in issues) else "complete", "fix_url": request_url + "#questions"},
        {"id": "evidence", "label": "Check the selected evidence, source revisions and repeated receipts", "status": "pending" if any(issue["code"] in evidence_codes and issue["severity"] == "error" for issue in issues) else "review" if any(issue["code"] in duplicate_codes for issue in issues) else "complete", "fix_url": "/app/documents"},
        {"id": "applicability", "label": "Review applicable obligations and unresolved adviser questions", "status": "review" if needs_adviser else "pending" if any(issue["field"] == "applicability" for issue in issues) else "complete", "fix_url": f"/app/advisers?farm_id={farm_id}"},
        {"id": "human_approval", "label": "Prepare the response preview and explicitly approve that version", "status": "review", "fix_url": request_url},
    ]
    return {"request_id": request_id, "request_revision": request["revision"], "status": status, "issues": issues, "steps": steps, "checked_at": now(),
        "scope": {"farm_id": farm_id, "country": farm["data"].get("country"), "region": farm["data"].get("region"), "reporting_year": year, "pack_id": data.get("pack_id")},
        "selection": {"fact_ids": [fact["id"] for fact in selected_facts], "document_ids": document_ids,
            "operation_ids": list(dict.fromkeys(str(item) for item in (operation_ids or []))), "documents_origin": "explicit" if explicit_documents else "request_attachments"},
        "compliance": {key: compliance.get(key) for key in ("rules_version", "rules_hash", "input_fingerprint", "limits")},
        "notice": "Preparation checks only. Ready for review does not establish legal compliance, eligibility, filing or authority acceptance. A report still needs an explicit review and approval; checking attached documents does not share them."}


@router.get("/requests/{request_id}/checks")
def request_checks(request_id: UUID, selected_fact_ids: str | None = Query(default=None, max_length=190000), selected_document_ids: str | None = Query(default=None, max_length=10000), selected_operation_ids: str | None = Query(default=None, max_length=38000), session: Session = Depends(require_session)):
    fact_ids = _selection(selected_fact_ids, 5000)
    document_ids = _selection(selected_document_ids, 250)
    operation_ids = _selection(selected_operation_ids, 1000)
    with transaction(session) as conn:
        return check_request(conn, session, str(request_id), fact_ids=fact_ids, document_ids=document_ids, operation_ids=operation_ids)
