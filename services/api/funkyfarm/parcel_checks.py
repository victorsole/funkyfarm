"""Revision-bound checks of private field records, never CAP eligibility decisions."""

from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from urllib.parse import urlencode
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from .db import fetch_record, transaction
from .fields import _outline_overlap, _overlap_outline, geometry_summary
from .models import ApiError
from .parcel_claim_context import claim_contexts
from .security import Session, require_session

router = APIRouter(tags=["parcel evidence checks"])
RULES_PATH = Path(__file__).resolve().parents[3] / "shared" / "cap-correction-rules.json"
MAX_FIELDS = 2000
MAX_OVERLAP_PAIRS = 20_000
CHECK_VERSION = 3
SOURCE_ARTICLES = {
    "parcel_identity": "Article 8(3)(a)",
    "claim_delineation": "Article 8(3)(b)",
    "crop_evidence": "Article 8(3)(d)",
    "maximum_eligible_area": "Article 2(7)(a)",
    "protected_area_context": "Article 2(7)(g)",
}
NOTICE = (
    "These are checks of your private field records, not a filed claim, an official LPIS update "
    "or an eligibility decision. Approximate outline area, farmer-reported area, claimed area "
    "and authority-determined eligible area are different values."
)
LIMITS = [
    "Only active fields on this farm are compared. No other farmer's private fields are read.",
    "Current outlines and crops are not proof of the selected campaign's filed declarations.",
    "Claim and maximum figures are read only from explicitly linked campaign facts. Proposed values are unconfirmed; app confirmation is not authority certification.",
    "Protected-area context remains unknown. Natura location would not by itself make land ineligible.",
    "A clear technical check is not a finding of legal compliance, payment entitlement or authority acceptance.",
]


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _text(value, maximum=200):
    return value[:maximum] if isinstance(value, str) else ""


def _rules():
    try:
        raw = RULES_PATH.read_bytes()
        if len(raw) > 128_000:
            raise ValueError("oversized rule catalogue")
        catalogue = json.loads(raw)
        supplied = catalogue["sources"]
        sources = {}
        for key, article in SOURCE_ARTICLES.items():
            source = supplied[key]
            if source.get("article") != article or not str(source.get("url", "")).startswith("https://eur-lex.europa.eu/"):
                raise ValueError("unexpected rule source")
            sources[key] = {name: _text(source.get(name), 2000) for name in
                            ("title", "url", "version", "article", "review_note")}
        return _digest(catalogue), sources
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        # Missing citations must never become an invented legal conclusion.
        return _digest({"parcel_rules": "unavailable"}), {}


def _integer(value, label, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ApiError(422, "invalid_parcel_check", f"{label} must be a whole number between {minimum} and {maximum}.")


def _identifier(value, label):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ApiError(422, "invalid_parcel_check", f"Choose a valid {label}.") from exc


def check_parcels(conn, session, farm_id, expected_farm_revision, reporting_year,
                  case_id=None, expected_case_revision=None, limit=20, offset=0):
    """Read only; caller's transaction must bind the supplied session's RLS scope."""
    farm_id = _identifier(farm_id, "farm")
    _integer(expected_farm_revision, "Farm revision", 1, 2_147_483_647)
    _integer(reporting_year, "Reporting year", 1900, 2200)
    _integer(limit, "Page size", 1, 100)
    _integer(offset, "Page offset", 0, 1_000_000)
    if (case_id is None) != (expected_case_revision is None):
        raise ApiError(422, "case_revision_required", "Choose both the case and its current revision, or neither.")
    if session.credential_farm_ids is not None and farm_id not in session.credential_farm_ids:
        raise ApiError(404, "record_not_found", "This farm was not found.")
    farm = fetch_record(conn, "farms", farm_id)
    # Use the same key as ordinary fact edits/review. Concurrent successors or
    # competing values must not appear between reading facts and this response.
    conn.execute("SELECT pg_advisory_xact_lock_shared(hashtextextended(%s,0))",
                 (f"{session.workspace_id}:reconciliation:{farm_id}",))
    farm = fetch_record(conn, "farms", farm_id)
    if farm["revision"] != expected_farm_revision:
        raise ApiError(409, "farm_revision_conflict", "This farm changed. Reload its fields before checking them.",
                       {"current_revision": farm["revision"]})
    case = None
    if case_id is not None:
        case_id = _identifier(case_id, "case")
        _integer(expected_case_revision, "Case revision", 1, 2_147_483_647)
        case = fetch_record(conn, "admin_cases", case_id)
        if case["data"].get("farm_id") != farm_id or case["data"].get("reporting_year") != reporting_year:
            raise ApiError(422, "parcel_case_scope_mismatch", "Choose a case for this farm and reporting year.")
        if case["revision"] != expected_case_revision:
            raise ApiError(409, "case_revision_conflict", "This case changed. Reload it before checking fields.",
                           {"current_revision": case["revision"]})
    originals = farm["data"].get("parcels", [])
    if not isinstance(originals, list) or len(originals) > MAX_FIELDS or any(not isinstance(p, dict) for p in originals):
        raise ApiError(422, "parcel_check_field_limit", "Review the farm's stored field list before checking it; at most 2000 fields are supported.")
    active = [(index, p) for index, p in enumerate(originals) if p.get("active") is not False]
    contexts, claim_bindings = claim_contexts(conn, farm_id, reporting_year,
        [_text(p.get("id"), 100) if _text(p.get("id"), 100).strip() else f"legacy-{index}" for index, p in active])
    rule_hash, sources = _rules()
    editor_href = f"/app/fields/{farm_id}#boundaries-{farm_id}"
    query = {"reporting_year": reporting_year, "expected_farm_revision": farm["revision"]}
    if case:
        query.update(case_id=case_id, expected_case_revision=case["revision"])
    check_href = f"/app/fields/{farm_id}/check?{urlencode(query)}"
    prepare_href = f"/app/cases/{case_id}" if case else "/app/cases/new?" + urlencode({
        "farm_id": farm_id, "job_type": "fields", "reporting_year": reporting_year})
    fields, issues, outlines, cache = [], [], [], {}
    identities = Counter(_text(p.get("id"), 100) for _, p in active if _text(p.get("id"), 100).strip())
    references = Counter(_text(p.get("external_id")) for _, p in active if _text(p.get("external_id")).strip())

    def issue(index, field, code, title, explanation, observed=None, declared=None, unit=None,
              source_keys=(), severity="warning", who_decides="You or your adviser review the private record; the paying agency decides official eligibility."):
        issues.append({"id": _digest([farm_id, index, field["id"] if field else None, code])[:32],
                       "field_id": field["id"] if field else None,
                       "field_name": field["name"] if field else "This farm", "code": code,
                       "severity": severity, "title": title, "explanation": explanation,
                       "observed": observed, "declared": declared, "unit": unit,
                       "sources": [sources[key] for key in source_keys if key in sources],
                       "who_decides": who_decides, "action_href": editor_href})

    if not active:
        issue(-1, None, "no_active_fields", "No active fields to check",
              "Add or import your field records before reviewing their outlines and crop information.",
              source_keys=("parcel_identity",))
    for index, parcel in active:
        identity = _text(parcel.get("id"), 100)
        field = {"id": identity if identity.strip() else f"legacy-{index}",
                 "name": _text(parcel.get("name")) or f"Field {index + 1}",
                 "crop": _text(parcel.get("crop")) or None,
                 "external_id": _text(parcel.get("external_id")) or None,
                 "identity_supplied": bool(identity.strip()), "geometry_status": "missing",
                 "outline_area_ha": None, "farmer_reported_area_ha": None,
                 "claimed_area_ha": None, "eligible_area_ha": None, "natura_status": "unknown",
                 "bbox": None, "editor_href": editor_href, "check_href": check_href}
        context = contexts[field["id"]]
        if identities[identity] > 1:
            # A fact's private field ID cannot distinguish duplicate records.
            # Keep its provenance for review, but establish no field's value.
            context = {**context, **{key: None for key in
                ("declared", "max", "coefficient", "proposed_claim", "excess")},
                "status": "needs_review", "proposed_claim_is_draft": False,
                "established": {}, "problems": context["problems"] + [
                    "This private field ID is duplicated. Claim facts cannot be assigned to one field unambiguously."]}
        field["claim_context"] = {key: value for key, value in context.items() if key != "established"}
        if context.get("established", {}).get("declared"):
            field["claimed_area_ha"] = context["declared"]
        if context.get("established", {}).get("max"):
            field["eligible_area_ha"] = context["max"]
            field["eligible_area_basis"] = "user_supplied_maximum_not_certified"
        fields.append(field)
        if context["status"] in ("unconfirmed", "needs_review"):
            issue(index, field, "claim_context_needs_review", "Review the supplied claim figures",
                  "These figures are proposed, conflicting or need current original-document pins. Open the normal fact review; no draft correction replaces the original claim.",
                  observed={"status": context["status"], "problems": context["problems"]},
                  source_keys=("maximum_eligible_area", "claim_delineation"))
            issues[-1]["action_href"] = context["review_href"]
        if context["excess"] is not None and context["excess"] > 0:
            issue(index, field, "claimed_above_supplied_maximum", "Claimed area exceeds the supplied maximum",
                  "The supplied claimed area is greater than the separately supplied maximum. This is a comparison for review, not an authority finding. Check the original figures and any proposed correction; do not shrink the physical outline to the pasture percentage.",
                  observed={"supplied_maximum_ha": context["max"], "excess_ha": context["excess"],
                            "context_status": context["status"]},
                  declared=context["declared"], unit="ha", source_keys=("maximum_eligible_area", "claim_delineation"))
            issues[-1]["action_href"] = context["review_href"]
        if not identity.strip() or not _text(parcel.get("name")).strip():
            issue(index, field, "parcel_identity_missing", "Check this field's identity",
                  "A field name or private field ID is missing. A local ID is not automatically an official parcel reference.",
                  observed={"has_name": bool(_text(parcel.get("name")).strip()), "has_private_id": bool(identity.strip())},
                  source_keys=("parcel_identity",))
        if identity.strip() and identities[identity] > 1:
            issue(index, field, "parcel_identity_duplicate", "Two field records use the same private ID",
                  "Check which records describe separate fields before preparing any boundary change.",
                  observed={"private_id": identity, "record_count": identities[identity]}, source_keys=("parcel_identity",))
        if not field["external_id"] or not field["external_id"].strip():
            issue(index, field, "official_reference_unknown", "Official parcel reference not recorded",
                  "Add the parcel number from your official farm records. Drawing an outline does not assign an official number.",
                  source_keys=("parcel_identity",))
        elif references[field["external_id"]] > 1:
            issue(index, field, "official_reference_reused", "An official-reference label is reused",
                  "Separate private fields may share a reference parcel. Check the actual declaration; this is not automatically an error.",
                  observed={"reference": field["external_id"], "record_count": references[field["external_id"]]},
                  source_keys=("parcel_identity", "claim_delineation"))
        if not field["crop"] or not field["crop"].strip():
            issue(index, field, "crop_missing", "Crop not recorded",
                  "Record the actual crop for the relevant campaign where required. Do not infer it from last year's crop or a map image.",
                  source_keys=("crop_evidence",))
        reported = parcel.get("area_ha")
        if reported is not None:
            if (isinstance(reported, bool) or not isinstance(reported, (int, float))
                    or not 0 <= reported <= 1_000_000_000_000 or not math.isfinite(reported)):
                issue(index, field, "reported_area_invalid", "Review the farmer-reported area",
                      "The supplied area_ha value is not a finite non-negative number within this check's technical bound of 1 trillion hectares. It has not been converted or treated as eligible area.",
                      unit="ha", source_keys=("maximum_eligible_area",))
            else:
                field["farmer_reported_area_ha"] = reported
        if parcel.get("geometry") is None:
            issue(index, field, "outline_missing", "Field outline not recorded",
                  "A location point does not establish the field boundary or area. Add or import an outline for a technical comparison.",
                  source_keys=("claim_delineation", "maximum_eligible_area"))
            continue
        try:
            outline = _overlap_outline(parcel["geometry"], cache)
            summary = geometry_summary(outline["geometry"])
        except ApiError as error:
            if error.code != "invalid_geometry":
                raise
            field["geometry_status"] = "invalid"
            issue(index, field, "outline_invalid", "Field outline needs correction", error.message,
                  source_keys=("claim_delineation",), severity="error")
            continue
        field.update(geometry_status="valid", outline_area_ha=summary["approximate_area_ha"], bbox=summary["bbox"])
        field["area_method"] = summary["area_method"]
        if field["farmer_reported_area_ha"] is not None:
            field["area_difference_ha"] = round(field["outline_area_ha"] - field["farmer_reported_area_ha"], 5)
        outlines.append((index, field, outline))

    # Sweep by longitude bounds; only farm-internal intersecting bounding boxes
    # reach the existing exact outline helper. Stop rather than omit any pairs.
    ordered = sorted(outlines, key=lambda item: (item[2]["bounds"][0], item[0]))
    overlap_counts, overlap_examples, pair_count = Counter(), {}, 0
    for position, (index, field, outline) in enumerate(ordered):
        for other_index, other_field, other in ordered[position + 1:]:
            if other["bounds"][0] >= outline["bounds"][2]:
                break
            if other["bounds"][1] >= outline["bounds"][3] or outline["bounds"][1] >= other["bounds"][3]:
                continue
            pair_count += 1
            if pair_count > MAX_OVERLAP_PAIRS:
                raise ApiError(422, "parcel_check_overlap_work_limit",
                               "Too many potentially overlapping outlines for this bounded review. Review duplicate or unusually broad outlines first; no fields were silently skipped.")
            if _outline_overlap(outline, other):
                for own_index, neighbour in ((index, other_field), (other_index, field)):
                    overlap_counts[own_index] += 1
                    examples = overlap_examples.setdefault(own_index, [])
                    if len(examples) < 20:
                        examples.append({"id": neighbour["id"], "name": neighbour["name"]})
    for index, field, _ in sorted(outlines, key=lambda item: item[0]):
        if overlap_counts[index]:
            issue(index, field, "internal_overlap", "Drawn fields overlap on this farm",
                  "The interiors of these private outlines intersect. Compare boundaries and the actual declared intervention area; overlap alone does not establish fraud or ineligibility.",
                  observed={"field_count": overlap_counts[index], "fields": overlap_examples[index],
                            "has_more": overlap_counts[index] > len(overlap_examples[index])},
                  source_keys=("claim_delineation",))
    # Recheck revision pins after geometry work, without returning a mixed-age
    # case/farm view when a concurrent editor committed during the calculation.
    if fetch_record(conn, "farms", farm_id)["revision"] != farm["revision"]:
        raise ApiError(409, "farm_revision_conflict", "This farm changed while checking it. Reload its fields.")
    if case and fetch_record(conn, "admin_cases", case_id)["revision"] != case["revision"]:
        raise ApiError(409, "case_revision_conflict", "This case changed while checking fields. Reload the case.")
    issues.sort(key=lambda item: (0 if item["severity"] == "error" else 1, item["field_name"], item["field_id"] or "", item["code"], item["id"]))
    fingerprint = _digest({"check_version": CHECK_VERSION, "farm_id": farm_id, "farm_revision": farm["revision"], "farm_data": farm["data"],
                           "reporting_year": reporting_year, "case_id": case_id,
                           "case_revision": case["revision"] if case else None,
                           "case_data": case["data"] if case else None, "rule_hash": rule_hash})
    fingerprint = _digest({"parcel_fingerprint": fingerprint, "claim_bindings": claim_bindings})
    return {"farm_id": farm_id, "farm_revision": farm["revision"], "reporting_year": reporting_year,
            "case_id": case_id, "case_revision": case["revision"] if case else None,
            "fingerprint": fingerprint, "rule_hash": rule_hash, "rule_sources_available": bool(sources),
            "field_count": len(fields), "fields": fields, "issue_total": len(issues),
            "limit": limit, "offset": offset, "has_more": offset + limit < len(issues),
            "issues": issues[offset:offset + limit], "editor_href": editor_href,
            "check_href": check_href, "prepare_href": prepare_href,
            "status": "review_needed" if issues else "technical_checks_complete",
            "notice": NOTICE,
            "limits": LIMITS + ([] if sources else ["Legal source pointers are unavailable; only technical checks were performed."]),
            "sources": list(sources.values())}


@router.get("/farms/{farm_id}/parcel-check")
def parcel_check(farm_id: str, expected_farm_revision: int = Query(..., ge=1),
                 reporting_year: int = Query(..., ge=1900, le=2200),
                 case_id: str | None = None, expected_case_revision: int | None = Query(None, ge=1),
                 limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0, le=1_000_000),
                 session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return check_parcels(conn, session, farm_id, expected_farm_revision, reporting_year,
                             case_id, expected_case_revision, limit, offset)
