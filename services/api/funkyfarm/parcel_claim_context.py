"""Explicitly supplied parcel claim figures; no eligibility or polygon inference."""

from collections import defaultdict
from decimal import Decimal
import hashlib
import json
import math
import re
from uuid import UUID

from .db import fetch_record
from .models import ApiError
from .reconciliation import reconciliation_for_farm

KEYS = {
    "cap.claimed_area_ha": ("declared", "ha", Decimal("1000000000000")),
    "cap.supplied_max_eligible_area_ha": ("max", "ha", Decimal("1000000000000")),
    "cap.pasture_coefficient_percent": ("coefficient", "%", Decimal("100")),
    "cap.proposed_claim_area_ha": ("proposed_claim", "ha", Decimal("1000000000000")),
}
NOTICE = (
    "These are supplied figures, not authority-certified eligibility. App confirmation records a person's "
    "review, not paying-agency acceptance. A proposed correction does not replace the original claim. "
    "A pasture coefficient does not identify a smaller contiguous part of the field; no outline is resized."
)


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _empty(farm_id):
    return {"declared": None, "max": None, "coefficient": None, "excess": None,
            "proposed_claim": None, "proposed_claim_is_draft": False,
            "status": "unknown", "sources": [], "fact_ids": [],
            "revisions": {}, "notice": NOTICE, "problems": [],
            "review_href": f"/app/fields/{farm_id}#facts"}


def claim_contexts(conn, farm_id, reporting_year, parcel_ids):
    """Caller holds the farm reconciliation shared lock in its RLS transaction.

    Only exact campaign-year, parcel-scoped facts are candidates. Source document
    rows are share-locked and revision-pinned; original bytes are never opened or
    returned. Oversize inputs fail explicitly rather than choosing a sample.
    """
    unique_ids = set(parcel_ids)
    contexts = {parcel_id: _empty(farm_id) for parcel_id in unique_ids}
    rows = conn.execute(
        "WITH chosen AS MATERIALIZED (SELECT r.id,r.revision,r.data FROM records r "
        "WHERE r.kind='facts' AND r.deleted_at IS NULL AND r.data->>'farm_id'=%s "
        "AND r.data->>'key'=ANY(%s) AND r.data->>'temporal_basis'='campaign_year' "
        "AND r.data->>'period'=%s AND COALESCE(r.data->>'parcel_id',r.data->>'field_id',r.data->>'group_id')=ANY(%s) "
        "AND COALESCE(r.data->>'review_status','proposed')<>'rejected' "
        "AND r.data->>'superseded_by' IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM records successor WHERE successor.kind='facts' "
        "AND successor.deleted_at IS NULL AND successor.data->>'farm_id'=%s "
        "AND successor.data->>'review_status'='confirmed' AND successor.data->>'supersedes_id'=r.id::text)), "
        "bounds AS (SELECT count(*) AS total,COALESCE(sum(octet_length(data::text)),0) AS bytes FROM chosen) "
        "SELECT chosen.id,chosen.revision,CASE WHEN bounds.total<=8000 AND bounds.bytes<=8388608 "
        "THEN chosen.data ELSE NULL END AS data,bounds.total,bounds.bytes "
        "FROM bounds LEFT JOIN chosen ON true ORDER BY chosen.id LIMIT 8001",
        (farm_id, list(KEYS), str(reporting_year), sorted(unique_ids), farm_id)).fetchall()
    if rows and (rows[0]["total"] > 8000 or rows[0]["bytes"] > 8_388_608):
        raise ApiError(422, "parcel_claim_context_work_limit", "Too many or overly detailed claim facts for this bounded review. Narrow or reconcile the source records; none were silently selected.")
    facts = [row for row in rows if row["id"] is not None]
    bindings = {"facts": [{"id": str(fact["id"]), "revision": fact["revision"],
                           "checksum": _digest(fact["data"])} for fact in facts],
                "documents": [], "resolutions": []}
    # Reuse the actual reconciliation snapshot evaluator: a saved choice applies
    # only to the exact current confirmed candidates, never merely the newest
    # resolution or a proposed competing value. Retain every candidate in the
    # private fingerprint, including explicitly excluded losing values.
    excluded = set()
    fact_ids = {str(fact["id"]) for fact in facts}
    if facts:
        # The shared evaluator also sees non-CAP facts. Bound that complete
        # input before reusing it, rather than unexpectedly reading an unlimited
        # farm history or selecting only a convenient sample of resolutions.
        reconciliation_size = conn.execute(
            "SELECT count(*) AS total,COALESCE(sum(octet_length(data::text)),0) AS bytes FROM records "
            "WHERE deleted_at IS NULL AND data->>'farm_id'=%s AND "
            "((kind='facts' AND data->>'review_status'='confirmed') OR kind='reconciliation_resolutions')",
            (farm_id,)).fetchone()
        if reconciliation_size["total"] > 8000 or reconciliation_size["bytes"] > 8_388_608:
            raise ApiError(422, "parcel_claim_context_work_limit", "The current reconciliation sources exceed this bounded review. Narrow or reconcile the farm records; no saved choices were sampled or ignored.")
    conflicts = reconciliation_for_farm(conn, farm_id) if facts else []
    for conflict in conflicts:
        data = conflict["data"]
        if (data.get("key") not in KEYS or data.get("temporal_basis") != "campaign_year"
                or str(data.get("period")) != str(reporting_year) or data.get("parcel_id") not in unique_ids):
            continue
        candidates = {item["id"] for item in data["candidates"]}
        if not candidates.intersection(fact_ids):
            continue
        resolution = data.get("resolution")
        bindings["resolutions"].append({"conflict_id": conflict["id"], "revision": conflict["revision"],
            "snapshot_hash": data["snapshot_hash"], "resolution": None if resolution is None else {
                "id": resolution["id"], "revision": resolution["revision"], "checksum": _digest(resolution["data"])}})
        if resolution is not None:
            chosen = resolution["data"].get("chosen_fact_id")
            if chosen in candidates and chosen in fact_ids:
                excluded.update(candidates - {chosen})
    facts = [fact for fact in facts if str(fact["id"]) not in excluded]
    grouped, document_ids = defaultdict(list), set()
    for fact in facts:
        data = fact["data"]
        parcel_id = next((data.get(key) for key in ("parcel_id", "field_id", "group_id") if data.get(key) is not None), None)
        if parcel_id not in contexts:
            continue
        grouped[parcel_id].append(fact)
        if len(grouped[parcel_id]) > 32:
            raise ApiError(422, "parcel_claim_context_work_limit", "More than 32 current claim facts refer to one field. Reconcile its records before checking; no latest value was chosen.")
        sources = data.get("sources", [])
        if isinstance(sources, list):
            for source in sources:
                if isinstance(source, dict) and source.get("document_id"):
                    try:
                        document_ids.add(str(UUID(str(source["document_id"]))))
                    except (ValueError, TypeError, AttributeError):
                        pass
    if len(document_ids) > 256:
        raise ApiError(422, "parcel_claim_context_work_limit", "More than 256 original documents are linked to these claim facts. Narrow the evidence for review; no source was silently omitted.")
    documents = {}
    if document_ids:
        conn.execute("SELECT id FROM records WHERE kind='documents' AND deleted_at IS NULL "
                     "AND id=ANY(%s) ORDER BY id FOR SHARE", ([UUID(value) for value in sorted(document_ids)],)).fetchall()
    for document_id in sorted(document_ids):
        try:
            document = fetch_record(conn, "documents", document_id)
        except ApiError as error:
            if error.status != 404:
                raise
            documents[document_id] = None
            bindings["documents"].append({"id": document_id, "status": "unavailable"})
            continue
        # Assigned-to-another-farm documents must not reveal private metadata.
        if document["data"].get("farm_id") not in (None, farm_id):
            documents[document_id] = None
            bindings["documents"].append({"id": document_id, "status": "unavailable"})
            continue
        documents[document_id] = document
        bindings["documents"].append({"id": document_id, "revision": document["revision"],
                                      "checksum": _digest(document["data"])})
    for parcel_id, selected in grouped.items():
        context = contexts[parcel_id]
        values, established, any_proposed = defaultdict(set), defaultdict(list), False
        seen_sources = set()
        for fact in selected:
            data, fact_id = fact["data"], str(fact["id"])
            key, unit, maximum = KEYS[data["key"]]
            context["fact_ids"].append(fact_id)
            context["revisions"][fact_id] = fact["revision"]
            value = data.get("value")
            valid = (not isinstance(value, bool) and isinstance(value, (int, float))
                     and 0 <= value <= maximum and math.isfinite(value) and data.get("unit") == unit)
            if not valid:
                context["problems"].append(f"Review {data['key']}: use an actual non-negative JSON number with unit {unit}.")
            else:
                values[key].add(Decimal(str(value)))
            confirmed = data.get("review_status") == "confirmed"
            any_proposed = any_proposed or not confirmed
            sources = data.get("sources", [])
            source_valid = isinstance(sources, list) and bool(sources) and len(sources) <= 100
            if not isinstance(sources, list):
                sources = []
            for source in sources:
                if not isinstance(source, dict) or not source.get("document_id"):
                    source_valid = False
                    continue
                try:
                    document_id = str(UUID(str(source["document_id"])))
                except (ValueError, TypeError, AttributeError):
                    source_valid = False
                    continue
                document = documents.get(document_id)
                revision = source.get("document_revision")
                pinned = not isinstance(revision, bool) and isinstance(revision, int) and revision >= 1
                status = "unavailable" if document is None else "unpinned" if not pinned else "stale" if revision != document["revision"] else "current"
                if document is not None and (not re.fullmatch(r"[0-9a-fA-F]{64}", str(document["data"].get("sha256", "")))
                                             or not isinstance(document["data"].get("size_bytes"), int)
                                             or document["data"]["size_bytes"] <= 0):
                    status = "unavailable"
                source_valid = source_valid and status == "current"
                available = status != "unavailable"
                source_key = (document_id, revision if pinned else None, status) if available else (None, None, status)
                if source_key not in seen_sources:
                    seen_sources.add(source_key)
                    context["sources"].append({"document_id": document_id if available else None,
                        "document_revision": revision if available and pinned else None,
                        "current_revision": document["revision"] if available else None,
                        "sha256": document["data"].get("sha256") if available else None,
                        "name": str(document["data"].get("name") or document["data"].get("filename") or "Original document")[:200] if available else "Original unavailable for this farm",
                        "href": f"/app/documents/{document_id}" if available else None, "status": status})
            if not source_valid:
                context["problems"].append(f"Review the exact current original-document pins for {data['key']}.")
            established[key].append(valid and confirmed and source_valid)
        for key in ("declared", "max", "coefficient", "proposed_claim"):
            if len(values[key]) == 1:
                context[key] = float(next(iter(values[key])))
            elif len(values[key]) > 1:
                context["problems"].append(f"Conflicting {key} values are recorded. No latest value was selected.")
        if context["declared"] is None or context["max"] is None:
            context["problems"].append("Both the actual claimed area and supplied maximum are needed for a comparison.")
        if context["declared"] is not None and context["max"] is not None:
            # Subtract exact decimal source values; do not derive the supplied
            # maximum from the coefficient, physical outline, or rounding.
            context["excess"] = float(max(Decimal(0), next(iter(values["declared"])) - next(iter(values["max"]))))
        context["proposed_claim_is_draft"] = context["proposed_claim"] is not None
        context["problems"] = sorted(set(context["problems"]))
        context["status"] = "needs_review" if context["problems"] else "unconfirmed" if any_proposed else "confirmed"
        context["established"] = {key: bool(established[key]) and all(established[key]) and len(values[key]) == 1
                                  for key in ("declared", "max")}
    return contexts, bindings
