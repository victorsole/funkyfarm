"""An explicitly fictional CAP correction, using the real private draft workflow."""

from copy import deepcopy
from datetime import datetime, timezone
import json
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header
from pydantic import Field

from .admin_cases import CreateCase, _audit, _checks, _save, create_case_draft
from .db import fetch_record, idempotent, insert_record, transaction
from .fields import Proposal, create_proposal_in_transaction, validate_geometry
from .models import ApiError, StrictModel
from .records import validate_data
from .security import Session, require_roles, require_session

router = APIRouter(prefix="/examples/cap", tags=["fictional CAP example"])
SCENARIO_ID = "cap-correction-v1"
NOTICE = "FICTIONAL TRAINING EXAMPLE. These authored outlines, claim, notice and sample records do not describe a real farmer, LPIS entry, ownership, eligible area or satellite observation. No claim or correction has been sent."
CLAIMED = {"type": "Polygon", "coordinates": [[[5.8200, 52.4500], [5.8230, 52.4500], [5.8230, 52.4520], [5.8200, 52.4520], [5.8200, 52.4500]]]}
REFERENCE = {"type": "Polygon", "coordinates": [[[5.8200, 52.4500], [5.8226, 52.4500], [5.8226, 52.4520], [5.8200, 52.4520], [5.8200, 52.4500]]]}
ITEMS = [
    {"key": "boundary", "kind": "action", "title": "Check the claimed boundary and choose a correction",
     "description": "Compare the authored original claim with the supplied fictional reference. Open the real private field proposal, review its change and decide explicitly. A private correction does not update official LPIS."},
    {"key": "land_use", "kind": "requested_record", "title": "Attach the requested land-use record",
     "description": "The fictional notice requests a land-use record. An outline does not establish a right to claim. Download the clearly fictional sample if useful, then explicitly upload and review it as training evidence; real cases require the actual record."},
    {"key": "commitment", "kind": "requested_record", "title": "Attach the commitment record and review the protected-area note",
     "description": "The fictional notice mentions a protected-area attribute and asks for a commitment record. This invented flag is not a verified designation and is not automatic ineligibility. Review the applicable terms; the sample is not legal evidence."},
]


class StartExample(StrictModel):
    acknowledged: bool = Field(strict=True)


def _interactive(session):
    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Open the signed-in application to use the fictional CAP example.")


def _owner_access(conn, session, farm):
    require_roles(session, "owner")
    if not conn.execute("SELECT record_access(%s,'farms',%s::jsonb,true) AS allowed",
        (farm["id"], json.dumps(farm["data"]))).fetchone()["allowed"]:
        raise ApiError(403, "cap_demo_access_denied", "Your current workspace grant cannot create or reopen this example farm.")


def _scenario(item_ids):
    sample_notice = "FICTIONAL TRAINING SAMPLE ONLY. Not a real land-use agreement, commitment or authority record. Upload only through an explicit training action; real cases require actual originals."
    return {"id": SCENARIO_ID, "title": "A fictional Dutch CAP correction and inspection folder", "notice": NOTICE,
        "claimed_geometry": deepcopy(CLAIMED), "claimed_label": "Authored original claimed outline — fictional",
        "reference_geometry": deepcopy(REFERENCE), "reference_label": "Authored comparison outline — fictional, not LPIS",
        "reference_year": 2026, "fictional_notice_date": "2026-10-01", "fictional_deadline": "2026-10-30",
        "original_reference": "FICTIONAL-CAP-2026-001",
        "items": [{**deepcopy(item), "id": item_ids[item["key"]]} for item in ITEMS],
        "samples": [
            {"id": "land-use", "title": "Fictional land-use record", "filename": "FICTIONAL-land-use-record-2026.txt", "mime_type": "text/plain",
             "notice": sample_notice, "contents": "FICTIONAL TRAINING SAMPLE — NOT REAL EVIDENCE\nScenario: cap-correction-v1\nHolding: Fictional Dutch smallholding\nField: Fictional meadow A\nExample period: 2026\nThis authored example describes a fictional permission to use the example field. It establishes no actual right, owner, tenant, land registration or entitlement. A real case needs the actual land-use record and its terms.\n"},
            {"id": "commitment", "title": "Fictional commitment record", "filename": "FICTIONAL-commitment-record-2026.txt", "mime_type": "text/plain",
             "notice": sample_notice, "contents": "FICTIONAL TRAINING SAMPLE — NOT REAL EVIDENCE\nScenario: cap-correction-v1\nHolding: Fictional Dutch smallholding\nExample period: 2026\nInvented training commitment: retain the example grass cover. The mock notice's protected-area note is not an actual designation, a payment condition or an automatic eligibility decision. Real cases need the actual commitment and applicable national and scheme terms.\n"},
        ],
        "deadline_notice": "The date comes only from the labelled fictional notice. It is not a universal legal clock; use the actual recipient's notice and applicable process in a real case.",
        "funding_notice": "REA AGRIP promotion funding is separate guidance for qualifying organisations, not this farmer's CAP claim. The 2026 call closed on 23 April 2026.",
    }


def _linked(conn, kind, record_id, farm_id):
    record = fetch_record(conn, kind, str(record_id))
    if record["data"].get("farm_id") != farm_id:
        raise ApiError(409, "cap_demo_unavailable", "A retained example link no longer belongs to its example farm. No replacement example was created.")
    return record


def _view(conn, run_id):
    run = fetch_record(conn, "cap_demo_runs", str(run_id))
    data = run["data"]
    if data.get("scenario_id") != SCENARIO_ID:
        raise ApiError(404, "not_found", "This example run was not found.")
    farm = fetch_record(conn, "farms", data["farm_id"])
    case = _linked(conn, "admin_cases", data["case_id"], farm["id"])
    proposal = _linked(conn, "field_change_proposals", data["proposal_id"], farm["id"])
    for key in ("original_claim_task_id", "notice_task_id"):
        _linked(conn, "tasks", data[key], farm["id"])
    if case["data"].get("job_type") != "correction" or case["data"].get("reporting_year") != 2026:
        raise ApiError(409, "cap_demo_unavailable", "The saved case no longer matches this example. No replacement example was created.")
    checked = _checks(conn, case)[0]
    current_items = {item["id"]: item for item in case["data"]["items"]}
    if any(identifier not in current_items for identifier in data["item_ids"].values()):
        raise ApiError(409, "cap_demo_unavailable", "An original example item is unavailable. No replacement example was created.")
    case_href = f"/app/cases/{case['id']}"
    steps = []
    for definition in ITEMS:
        item = current_items[data["item_ids"][definition["key"]]]
        href = (f"/app/fields/{farm['id']}?proposal_id={proposal['id']}&expected_revision={proposal['revision']}#boundaries-{farm['id']}"
            if definition["key"] == "boundary" else case_href + f"#item-{item['id']}")
        steps.append({"key": definition["key"], "title": definition["title"], "status": item["status"], "href": href})
    items = list(current_items.values())
    review = case["data"].get("review") or {}
    progress = {"case_status": case["data"]["status"], "proposal_status": proposal["data"]["status"], "total_items": len(items),
        "resolved_items": sum(item["status"] == "resolved" for item in items), "cancelled_items": sum(item["status"] == "cancelled" for item in items),
        "open_items": sum(item["status"] not in {"resolved", "cancelled"} for item in items),
        "can_review": checked["can_review"] and case["data"]["status"] in {"draft", "needs_changes"},
        "review_current": case["data"]["status"] == "ready_to_send" and checked["can_review"] and review.get("fingerprint") == checked["fingerprint"],
        "next_action": checked["next_action"], "steps": steps, "notice": "App preparation progress only. External events remain manually recorded; these counts do not establish eligibility, filing or authority acceptance."}
    return {"run_id": run["id"], "farm": farm, "case": case, "proposal": proposal,
        "scenario": deepcopy(data["scenario"]), "checks": checked, "progress": progress}


def _seed(conn, session):
    # Serialize different owners and different retry keys for this one scenario.
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:cap-example:{SCENARIO_ID}",))
    existing = conn.execute("SELECT id FROM records WHERE kind='cap_demo_runs' AND deleted_at IS NULL AND data->>'scenario_id'=%s ORDER BY created_at,id LIMIT 2", (SCENARIO_ID,)).fetchall()
    if existing:
        if len(existing) != 1:
            raise ApiError(409, "cap_demo_unavailable", "More than one saved example exists. No additional example was created.")
        result = _view(conn, existing[0]["id"])
        _owner_access(conn, session, result["farm"])
        return {"run_id": result["run_id"]}
    parcel_id = str(uuid4())
    farm_data = validate_data(conn, "farms", {"name": "FICTIONAL Dutch smallholding", "country": "NL", "region": None,
        "reporting_year": 2026, "farm_type": "mixed", "origin": "fictional_cap_demo",
        "notes": NOTICE, "parcels": [{"id": parcel_id, "name": "FICTIONAL meadow A", "crop": "Grass — fictional example",
            "geometry": validate_geometry(deepcopy(CLAIMED)), "external_id": None, "revision": 1, "active": True, "notes": NOTICE}]})
    _owner_access(conn, session, {"id": str(uuid4()), "data": farm_data})
    farm = insert_record(conn, "farms", farm_data)
    original = insert_record(conn, "tasks", validate_data(conn, "tasks", {"farm_id": farm["id"], "title": "FICTIONAL original CAP claim — training record",
        "description": "FICTIONAL-CAP-2026-001. Authored original-claim context dated 20 May 2026 for this tutorial only. No actual claim, submission or receipt exists.", "status": "open", "notes": NOTICE}))
    notice = insert_record(conn, "tasks", validate_data(conn, "tasks", {"farm_id": farm["id"], "title": "FICTIONAL notice dated 1 October 2026",
        "description": "Authored mock notice requests: compare the example boundary, provide a land-use record, and provide a commitment record while reviewing an invented protected-area note. Its example date is 30 October 2026; it does not establish a universal legal deadline or an actual authority demand.",
        "due_date": "2026-10-30", "status": "open", "notes": NOTICE}))
    proposal = create_proposal_in_transaction(conn, farm["id"], Proposal(expected_revision=farm["revision"],
        parcel={"id": parcel_id, "name": "FICTIONAL meadow A", "geometry": deepcopy(REFERENCE), "crop": "Grass — fictional example", "external_id": None, "notes": NOTICE},
        reference={"geometry": deepcopy(REFERENCE), "source": "Authored fictional comparison only; not LPIS or a satellite observation", "year": 2026},
        note="FICTIONAL training correction: compare the claimed east edge with the smaller authored reference. A private edit is not an official CAP or LPIS update."), session)
    case = create_case_draft(conn, session, CreateCase(farm_id=farm["id"], title="FICTIONAL CAP correction and inspection folder",
        job_type="correction", reporting_year=2026, authority="FICTIONAL reviewer — no actual authority notice", scheme="FICTIONAL CAP training example",
        deadline="2026-10-30", original_reference="FICTIONAL-CAP-2026-001", original_submitted_at="2026-05-20",
        reason="FICTIONAL training correction: review the boundary difference and supply the requested land-use and commitment records. No real application or authority decision is represented.",
        references=[{"kind": "tasks", "id": original["id"], "revision": original["revision"], "role": "original"},
            {"kind": "tasks", "id": notice["id"], "revision": notice["revision"], "role": "notice"},
            {"kind": "field_change_proposals", "id": proposal["id"], "revision": proposal["revision"], "role": "change"}]))
    item_ids = {item["key"]: str(uuid4()) for item in ITEMS}
    entries = [{"id": item_ids[item["key"]], "kind": item["kind"], "title": item["title"], "description": item["description"],
        "due_date": "2026-10-30", "status": "open", "document_pins": []} for item in ITEMS]
    case = _save(conn, case, {**case["data"], "items": entries})
    for entry in entries:
        _audit(conn, case, session, "item_added", item=entry)
    run = insert_record(conn, "cap_demo_runs", {"farm_id": farm["id"], "scenario_id": SCENARIO_ID, "reporting_year": 2026,
        "case_id": case["id"], "proposal_id": proposal["id"], "original_claim_task_id": original["id"], "notice_task_id": notice["id"],
        "item_ids": item_ids, "scenario": _scenario(item_ids), "created_by": session.user_id, "created_at": datetime.now(timezone.utc).isoformat()})
    return {"run_id": run["id"]}


@router.post("", status_code=201)
def start_example(body: StartExample, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _interactive(session)
    require_roles(session, "owner")
    if body.acknowledged is not True:
        raise ApiError(422, "cap_demo_acknowledgement_required", "Acknowledge that this creates a private fictional training example, not a real claim.")
    if idempotency_key is None:
        raise ApiError(400, "idempotency_key_required", "Use a stable Idempotency-Key so a retry cannot create another example farm.")
    with transaction(session) as conn:
        # Cache only identity. Every response rechecks access and derives current
        # checks/progress, including after changes made through the real screens.
        result = idempotent(conn, idempotency_key, f"cap-example:{SCENARIO_ID}:{session.user_id}", body.model_dump(mode="json"), lambda: _seed(conn, session))
        response = _view(conn, result["run_id"])
        _owner_access(conn, session, response["farm"])
        return response


@router.get("/{run_id}")
def example_detail(run_id: UUID, session: Session = Depends(require_session)):
    _interactive(session)
    with transaction(session) as conn:
        return _view(conn, run_id)
