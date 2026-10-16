"""Reviewable checklist progress and temporally honest annual fact reuse."""

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import Field

from .db import transaction, fetch_record, insert_record, update_record, json_safe
from .models import ApiError, StrictModel
from .security import require_session, Session

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
                and (f["data"].get("temporal_basis") == "static" or str(f["data"].get("period")) == str(pack["reporting_year"]))]
            items.append({"key": field["key"], "label": field["label"], "official_field": field["official_field"],
                          "status": "review" if candidates else "missing", "candidate_fact_ids": [f["id"] for f in candidates],
                          "evidence_fact_ids": [], "required": True, "unit": field.get("unit"),
                          "temporal_basis": field.get("temporal_basis")})
        return insert_record(conn, "checklists", {**body.model_dump(mode="json"), "title": pack.get("title", body.pack_id),
            "pack_version": pack["version"], "reporting_year": pack["reporting_year"], "items": items,
            "status": "review", "checks": pack["checks"], "limits": pack.get("limits", pack.get("limitations", [])),
            "meaning": "Evidence checklist completion does not establish regulatory compliance or CAP eligibility."})


class ItemReview(StrictModel):
    expected_revision: int = Field(ge=1)
    evidence_fact_ids: list[str] = Field(default_factory=list, max_length=100)
    note: str = Field(default="", max_length=4000)


@router.post("/checklists/{checklist_id}/items/{key}/complete")
def complete_item(checklist_id: str, key: str, body: ItemReview, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        checklist = fetch_record(conn, "checklists", checklist_id)
        data = checklist["data"]
        item = next((i for i in data.get("items", []) if i.get("key") == key), None)
        if not item:
            raise ApiError(404, "item_not_found", "This checklist item was not found.")
        if not body.evidence_fact_ids:
            raise ApiError(422, "evidence_required", "Select confirmed evidence before completing this required item.")
        facts = [fetch_record(conn, "facts", fact_id) for fact_id in set(body.evidence_fact_ids)]
        for fact in facts:
            value = fact["data"]
            if value.get("farm_id") != data.get("farm_id") or value.get("key") != key or value.get("review_status") != "confirmed" or value.get("value") is None:
                raise ApiError(422, "invalid_evidence", "Use confirmed evidence for this field and farm.")
            if item.get("unit") and value.get("unit") != item["unit"]:
                raise ApiError(422, "wrong_unit", "Use evidence with the unit required by this pack field.")
            if item.get("temporal_basis") and value.get("temporal_basis") != item["temporal_basis"]:
                raise ApiError(422, "wrong_temporal_basis", "Use evidence with this field's required temporal basis.")
            if value.get("temporal_basis") != "static" and str(value.get("period")) != str(data.get("reporting_year")):
                raise ApiError(422, "wrong_period", "This evidence belongs to another reporting period.")
        if len({repr((f["data"].get("value"), f["data"].get("unit"))) for f in facts}) > 1:
            raise ApiError(422, "conflicting_evidence", "Resolve differing evidence before completing the item.")
        competing = [f for f in bounded_facts(conn, data["farm_id"]) if f["data"].get("key") == key
            and f["data"].get("review_status") == "confirmed"
            and (f["data"].get("temporal_basis") == "static" or str(f["data"].get("period")) == str(data.get("reporting_year")))
            and (f["data"].get("value"), f["data"].get("unit")) != (facts[0]["data"].get("value"), facts[0]["data"].get("unit"))]
        if competing and len(body.note.strip()) < 10:
            raise ApiError(422, "resolution_required", "Explain why the selected evidence resolves the conflicting records.", {"conflicting_fact_ids": [f["id"] for f in competing]})
        item.update(status="complete", evidence_fact_ids=[f["id"] for f in facts], note=body.note,
                    resolved_conflicting_fact_ids=[f["id"] for f in competing],
                    reviewed_by=str(session.user_id), reviewed_at=datetime.now(timezone.utc).isoformat())
        data["status"] = "complete" if all(i.get("status") == "complete" for i in data["items"] if i.get("required")) else "review"
        return update_record(conn, "checklists", checklist_id, body.expected_revision, data)


class TaskComplete(StrictModel):
    expected_revision: int = Field(ge=1)
    note: str = Field(min_length=1, max_length=4000)


@router.post("/tasks/{task_id}/complete")
def complete_task(task_id: str, body: TaskComplete, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        task = fetch_record(conn, "tasks", task_id)
        data = task["data"]
        if data.get("checklist_id"):
            checklist = fetch_record(conn, "checklists", data["checklist_id"])
            if checklist["data"].get("status") != "complete":
                raise ApiError(422, "checklist_incomplete", "Complete the linked evidence checklist first.")
        data.update(status="complete", completion_note=body.note, completed_by=str(session.user_id),
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
