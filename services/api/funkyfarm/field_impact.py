"""Bounded record links for a proposed field change; never an eligibility verdict."""

from typing import Literal

from fastapi import APIRouter, Depends, Query

from .db import fetch_record, json_safe, transaction
from .models import ApiError
from .security import Session, require_session

router = APIRouter(tags=["fields"])
Section = Literal["reports", "facts", "operations", "requests", "cases"]


@router.get("/field-proposals/{proposal_id}/related-records")
def related_records(proposal_id: str, section: Section = "reports", limit: int = Query(10, ge=1, le=50),
                    offset: int = Query(0, ge=0), expected_revision: int | None = Query(None, ge=1),
                    session: Session = Depends(require_session)):
    with transaction(session) as conn:
        proposal = fetch_record(conn, "field_change_proposals", proposal_id)
        data = proposal["data"]
        farm = fetch_record(conn, "farms", data["farm_id"])
        if expected_revision is not None and expected_revision != proposal["revision"]:
            raise ApiError(409, "field_change_changed", "This field change was edited. Reload it before checking related records.")
        parcels = data.get("previous_parcels", []) + data.get("parcels", [data["parcel"]])
        identities = sorted({str(parcel["id"]) for parcel in parcels if isinstance(parcel, dict) and parcel.get("id")})
        if len(identities) > 100:
            raise ApiError(422, "field_scope_too_large", "Check a smaller group of field changes at a time.")
        physical = "coalesce(data->>'parcel_id',data->>'field_id',data->>'group_id')=ANY(%s::text[])"
        queries = {
            "facts": ("facts", physical, [identities]),
            "operations": ("operations", physical, [identities]),
            "requests": ("requests", "EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data->'requirements','[]'::jsonb)) q "
                "WHERE coalesce(q->>'parcel_id',q->>'field_id',q->>'group_id')=ANY(%s::text[]))", [identities]),
            "reports": ("reports", "(" + " OR ".join([
                "EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data#>'{snapshot,physical_groups}','[]'::jsonb)) g WHERE g->>'id'=ANY(%s::text[]))",
                "EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data#>'{snapshot,facts}','[]'::jsonb)) f WHERE coalesce(f#>>'{data,parcel_id}',f#>>'{data,field_id}',f#>>'{data,group_id}')=ANY(%s::text[]))",
                "EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data#>'{snapshot,operations}','[]'::jsonb)) o WHERE coalesce(o#>>'{data,parcel_id}',o#>>'{data,field_id}',o#>>'{data,group_id}')=ANY(%s::text[]))",
                "EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data#>'{snapshot,fields}','[]'::jsonb)) f WHERE f->>'physical_group_id'=ANY(%s::text[]))",
            ]) + ")", [identities] * 4),
            "cases": ("admin_cases", "EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(data->'references','[]'::jsonb)) r "
                "WHERE r->>'kind'='field_change_proposals' AND r->>'id'=%s)", [proposal["id"]]),
        }
        counts = {}
        for name, (kind, condition, args) in queries.items():
            counts[name] = conn.execute("SELECT count(*) AS total FROM records WHERE kind=%s AND deleted_at IS NULL "
                f"AND data->>'farm_id'=%s AND ({condition})", [kind, farm["id"], *args]).fetchone()["total"]
        kind, condition, args = queries[section]
        rows = conn.execute("SELECT id,kind,revision,coalesce(data->>'title',data->>'label',data->>'key','Saved record') AS title,"
            "coalesce(data->>'status',data->>'review_status') AS status,coalesce(data->>'date',data->>'period') AS date "
            "FROM records WHERE kind=%s AND deleted_at IS NULL AND data->>'farm_id'=%s "
            f"AND ({condition}) ORDER BY updated_at DESC,id LIMIT %s OFFSET %s", [kind, farm["id"], *args, limit, offset]).fetchall()
        items = []
        for row in rows:
            record = json_safe(row)
            if section in {"reports", "cases"}:
                record["href"] = f"/app/{section}/{record['id']}"
            elif section == "requests":
                record["href"] = f"/app/paperwork/{record['id']}"
            elif section == "facts":
                record["href"] = f"/app/fields/{farm['id']}#facts"
            else:
                record["href"] = f"/app/record-work?farm_id={farm['id']}&operation_id={record['id']}"
            items.append(record)
        next_offset = offset + len(items)
        return {"proposal_id": proposal["id"], "proposal_revision": proposal["revision"], "farm_revision": farm["revision"],
                "parcel_ids": identities, "section": section, "counts": counts, "items": items,
                "total": counts[section], "limit": limit, "offset": offset,
                "next_offset": next_offset if next_offset < counts[section] else None,
                "notice": "These records explicitly mention the selected fields, or link to this change. Review them; a changed outline does not automatically make a record wrong. Unlinked documents and records have not been matched. Nothing was changed or sent."}
