"""Reviewable checklist progress and temporally honest annual fact reuse."""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import Field, StrictInt

from .db import transaction, fetch_record, insert_record, update_record, json_safe
from .models import ApiError, StrictModel
from .security import require_session, require_roles, Session
from .records import matches_reporting_period, physical_identity

router = APIRouter()


def farm_facts(conn, farm_id):
    fetch_record(conn, "farms", farm_id)
    return json_safe(conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
        "WHERE kind='facts' AND deleted_at IS NULL AND data->>'farm_id'=%s ORDER BY created_at,id LIMIT 10001", (farm_id,)).fetchall())


def bounded_facts(conn, farm_id):
    facts = farm_facts(conn, farm_id)
    if len(facts) > 10000:
        raise ApiError(422, "too_many_facts", "Narrow this farm's review before processing more than 10,000 facts.")
    return facts


class ChecklistStart(StrictModel):
    farm_id: str
    pack_id: str
    request_id: str | None = None
    deadline: date | None = None


@router.post("/checklists/from-pack")
def start_checklist(body: ChecklistStart, session: Session = Depends(require_session)):
    from .guidance import get_pack
    pack = get_pack(body.pack_id)
    if pack.get("capability") == "reference_only" or not pack.get("fields"):
        raise ApiError(422, "mapping_unavailable", "This pack contains reference guidance only; an evidence checklist mapping is not available.")
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", body.farm_id)
        if (pack.get("country") and farm["data"].get("country") != pack["country"]) or (pack.get("region") and farm["data"].get("region") != pack["region"]):
            raise ApiError(422, "jurisdiction_mismatch", "Choose a pack for this farm's country and region.")
        if body.request_id:
            request = fetch_record(conn, "requests", body.request_id)
            if request["data"].get("farm_id") != body.farm_id or request["data"].get("pack_id") != body.pack_id:
                raise ApiError(422, "request_mismatch", "Choose the request's own farm and reporting pack.")
        facts = bounded_facts(conn, body.farm_id)
        items = []
        for field in pack["fields"]:
            if not field.get("required"):
                continue
            candidates = [f for f in facts if f["data"].get("key") == field["key"]
                and f["data"].get("review_status") == "confirmed" and f["data"].get("value") is not None
                and matches_reporting_period(f["data"], pack["reporting_year"], basis=field.get("temporal_basis"), period=field.get("period"))]
            items.append({"key": field["key"], "label": field["label"], "official_field": field["official_field"],
                          "status": "review" if candidates else "missing", "candidate_fact_ids": [f["id"] for f in candidates],
                          "evidence_fact_ids": [], "required": True, "unit": field.get("unit"),
                          "temporal_basis": field.get("temporal_basis"), "period": field.get("period"),
                          "parcel_id": physical_identity(field)})
        return insert_record(conn, "checklists", {**body.model_dump(mode="json"), "title": pack.get("title", body.pack_id),
            "pack_version": pack["version"], "reporting_year": pack["reporting_year"], "items": items,
            "status": "review", "checks": pack["checks"], "limits": pack.get("limits", pack.get("limitations", [])),
            "meaning": "Evidence checklist completion does not establish regulatory compliance or CAP eligibility."})


class ItemReview(StrictModel):
    expected_revision: int = Field(ge=1)
    evidence_fact_ids: list[str] = Field(default_factory=list, max_length=100)
    note: str = Field(default="", max_length=4000)
    evidence_operation_ids: list[str] = Field(default_factory=list, max_length=100)
    evidence_document_ids: list[str] = Field(default_factory=list, max_length=100)
    evidence_purchase_ids: list[str] = Field(default_factory=list, max_length=100)
    evidence_sale_ids: list[str] = Field(default_factory=list, max_length=100)
    evidence_revisions: dict[str, StrictInt] = Field(default_factory=dict, max_length=500)
    review_acknowledged: bool = Field(default=False, strict=True)
    expected_input_fingerprint: str | None = Field(default=None, pattern="^[0-9a-f]{64}$")


def _year(data):
    supplied = data.get("reporting_year")
    if supplied is None and data.get("compliance_rule_id"):
        supplied = str(data.get("scheme", "")).rsplit(":", 1)[-1]
    try:
        year = int(supplied)
    except (ValueError, TypeError):
        raise ApiError(422, "checklist_period_required", "This checklist needs an explicit reporting year before reviewing evidence.") from None
    if not 1900 <= year <= 2200:
        raise ApiError(422, "checklist_period_required", "Choose a supported reporting year for this checklist.")
    return year


def _legacy_period(value, data, item):
    if value.get("temporal_basis") == "static":
        return matches_reporting_period(value, None, basis=item.get("temporal_basis"), period=item.get("period"))
    if data.get("reporting_year") is None:
        return False  # A manual checklist must state the target year for events.
    return matches_reporting_period(value, _year(data), basis=item.get("temporal_basis"), period=item.get("period"))


def _linked_tasks(conn, checklist):
    rows = json_safe(conn.execute("SELECT id,revision,data FROM records WHERE kind='tasks' AND deleted_at IS NULL "
        "AND data->>'checklist_id'=%s AND data->>'farm_id'=%s ORDER BY created_at,id LIMIT 1001",
        (checklist["id"], checklist["data"]["farm_id"])).fetchall())
    if len(rows) > 1000:
        raise ApiError(422, "too_many_linked_tasks", "Review this checklist's linked follow-ups before displaying more than 1,000 tasks.")
    return [{"id": row["id"], "revision": row["revision"], "title": row["data"].get("title", "Follow-up"),
             "status": row["data"].get("status", "open"), "checklist_item_key": row["data"].get("checklist_item_key")} for row in rows]


def _generated_review(conn, session, checklist, checked=None):
    from .compliance import check_farm, load_rules, _hash, _parcels, _source_issues, event_field_types, supporting_fact_matches_event
    data = checklist["data"]
    checked = checked or check_farm(conn, session, data["farm_id"], _year(data))
    parcels = _parcels(fetch_record(conn, "farms", data["farm_id"]))
    rule = next((r for r in checked["obligations"] if r["id"] == data["compliance_rule_id"]), None)
    definitions = load_rules()["rules"]
    definition = next((r for r in definitions if r["id"] == data["compliance_rule_id"]), None)
    field_types = event_field_types(definitions)
    input_ids = [r["id"] for r in checked["input_records"]]
    current_records = json_safe(conn.execute("SELECT id,kind,revision,data FROM records WHERE deleted_at IS NULL "
        "AND id=ANY(%s::uuid[]) ORDER BY id", (input_ids,)).fetchall())
    by_id = {r["id"]: r for r in current_records}
    events = [r for r in current_records if r["kind"] == "operations"]
    year = _year(data)
    contexts = []
    for item in data.get("items", []):
        check = item.get("check") if isinstance(item.get("check"), dict) else {}
        source_changed = not definition or check.get("rule_id") != data["compliance_rule_id"] or check.get("rule_hash") != _hash(definition)
        requirement = next((r for r in (rule or {}).get("requirements", []) if r["id"] == check.get("requirement_id")), None)
        requirement_definition = next((r for r in (definition or {}).get("requirements", []) if r.get("id") == check.get("requirement_id")), {})
        remaining = (requirement or {}).get("issues", []) if requirement else (rule or {}).get("issues", [])
        evidence = (requirement or {}).get("evidence", []) if requirement else (rule or {}).get("applicability_evidence", [])
        target_records = []
        kinds = {r["id"]: r["kind"] for r in checked["input_records"]}
        for identifier in check.get("record_ids", []):
            if identifier in kinds:
                target_records.append(fetch_record(conn, kinds[identifier], identifier))
        event_targets = [r for r in target_records if r["kind"] == "operations"]
        fact_targets = [r for r in target_records if r["kind"] == "facts"]
        anchor_missing = (bool(event_targets) and not any(r["data"].get("review_status") == "confirmed" for r in event_targets)
                          or any(identifier not in kinds for identifier in check.get("record_ids", [])))
        if event_targets or fact_targets:
            selected_evidence = []
            for summary in evidence:
                record = fetch_record(conn, summary["kind"], summary["id"])
                value = record["data"]
                matches = record["id"] in check.get("record_ids", [])
                if record["kind"] == "facts":
                    matches = matches or any(value.get("key") == target["data"].get("key")
                        and (value.get("period"), value.get("temporal_basis"), physical_identity(value)) ==
                        (target["data"].get("period"), target["data"].get("temporal_basis"), physical_identity(target["data"])) for target in fact_targets)
                    if event_targets:
                        matches = any(supporting_fact_matches_event(record, target, events, year,
                            period=target["data"].get("date"), field_types=field_types) for target in event_targets)
                if matches:
                    selected_evidence.append(summary)
            evidence = selected_evidence
        sound_evidence, source_integrity_issues = [], []
        for summary in evidence:
            record = fetch_record(conn, summary["kind"], summary["id"])
            source_issues = _source_issues(record, data["compliance_rule_id"], data["farm_id"], by_id,
                                          requirement_definition.get("source_required", False))
            if source_issues:
                source_integrity_issues.extend(source_issues)
            else:
                sound_evidence.append(summary)
        # A sound leaf document cannot stand in for a broken event/fact that
        # originally made that document relevant to this particular action.
        references = {e["id"]: e["kind"] for e in sound_evidence}
        for summary in sound_evidence:
            references.update((s["id"], s["kind"]) for s in summary.get("source_records", []))
        candidates = []
        for identifier, kind in sorted(references.items()):
            if kind not in ("facts", "operations", "purchases", "sales", "documents"):
                continue
            record = fetch_record(conn, kind, identifier)
            value = record["data"]
            if kind != "documents" and value.get("review_status") != "confirmed":
                continue
            if kind == "facts" and event_targets and not any(supporting_fact_matches_event(record, target, events, year,
                    period=target["data"].get("date"), field_types=field_types) for target in event_targets):
                continue
            source_issues = _source_issues(record, data["compliance_rule_id"], data["farm_id"], by_id,
                                          requirement_definition.get("source_required", False))
            if source_issues:
                source_integrity_issues.extend(source_issues)
                continue
            candidates.append({"id": record["id"], "kind": kind, "revision": record["revision"],
                               "label": value.get("label") or value.get("title") or value.get("filename") or value.get("product") or kind,
                               "value": value.get("value"), "unit": value.get("unit"), "date": value.get("date"), "period": value.get("period"),
                               "quantity": value.get("quantity"), "amount": value.get("amount"), "currency": value.get("currency"),
                               "temporal_basis": value.get("temporal_basis"), "parcel_id": physical_identity(value),
                               "parcel_label": parcels.get(physical_identity(value), {}).get("name"), "review_status": value.get("review_status")})
        code, message = check.get("issue_code"), check.get("issue_message")
        targets = set(check.get("record_ids", []))
        unresolved = [issue for issue in remaining if issue.get("code") == code
                      and (not message or issue.get("message") == message)
                      and (not targets or targets.intersection(issue.get("record_ids", [])))] if code else []
        if not code and check.get("mode") == "evidence":
            unresolved = [issue for issue in remaining if issue.get("severity") != "adviser"]
        if anchor_missing and check.get("mode") == "evidence":
            unresolved.append({"code": "event_context_changed", "message": "The original event was withdrawn or replaced. Refresh the checklist to review its replacement rather than completing it with a different event."})
        contexts.append({"key": item["key"], "mode": check.get("mode", "refresh_required"),
                         "can_complete": not source_changed and (check.get("mode") == "human_review" or not unresolved and bool(candidates)),
                         "issues": unresolved, "remaining_issues": remaining, "evidence": candidates,
                         "source_integrity_issues": list({_hash(issue): issue for issue in source_integrity_issues}.values()),
                         "expected_input_fingerprint": checked["input_fingerprint"], "source_changed": bool(source_changed),
                         "requires_refresh": bool(source_changed or anchor_missing and check.get("mode") == "evidence"),
                         "context_changed": any(next((r["revision"] for r in checked["input_records"] if r["id"] == identifier), None) != revision
                                                for identifier, revision in check.get("record_revisions", {}).items())})
    return {"checklist": checklist, "items": contexts, "linked_tasks": _linked_tasks(conn, checklist), "expected_input_fingerprint": checked["input_fingerprint"],
            "needs_refresh": any(item["requires_refresh"] for item in contexts), "citations": (rule or {}).get("citations", []),
            "notice": "Completing work records evidence review, not legal readiness. Unknown applicability and deadlines remain unresolved in farm checks."}


def _lock_checklist(conn, session, checklist_id, expected_revision):
    from .compliance import _locked_farm
    initial = fetch_record(conn, "checklists", checklist_id)
    farm = fetch_record(conn, "farms", initial["data"]["farm_id"])
    _locked_farm(conn, session, farm["id"], farm["revision"])
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='checklists' FOR UPDATE", (initial["id"],))
    current = fetch_record(conn, "checklists", initial["id"])
    if current["revision"] != expected_revision:
        raise ApiError(409, "revision_conflict", "This checklist changed. Load its current review before continuing.")
    return current


def _fresh_generated(conn, session, checklist):
    from .compliance import check_farm
    checked = check_farm(conn, session, checklist["data"]["farm_id"], _year(checklist["data"]))
    ids = [r["id"] for r in checked["input_records"]]
    conn.execute("SELECT id FROM records WHERE id=ANY(%s::uuid[]) ORDER BY id FOR SHARE", (ids,)).fetchall()
    return _generated_review(conn, session, checklist)


@router.get("/checklists/{checklist_id}/review")
def checklist_review(checklist_id: str, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        checklist = fetch_record(conn, "checklists", checklist_id)
        if checklist["data"].get("compliance_rule_id"):
            return _generated_review(conn, session, checklist)
        facts = bounded_facts(conn, checklist["data"]["farm_id"])
        from .compliance import _parcels
        parcels = _parcels(fetch_record(conn, "farms", checklist["data"]["farm_id"]))
        items = []
        for item in checklist["data"].get("items", []):
            candidates = [f for f in facts if f["data"].get("key") == item["key"] and f["data"].get("review_status") == "confirmed"
                          and f["data"].get("value") is not None and _legacy_period(f["data"], checklist["data"], item)
                          and (not item.get("unit") or f["data"].get("unit") == item["unit"])
                          and (item.get("parcel_id") is None or physical_identity(f["data"]) == item["parcel_id"])]
            items.append({"key": item["key"], "mode": "fact_evidence", "can_complete": bool(candidates), "issues": [],
                          "evidence": [{"id": f["id"], "kind": "facts", "revision": f["revision"], "label": f["data"].get("label", item["key"]),
                                        "parcel_id": physical_identity(f["data"]), "parcel_label": parcels.get(physical_identity(f["data"]), {}).get("name"),
                                        **{key: f["data"].get(key) for key in ("value", "unit", "period", "temporal_basis")}} for f in candidates], "source_changed": False})
        return {"checklist": checklist, "items": items, "linked_tasks": _linked_tasks(conn, checklist), "needs_refresh": False}


class ChecklistRefresh(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    expected_input_fingerprint: str = Field(pattern="^[0-9a-f]{64}$")


@router.post("/checklists/{checklist_id}/refresh")
def refresh_checklist(checklist_id: str, body: ChecklistRefresh, session: Session = Depends(require_session)):
    from .compliance import check_farm, checklist_items
    with transaction(session) as conn:
        checklist = _lock_checklist(conn, session, checklist_id, body.expected_revision)
        data = checklist["data"]
        if not data.get("compliance_rule_id"):
            raise ApiError(422, "generated_checklist_required", "Only generated source-backed actions use this refresh route.")
        current = _fresh_generated(conn, session, checklist)
        if current["expected_input_fingerprint"] != body.expected_input_fingerprint:
            raise ApiError(409, "checklist_context_changed", "Farm evidence changed. Read the current review before refreshing its actions.")
        checked = check_farm(conn, session, data["farm_id"], _year(data))
        rule = next((r for r in checked["obligations"] if r["id"] == data["compliance_rule_id"]), None)
        if rule is None:
            raise ApiError(409, "rule_unavailable", "This rule was removed. Retain the old review and ask which current source applies.")
        previous = {item["key"]: item for item in data.get("items", [])}
        items = checklist_items(checked, rule)
        keys = {item["key"] for item in items}
        tasks = json_safe(conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE kind='tasks' "
            "AND deleted_at IS NULL AND data->>'checklist_id'=%s ORDER BY id LIMIT 1001 FOR UPDATE", (checklist["id"],)).fetchall())
        if len(tasks) > 1000:
            raise ApiError(422, "too_many_linked_tasks", "Review this checklist's linked follow-ups before refreshing more than 1,000 tasks.")
        bound = set()
        for task in tasks:
            if task["data"].get("status") in ("done", "complete", "cancelled"):
                continue
            old_key = task["data"].get("checklist_item_key")
            if old_key is None:
                matches = [i for i in previous.values() if i.get("label") == task["data"].get("title")]
                old_key = matches[0]["key"] if len(matches) == 1 else None
            replacement = old_key if old_key in keys else None
            if replacement is None:
                # Retain obsolete follow-ups as explicit review work. Current
                # evidence issues remain separate canonical actions, not waived.
                replacement = "earlier-follow-ups"
                if replacement not in keys:
                    items.append({"key": replacement, "label": "Review earlier follow-ups against the current source checks", "done": False,
                                  "evidence_ids": [], "deadline": None, "note": "Record what still needs doing in the earlier tasks. Reviewing these tasks does not resolve the current evidence or legal questions.",
                                  "check": {"mode": "human_review", "rule_id": rule["id"], "rule_hash": items[0]["check"]["rule_hash"],
                                            "requirement_id": None, "issue_code": None, "issue_message": None, "record_ids": [], "record_revisions": {}}})
                    keys.add(replacement)
            bound.add(replacement)
            if task["data"].get("checklist_item_key") != replacement:
                update_record(conn, "tasks", task["id"], task["revision"], {**task["data"], "checklist_item_key": replacement,
                    "notes": str(task["data"].get("notes", "")) + "\nExplicit checklist refresh linked this follow-up to a current review step; the prior link remains in history."})
        if len(items) > 101:
            raise ApiError(422, "too_many_checklist_actions", "Narrow the current checks before refreshing more than 100 evidence actions and their earlier follow-ups.")
        provenance = {key: data.get(key) for key in ("compliance_rule_id", "compliance_version", "compliance_hash", "source_citations")}
        provenance.update(compliance_version=checked["rules_version"], compliance_hash=rule["fingerprint"], source_citations=rule["citations"])
        for item in items:
            if item["key"] not in bound:
                insert_record(conn, "tasks", {"farm_id": data["farm_id"], "title": item["label"], "description": item["note"],
                    "status": "open", "due_date": item["deadline"], "checklist_id": checklist["id"], "checklist_item_key": item["key"], **provenance})
        data.update(items=items, reporting_year=checked["year"], compliance_version=checked["rules_version"],
                    compliance_hash=rule["fingerprint"], source_citations=rule["citations"], status="review")
        return update_record(conn, "checklists", checklist["id"], checklist["revision"], data)


@router.post("/checklists/{checklist_id}/items/{key}/complete")
def complete_item(checklist_id: str, key: str, body: ItemReview, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        checklist = _lock_checklist(conn, session, checklist_id, body.expected_revision)
        data = checklist["data"]
        item = next((i for i in data.get("items", []) if i.get("key") == key), None)
        if not item:
            raise ApiError(404, "item_not_found", "This checklist item was not found.")
        if data.get("compliance_rule_id"):
            review = _fresh_generated(conn, session, checklist)
            context = next(r for r in review["items"] if r["key"] == key)
            if context["source_changed"]:
                raise ApiError(409, "checklist_source_changed", "Review and explicitly refresh this checklist's source definition before completing it.")
            if body.expected_input_fingerprint != review["expected_input_fingerprint"]:
                raise ApiError(409, "checklist_context_changed", "Evidence changed. Read the current action review before completing this step.")
            if not context["can_complete"]:
                raise ApiError(422, "checklist_issue_unresolved", "This particular evidence issue still needs correcting; selecting another event cannot resolve it.", {"issues": context["issues"]})
            if len(body.note.strip()) < 10:
                raise ApiError(422, "review_note_required", "Describe the evidence or source you actually reviewed.")
            selected = [(kind, identifier) for kind, identifiers in (("facts", body.evidence_fact_ids), ("operations", body.evidence_operation_ids), ("documents", body.evidence_document_ids), ("purchases", body.evidence_purchase_ids), ("sales", body.evidence_sale_ids)) for identifier in set(identifiers)]
            allowed = {(r["kind"], r["id"]): r for r in context["evidence"]}
            if context["mode"] == "human_review" and not body.review_acknowledged:
                raise ApiError(422, "explicit_review_required", "Explicitly acknowledge this source review. It does not establish legal readiness or a known deadline.")
            if context["mode"] == "evidence" and not selected:
                raise ApiError(422, "evidence_required", "Select the confirmed evidence that resolves this action.")
            for kind, identifier in selected:
                evidence = allowed.get((kind, identifier))
                if evidence is None or body.evidence_revisions.get(identifier) != evidence["revision"]:
                    raise ApiError(409, "evidence_context_changed", "Select this action's current eligible evidence and its displayed revision.")
            item.update(done=True, status="review_recorded" if context["mode"] == "human_review" else "evidence_reviewed",
                        evidence_ids=[identifier for kind, identifier in selected if kind == "documents"],
                        evidence_fact_ids=[identifier for kind, identifier in selected if kind == "facts"],
                        evidence_operation_ids=[identifier for kind, identifier in selected if kind == "operations"],
                        evidence_purchase_ids=[identifier for kind, identifier in selected if kind == "purchases"],
                        evidence_sale_ids=[identifier for kind, identifier in selected if kind == "sales"],
                        evidence_revisions={identifier: allowed[(kind, identifier)]["revision"] for kind, identifier in selected}, note=body.note, reviewed_by=session.user_id,
                        reviewed_at=datetime.now(timezone.utc).isoformat(), reviewed_input_fingerprint=review["expected_input_fingerprint"],
                        remaining_issues=context["remaining_issues"])
            data["status"] = "actions_reviewed" if all(i.get("done") is True for i in data["items"]) else "review"
            data["meaning"] = "Work review only; consult current farm checks. Unknown deadlines and applicability have not been certified or waived."
            return update_record(conn, "checklists", checklist["id"], checklist["revision"], data)
        if not body.evidence_fact_ids:
            raise ApiError(422, "evidence_required", "Select confirmed evidence before completing this required item.")
        if body.evidence_operation_ids or body.evidence_document_ids or body.evidence_purchase_ids or body.evidence_sale_ids:
            raise ApiError(422, "invalid_evidence", "This fact-evidence item needs confirmed facts, not an unrelated document or work record.")
        facts = [fetch_record(conn, "facts", fact_id) for fact_id in set(body.evidence_fact_ids)]
        for fact in facts:
            value = fact["data"]
            if value.get("farm_id") != data.get("farm_id") or value.get("key") != key or value.get("review_status") != "confirmed" or value.get("value") is None:
                raise ApiError(422, "invalid_evidence", "Use confirmed evidence for this field and farm.")
            if item.get("unit") and value.get("unit") != item["unit"]:
                raise ApiError(422, "wrong_unit", "Use evidence with the unit required by this pack field.")
            if item.get("temporal_basis") and value.get("temporal_basis") != item["temporal_basis"]:
                raise ApiError(422, "wrong_temporal_basis", "Use evidence with this field's required temporal basis.")
            if not _legacy_period(value, data, item):
                raise ApiError(422, "wrong_period", "This evidence belongs to another reporting period.")
            if item.get("parcel_id") is not None and physical_identity(value) != item["parcel_id"]:
                raise ApiError(422, "wrong_field", "Choose evidence for this checklist item's own field or site.")
        from .reconciliation import selected_fact_ids
        excluded = selected_fact_ids(conn, data["farm_id"])["excluded_fact_ids"]
        if any(f["id"] in excluded for f in facts):
            raise ApiError(422, "resolved_evidence_excluded", "Use the evidence selected by the current recorded source resolution.")
        groups = {(f["data"].get("period"), f["data"].get("temporal_basis"), physical_identity(f["data"])) for f in facts}
        competing = [f for f in bounded_facts(conn, data["farm_id"]) if f["data"].get("key") == key
            and f["data"].get("review_status") == "confirmed" and f["id"] not in excluded
            and (f["data"].get("period"), f["data"].get("temporal_basis"), physical_identity(f["data"])) in groups
            and any((other["data"].get("period"), other["data"].get("temporal_basis"), physical_identity(other["data"])) == (f["data"].get("period"), f["data"].get("temporal_basis"), physical_identity(f["data"]))
                    and (other["data"].get("value"), other["data"].get("unit")) != (f["data"].get("value"), f["data"].get("unit")) for other in facts)]
        if competing:
            raise ApiError(422, "resolution_required", "Record an explicit source resolution before completing conflicting evidence.", {"conflicting_fact_ids": [f["id"] for f in competing]})
        item.update(status="complete", done=True, evidence_fact_ids=[f["id"] for f in facts], note=body.note,
                    resolved_conflicting_fact_ids=[f["id"] for f in competing],
                    reviewed_by=str(session.user_id), reviewed_at=datetime.now(timezone.utc).isoformat())
        data["status"] = "complete" if all(i.get("status") == "complete" for i in data["items"] if i.get("required", True)) else "review"
        return update_record(conn, "checklists", checklist_id, body.expected_revision, data)


class TaskComplete(StrictModel):
    expected_revision: int = Field(ge=1)
    note: str = Field(min_length=1, max_length=4000)


def require_task_evidence(conn, data):
    """The same linked-action gate protects POST completion and generic PATCH."""
    if not data.get("checklist_id"):
        return
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':reconciliation:'||%s,0))", (str(data.get("farm_id")),))
    checklist = fetch_record(conn, "checklists", data["checklist_id"])
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='checklists' FOR SHARE", (checklist["id"],))
    if checklist["data"].get("farm_id") != data.get("farm_id"):
        raise ApiError(422, "task_checklist_mismatch", "Keep the task and its checklist in the same farm.")
    item_key = data.get("checklist_item_key")
    item = next((i for i in checklist["data"].get("items", []) if i.get("key") == item_key), None) if item_key else None
    if item_key and (not item or item.get("done") is not True):
        raise ApiError(422, "checklist_item_incomplete", "Review this task's linked checklist action before marking the task done.")
    if not item_key and checklist["data"].get("status") not in ("complete", "actions_reviewed"):
        raise ApiError(422, "checklist_incomplete", "Complete the linked evidence checklist first.")


@router.post("/tasks/{task_id}/complete")
def complete_task(task_id: str, body: TaskComplete, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        task = fetch_record(conn, "tasks", task_id)
        data = task["data"]
        require_task_evidence(conn, data)
        data.update(status="done", completion_note=body.note, completed_by=str(session.user_id),
                    completed_at=datetime.now(timezone.utc).isoformat())
        return update_record(conn, "tasks", task_id, body.expected_revision, data)


class PeriodCompare(StrictModel):
    farm_id: str
    from_period: str = Field(min_length=1, max_length=32)
    to_period: str = Field(min_length=1, max_length=32)


def period_comparison(facts, previous, current):
    keys = sorted({f["data"].get("key") for f in facts if isinstance(f["data"].get("key"), str)})
    result = []
    for key in keys:
        selected = [f for f in facts if f["data"].get("key") == key and f["data"].get("review_status") == "confirmed"]
        static = [f for f in selected if f["data"].get("temporal_basis") == "static"]
        before = [f for f in selected if f["data"].get("temporal_basis") != "static" and str(f["data"].get("period")) == previous]
        after = [f for f in selected if f["data"].get("temporal_basis") != "static" and str(f["data"].get("period")) == current]
        def values(items):
            return sorted(repr((f["data"].get("value"), f["data"].get("unit"), f["data"].get("temporal_basis"))) for f in items)
        state = "conflict" if len(set(values(before))) > 1 or len(set(values(after))) > 1 else "missing_current" if before and not after else "added" if after and not before else "unchanged" if values(before) == values(after) else "changed"
        result.append({"key": key, "status": "static_reference" if static and not before and not after else state,
                       "previous": before, "current": after, "static_references": static,
                       "static_warning": "Static source data is not a new annual observation." if static else None})
    return result


@router.post("/guidance/compare-periods")
def compare_periods(body: PeriodCompare, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return {"farm_id": body.farm_id, "from_period": body.from_period, "to_period": body.to_period,
                "items": period_comparison(bounded_facts(conn, body.farm_id), body.from_period, body.to_period)}


class CarryForward(PeriodCompare):
    fact_ids: list[str] = Field(max_length=200)


@router.post("/guidance/carry-forward")
def carry_forward(body: CarryForward, session: Session = Depends(require_session)):
    if body.from_period == body.to_period:
        raise ApiError(422, "same_period", "Choose a different target reporting period.")
    with transaction(session) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"carry-forward:{session.workspace_id}:{body.farm_id}:{body.to_period}",))
        facts = bounded_facts(conn, body.farm_id)
        chosen = [fetch_record(conn, "facts", fact_id) for fact_id in set(body.fact_ids)]
        references, proposals = [], []
        for fact in chosen:
            data = fact["data"]
            if data.get("farm_id") != body.farm_id or data.get("review_status") != "confirmed":
                raise ApiError(422, "invalid_reference", "Carry forward confirmed facts from this farm only.")
            if data.get("temporal_basis") == "static":
                references.append({"fact_id": fact["id"], "revision": fact["revision"], "source_created_at": fact["created_at"], "meaning": "Reused static reference; not observed in target year."})
                continue
            if data.get("temporal_basis") != "campaign_year" or str(data.get("period")) != body.from_period:
                raise ApiError(422, "unsupported_temporal_reuse", "Dated events cannot be copied as new observations. Choose a campaign-year fact from the previous period.")
            existing = [f for f in facts if f["data"].get("key") == data.get("key") and str(f["data"].get("period")) == body.to_period and f["data"].get("review_status") != "rejected"]
            if existing:
                raise ApiError(409, "target_fact_exists", "Review the existing target-period evidence instead of duplicating it.", {"fact_ids": [f["id"] for f in existing]})
            proposal = {**data, "period": body.to_period, "review_status": "proposed", "carry_forward": True,
                        "prior_fact_id": fact["id"], "prior_revision": fact["revision"], "source_created_at": fact["created_at"],
                        "review_note": "Prior-period value proposed for review; no new observation has been established."}
            proposal.pop("confirmed_by", None)
            proposal.pop("confirmed_at", None)
            created = insert_record(conn, "facts", proposal)
            proposals.append(created)
            facts.append(created)
        review = insert_record(conn, "annual_reviews", {**body.model_dump(), "static_references": references,
            "proposed_fact_ids": [p["id"] for p in proposals], "status": "review", "created_by": str(session.user_id)})
        return {"review": review, "static_references": references, "proposals": proposals}
