"""Explicit choices between competing, source-linked confirmed facts."""

import hashlib
import json
from collections import defaultdict
from uuid import NAMESPACE_URL, uuid5

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from .db import fetch_record, insert_record, json_safe, transaction
from .models import ApiError, StrictModel
from .records import physical_identity
from .security import Session, require_roles, require_session

router = APIRouter(tags=["reconciliation"])


class ResolveConflict(StrictModel):
    farm_id: str
    expected_revision: int = Field(ge=1)
    chosen_fact_id: str
    note: str = Field(min_length=1, max_length=4000)


def _canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def reconciliation_for_farm(conn, farm_id: str):
    """No GET-time writes. Snapshot revision covers every competing source revision."""
    farm = fetch_record(conn, "farms", farm_id)
    rows = conn.execute(
        "SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE kind='facts' "
        "AND data->>'farm_id'=%s AND data->>'review_status'='confirmed' AND deleted_at IS NULL ORDER BY id",
        (farm["id"],),
    ).fetchall()
    groups = defaultdict(list)
    for fact in json_safe(rows):
        data = fact["data"]
        identity = (data.get("key"), data.get("period"), data.get("temporal_basis"))
        physical = physical_identity(data)
        # Keep existing farm-level conflict IDs and their recorded resolutions stable.
        # Supplied physical IDs distinguish parcels/sites; labels never establish identity.
        if physical is not None:
            identity += (physical,)
        groups[_canonical(identity)].append(fact)
    resolutions = conn.execute(
        "SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
        "WHERE kind='reconciliation_resolutions' AND data->>'farm_id'=%s AND deleted_at IS NULL "
        "ORDER BY created_at DESC,id DESC", (farm["id"],)
    ).fetchall()
    latest = {}
    for resolution in json_safe(resolutions):
        key = (resolution["data"]["conflict_id"], resolution["data"]["snapshot_hash"])
        latest.setdefault(key, resolution)
    conflicts = []
    for identity, facts in groups.items():
        values = {_canonical({"value": fact["data"].get("value"), "unit": fact["data"].get("unit")}) for fact in facts}
        if len(values) < 2:
            continue
        identifier = str(uuid5(NAMESPACE_URL, "funkyfarm:reconciliation:" + farm["id"] + ":" + identity))
        # Include full data so changes to value, source, unit or period invalidate an old choice.
        snapshot = hashlib.sha256(_canonical([{"id": fact["id"], "revision": fact["revision"], "data": fact["data"]}
                                               for fact in facts]).encode()).hexdigest()
        revision = int(snapshot[:13], 16) + 1  # Exact in JavaScript's integer representation.
        resolution = latest.get((identifier, snapshot))
        identity_parts = json.loads(identity)
        key, period, temporal_basis = identity_parts[:3]
        physical = identity_parts[3] if len(identity_parts) > 3 else None
        conflicts.append({
            "id": identifier, "kind": "reconciliation", "workspace_id": farm["workspace_id"],
            "revision": revision, "data": {"farm_id": farm["id"], "key": key, "period": period,
                "temporal_basis": temporal_basis, "parcel_id": physical, "candidates": facts, "snapshot_hash": snapshot,
                "status": "resolved" if resolution else "needs_review", "resolution": resolution},
        })
    return sorted(conflicts, key=lambda item: (str(item["data"]["key"]), str(item["data"]["period"]), str(item["data"]["parcel_id"])))


def selected_fact_ids(conn, farm_id: str):
    """Reporting can exclude losing values only after a recorded, current resolution."""
    conflicts = reconciliation_for_farm(conn, farm_id)
    excluded = set()
    unresolved = []
    for conflict in conflicts:
        resolution = conflict["data"]["resolution"]
        if resolution is None:
            unresolved.append(conflict["id"])
            continue
        selected = resolution["data"]["chosen_fact_id"]
        excluded.update(fact["id"] for fact in conflict["data"]["candidates"] if fact["id"] != selected)
    return {"excluded_fact_ids": excluded, "unresolved_conflict_ids": unresolved}


@router.get("/reconciliation")
def list_reconciliation(farm_id: str, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                        session: Session = Depends(require_session)):
    with transaction(session) as conn:
        conflicts = reconciliation_for_farm(conn, farm_id)
        return {"items": conflicts[offset:offset + limit], "total": len(conflicts), "limit": limit, "offset": offset}


@router.post("/reconciliation/{conflict_id}/resolve", status_code=201)
def resolve_reconciliation(conflict_id: str, body: ResolveConflict, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", body.farm_id)
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
                     (f"{session.workspace_id}:reconciliation:{farm['id']}",))
        # A transaction lock also coordinates with fact confirmation when that boundary uses this key.
        conn.execute("SELECT id FROM records WHERE kind='facts' AND data->>'farm_id'=%s "
                     "AND deleted_at IS NULL FOR SHARE", (farm["id"],)).fetchall()
        conflict = next((item for item in reconciliation_for_farm(conn, farm["id"])
                         if item["id"] == conflict_id), None)
        if conflict is None:
            raise ApiError(404, "not_found", "This competing fact group was not found in this workspace.")
        if conflict["revision"] != body.expected_revision:
            raise ApiError(409, "revision_conflict", "The competing facts changed. Review the current sources before resolving them.",
                           {"current_revision": conflict["revision"]})
        if conflict["data"]["resolution"] is not None:
            raise ApiError(409, "already_resolved", "This source comparison already has a recorded resolution.",
                           {"resolution_id": conflict["data"]["resolution"]["id"]})
        candidates = conflict["data"]["candidates"]
        if body.chosen_fact_id not in {item["id"] for item in candidates}:
            raise ApiError(422, "invalid_choice", "Select one of the confirmed competing facts.")
        if not body.note.strip():
            raise ApiError(422, "resolution_note_required", "Record why this source value should be used.")
        return insert_record(conn, "reconciliation_resolutions", {
            "farm_id": farm["id"], "conflict_id": conflict_id, "snapshot_hash": conflict["data"]["snapshot_hash"],
            "expected_revision": body.expected_revision, "chosen_fact_id": body.chosen_fact_id,
            "candidates": [{"fact_id": item["id"], "revision": item["revision"]} for item in candidates],
            "note": body.note, "resolved_by": str(session.user_id),
            "key": conflict["data"]["key"], "period": conflict["data"]["period"],
            "temporal_basis": conflict["data"]["temporal_basis"], "parcel_id": conflict["data"].get("parcel_id"),
        })
