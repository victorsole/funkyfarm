"""Source-backed, personalized evidence checks, never a legal certification.

The catalogue is data, not executable code. Unknown applicability, national
options and conditional fields remain questions. Original documents are never
opened here, and acquisition evidence never becomes a record of actual use.
"""

from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, Header, Query
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, json_safe, transaction
from .models import ApiError, StrictModel
from .records import matches_reporting_period, physical_identity, validate_data
from .security import Session, require_roles, require_session

router = APIRouter(prefix="/compliance", tags=["evidence and obligation review"])
CATALOGUE = Path(__file__).resolve().parents[3] / "shared" / "obligations.json"
KINDS = ("facts", "operations", "purchases", "sales", "requests", "tasks", "checklists", "documents")
LIMITS = [
    "This is an evidence review, not legal compliance, payment eligibility, certification or authority acceptance.",
    "The catalogue is not a complete inventory of national, regional or scheme obligations.",
    "Missing activity records do not prove that no activity occurred. National deadlines and conditional requirements need explicit review.",
]
PROFILE = {
    "uses_professional_plant_protection": ("Do you use plant-protection products professionally?", "boolean", []),
    "ppp_use_type": ("Which types of professional plant-protection use take place?", "choice", ["surface", "closed_space", "seed_treatment"]),
    "cap_applicant": ("Are you applying for CAP support in this reporting year?", "boolean", []),
    "keeps_livestock": ("Do you keep livestock?", "boolean", []),
    "registry_species": ("Which registered animal species are kept on this farm?", "choice", ["bovine", "ovine", "caprine", "porcine", "other"]),
    "keeps_food_producing_animals": ("Do you keep food-producing animals?", "boolean", []),
    "food_or_feed_business": ("Does this farm operate as a food or feed business?", "boolean", []),
    "uses_nitrogen_fertiliser": ("Do you use nitrogen fertiliser?", "boolean", []),
    "nitrates_action_programme_applies": ("Does the confirmed national nitrates action programme apply to this farm? Leave this unknown until its scope is established.", "boolean", []),
    "organic_operator": ("Is this farm an organic operator?", "boolean", []),
}
EU_COUNTRIES = {"AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"}
PPP_RULE_TYPES = {"eu-ppp-surface-use": "surface", "eu-ppp-closed-space-use": "closed_space", "eu-ppp-seed-treatment-use": "seed"}


def _hash(value):
    return hashlib.sha256(json.dumps(json_safe(value), sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def load_rules():
    try:
        if CATALOGUE.stat().st_size > 2_000_000:
            raise ValueError("catalogue size")
        catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
        rules = catalogue["rules"]
        if not catalogue.get("version") or not isinstance(rules, list) or not 1 <= len(rules) <= 200:
            raise ValueError("catalogue shape")
        ids = set()
        for rule in rules:
            if (not isinstance(rule, dict) or not isinstance(rule.get("id"), str)
                    or rule["id"] in ids or not rule.get("title")
                    or not isinstance(rule.get("requirements"), list)
                    or len(rule["requirements"]) > 100 or not rule.get("citations")):
                raise ValueError("rule shape")
            ids.add(rule["id"])
        return catalogue
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise ApiError(503, "rules_unavailable", "The source-backed review catalogue is unavailable. No obligations have been inferred.") from exc


def _day(value):
    try:
        return date.fromisoformat(value) if isinstance(value, str) else None
    except ValueError:
        return None


def _number(value):
    if isinstance(value, bool) or value is None or isinstance(value, (list, dict)):
        return None
    try:
        result = Decimal(str(value))
        return result if result.is_finite() else None
    except InvalidOperation:
        return None


def _present(value):
    return value is not None and value != "" and value != [] and value != {}


def _same(left, right):
    # In particular, a numeric 1 is not a farmer's explicit boolean answer.
    return type(left) is type(right) and left == right


def _href(kind, farm_id, record_id=None):
    if kind == "documents":
        return f"/app/documents/{record_id}" if record_id else "/app/documents"
    if kind in ("operations", "purchases", "sales"):
        return f"/app/record-work?farm_id={farm_id}&review=1"
    if kind == "requests":
        return f"/app/paperwork/{record_id}" if record_id else f"/app/paperwork?farm_id={farm_id}"
    return f"/app/fields/{farm_id}#facts"


def _evidence(record):
    data = record["data"]
    docs = {source["document_id"] for source in data.get("sources", [])
            if isinstance(source, dict) and source.get("document_id")}
    if data.get("document_id"):
        docs.add(data["document_id"])
    return {"id": record["id"], "kind": record["kind"], "revision": record["revision"],
            "href": _href(record["kind"], data.get("farm_id"), record["id"]),
            "review_status": data.get("review_status", "unreviewed"), "date": data.get("date"),
            "period": data.get("period"), "parcel_id": physical_identity(data),
            "source_document_ids": sorted(docs)}


def _question(key, rule, candidates, year, conflicting=False):
    prompt, kind, options = PROFILE.get(key, (f"Confirm {key.replace('_', ' ')}.", "text", []))
    return {"key": key, "fact_key": key, "label": prompt, "prompt": prompt,
            "value_type": kind, "choices": [{"value": value, "label": value.replace("_", " ")} for value in options],
            "multiple": key in ("ppp_use_type", "registry_species"),
            "temporal_basis": "campaign_year", "period": str(year), "sources": rule.get("citations", []),
            "conflicting_fact_ids": [r["id"] for r in candidates if r["data"].get("review_status") == "confirmed"] if conflicting else [],
            "proposal_ids": [r["id"] for r in candidates if r["data"].get("review_status") == "proposed"]}


def rule_applicability(rule, farm, facts, operations, year):
    """Pure, conservative predicate evaluator shared with regulatory change feeds.

    Inputs are full scoped RecordItems. Only explicit confirmed profile values
    and actual confirmed events establish activity; no absence-as-false rule.
    """
    farm_id, farm_data = farm["id"], farm["data"]
    facts = [r for r in facts if r["data"].get("farm_id") == farm_id]
    operations = [r for r in operations if r["data"].get("farm_id") == farm_id]
    questions, evidence = {}, {}

    def predicate(spec):
        if not isinstance(spec, dict):
            return "unknown"
        for group in ("all", "any"):
            if group in spec:
                if not isinstance(spec[group], list) or not spec[group]:
                    return "unknown"
                states = [predicate(child) for child in spec[group]]
                if "conflict" in states:
                    return "conflict"
                if group == "all":
                    return "does_not_apply" if "does_not_apply" in states else "unknown" if "unknown" in states else "applies"
                return "applies" if "applies" in states else "unknown" if "unknown" in states else "does_not_apply"
        field, operator = spec.get("field", ""), spec.get("operator")
        if not isinstance(field, str) or operator not in ("eq", "in", "exists"):
            return "unknown"
        candidates = []
        if field.startswith("fact."):
            key = field[5:]
            candidates = [r for r in facts if r["data"].get("key") == key and physical_identity(r["data"]) is None
                          and matches_reporting_period(r["data"], year)]
            selected = [r for r in candidates if r["data"].get("review_status") == "confirmed" and _present(r["data"].get("value"))]
            values = {json.dumps(r["data"]["value"], sort_keys=True) for r in selected}
            if len(values) > 1:
                questions[key] = _question(key, rule, candidates, year, True)
                return "conflict"
            if not selected:
                questions[key] = _question(key, rule, candidates, year)
                return "unknown"
            value = selected[0]["data"]["value"]
            if key in PROFILE and PROFILE[key][1] == "boolean" and not isinstance(value, bool):
                questions[key] = _question(key, rule, candidates, year)
                return "unknown"
            if key in PROFILE and PROFILE[key][1] == "choice":
                supplied = value if isinstance(value, list) else [value]
                if not supplied or any(not isinstance(v, str) or v not in PROFILE[key][2] for v in supplied):
                    questions[key] = _question(key, rule, candidates, year)
                    return "unknown"
            evidence.update((r["id"], _evidence(r)) for r in selected)
        elif field in ("farm.country", "farm.region"):
            value = farm_data.get(field[5:])
            if not _present(value):
                return "unknown"
        elif field == "operation.type":
            selected = [r for r in operations if r["data"].get("review_status") == "confirmed"
                        and _day(r["data"].get("date")) and _day(r["data"]["date"]).year == year]
            if not selected:
                return "unknown"
            matched = [r for r in selected if (_same(r["data"].get("type"), spec.get("value")) if operator == "eq"
                       else any(_same(r["data"].get("type"), v) for v in spec.get("value", [])) if operator == "in" and isinstance(spec.get("value"), list) else operator == "exists")]
            evidence.update((r["id"], _evidence(r)) for r in matched)
            return "applies" if matched else "unknown"
        else:
            return "unknown"
        if operator == "exists":
            # A saved false answer exists. Its value is not the absence of an answer.
            return "applies" if spec.get("value", True) is True else "does_not_apply"
        if operator == "in":
            expected = spec.get("value")
            supplied = value if isinstance(value, list) else [value]
            if (not isinstance(expected, list) or not expected or not supplied
                    or any(isinstance(v, (dict, list)) or v is None for v in supplied)):
                return "unknown"
            return "applies" if any(_same(v, item) for v in supplied for item in expected) else "does_not_apply"
        if isinstance(value, (list, dict)):
            return "unknown"
        return "applies" if _same(value, spec.get("value")) else "does_not_apply"

    jurisdiction = "applies"
    if rule.get("authority_scope") == "eu_baseline":
        if not farm_data.get("country"):
            jurisdiction = "unknown"
        elif str(farm_data["country"]).upper() not in EU_COUNTRIES:
            return {"status": "does_not_apply", "questions": [], "evidence": []}
    for key in ("country", "region"):
        if rule.get(key) is not None:
            if not farm_data.get(key):
                jurisdiction = "unknown"
            elif str(farm_data[key]).strip().casefold() != str(rule[key]).strip().casefold():
                return {"status": "does_not_apply", "questions": [], "evidence": []}
    state = predicate(rule.get("applicability"))
    effective = _day(rule.get("effective", {}).get("applies_from"))
    if effective and year < effective.year:
        # Earlier duties may still exist. A later mapping is not an exemption.
        return {"status": "unknown", "questions": list(questions.values()), "evidence": list(evidence.values()),
                "reason": "This catalogue mapping starts after the selected reporting year. Earlier duties need separate source review."}
    if jurisdiction == "unknown" and state != "does_not_apply":
        state = "unknown"
    # Do not ask irrelevant subtype questions after an explicit negative answer.
    return {"status": state, "questions": list(questions.values()) if state != "does_not_apply" else [],
            "evidence": list(evidence.values())}


def _issue(code, message, rule_id, farm_id, records=(), severity="warning", kind="facts"):
    return {"code": code, "severity": severity, "message": message, "rule_id": rule_id,
            "record_ids": [r["id"] for r in records], "href": _href(kind, farm_id, records[0]["id"] if records else None)}


def _step(identifier, title, message, href, status="needs_information", kind="evidence"):
    return {"id": identifier, "title": title, "message": message, "status": status, "href": href, "kind": kind}


def _parcels(farm):
    items = list(farm["data"].get("parcels", []))
    for site in farm["data"].get("sites", []):
        if isinstance(site, dict):
            items.extend(site.get("parcels", []))
    return {str(p["id"]): p for p in items if isinstance(p, dict) and p.get("id")}


def _source_issues(record, rule_id, farm_id, by_id, required=False):
    data, issues = record["data"], []
    sources = [s for s in data.get("sources", []) if isinstance(s, dict)]
    refs = []
    if data.get("document_id"):
        refs.append((data["document_id"], None, "documents"))
    for source in sources:
        for field, kind in (("document_id", "documents"), ("record_id", source.get("record_kind", "facts"))):
            if source.get(field):
                refs.append((source[field], source.get("document_revision" if field == "document_id" else "revision"), kind))
    if required and record["kind"] != "documents" and not refs and not any(_present(s.get("note")) or _present(s.get("quote"))
            or (s.get("import_id") and s.get("row_id") and s.get("sha256")) for s in sources):
        issues.append(_issue("missing_source", "Add the original evidence or a clear farmer-entered source note.", rule_id, farm_id, [record], kind=record["kind"]))
    for identifier, revision, kind in refs:
        target = by_id.get(identifier)
        if target is None or target["kind"] != kind:
            issues.append(_issue("source_unavailable", "A cited source is unavailable in this farm's current access scope. Review the citation.", rule_id, farm_id, [record], "error", record["kind"]))
        elif revision is not None and revision != target["revision"]:
            issues.append(_issue("source_changed", "A cited source has changed since this evidence was reviewed.", rule_id, farm_id, [record, target], "error", record["kind"]))
        elif kind in ("facts", "operations", "purchases", "sales") and target["data"].get("review_status") != "confirmed":
            issues.append(_issue("unreviewed_source", "A cited record still needs explicit human confirmation.", rule_id, farm_id, [record, target], kind=kind))
    return issues


def _event_issues(record, rule_id, farm_id):
    data, issues = record["data"], []
    actual = _day(data.get("date"))
    if not actual:
        issues.append(_issue("actual_date_required", "Enter the actual event date. A reporting year or invoice date cannot stand in for actual work.", rule_id, farm_id, [record], "error", record["kind"]))
    elif actual > date.today():
        issues.append(_issue("future_actual_date", "This is a future date. Check whether it is planned work rather than an event that already happened.", rule_id, farm_id, [record], "error", record["kind"]))
    if data.get("temporal_basis") == "calendar_date" and data.get("period") != data.get("date"):
        issues.append(_issue("contradictory_date", "The actual date and calendar-date evidence period differ. Review the original event.", rule_id, farm_id, [record], "error", record["kind"]))
    quantity = _number(data.get("quantity"))
    if data.get("quantity") is not None and (quantity is None or (quantity < 0 and record["kind"] == "operations")):
        issues.append(_issue("invalid_quantity", "Review the quantity exactly as recorded; negative work quantities cannot establish actual use.", rule_id, farm_id, [record], "error", record["kind"]))
    elif quantity is not None and quantity < 0:
        issues.append(_issue("credit_quantity_review", "Review this signed invoice quantity against the original credit note. It has not been converted into stock or actual-use data.", rule_id, farm_id, [record], kind=record["kind"]))
    if data.get("quantity") is not None and not _present(data.get("unit")):
        issues.append(_issue("quantity_unit_required", "Keep the quantity's original unit. Do not guess a conversion.", rule_id, farm_id, [record], kind=record["kind"]))
    return issues


def _field_evidence(field, event, facts, year):
    key, data = field.get("key"), event["data"]
    unit = data.get("unit")
    direct_key = key
    if key == "dose":
        # Prefer the farmer's actual dose and its own unit, not total quantity.
        if _present(data.get("dose")):
            unit = data.get("dose_unit")
        elif isinstance(unit, str) and "/" in unit:
            direct_key = "quantity"
    elif key in ("treated_area", "treated_extent", "treated_quantity"):
        required_type = {"treated_area": "surface", "treated_extent": "closed_space", "treated_quantity": "seed"}[key]
        if data.get("treatment_type") == required_type:
            direct_key, unit = "treated_size", data.get("treated_unit")
    elif key == "treated_size":
        unit = data.get("treated_unit")
    elif key in ("parcel_id", "facility_id", "treated_unit_id") and not _present(data.get(key)):
        # This remains the supplied location string, not a generated IACS code.
        direct_key = "treated_location"
    elif key == "growth_stage":
        direct_key = "bbch_stage"
    elif key == "crop" and not _present(data.get("crop")):
        direct_key = "eppo_code"
    direct = _present(data.get(direct_key))
    basis = field.get("temporal_basis", "calendar_date")
    period = data.get("date") if basis == "calendar_date" else str(year) if basis == "campaign_year" else None
    candidates = [r for r in facts if r["data"].get("key") == key and r["data"].get("review_status") != "rejected"
                  and physical_identity(r["data"]) == physical_identity(data)
                  and matches_reporting_period(r["data"], year, basis=basis, period=period)
                  and (event["kind"] != "documents" or any(isinstance(s, dict) and s.get("document_id") == event["id"]
                       for s in r["data"].get("sources", [])))]
    confirmed = [r for r in candidates if r["data"].get("review_status") == "confirmed" and _present(r["data"].get("value"))]
    measured = key in ("dose", "quantity", "treated_size", "treated_area", "treated_extent", "treated_quantity", "quantity_administered", "withdrawal_period", "treatment_duration")
    return direct, data.get(direct_key), unit if measured else None, candidates, confirmed


def _requirement(requirement, rule, farm, rows, year, by_id):
    rid, farm_id = rule["id"], farm["id"]
    identifier = requirement.get("id", "evidence")
    label = requirement.get("label", identifier)
    kind = {"operation": "operations", "purchase": "purchases", "sale": "sales", "document": "documents", "fact": "facts", "profile": "facts"}.get(requirement.get("kind"))
    issues, evidence = [], {}
    if kind is None:
        issues.append(_issue("unsupported_requirement", "This source requirement needs an adviser to map it to the farm's evidence.", rid, farm_id, severity="adviser"))
        candidates = []
    else:
        candidates = [r for r in rows[kind] if r["data"].get("review_status") != "rejected"]
        if kind == "facts":
            candidates = [r for r in candidates if r["data"].get("key") == requirement.get("key")
                          and matches_reporting_period(r["data"], year, basis=requirement.get("temporal_basis"))]
        elif kind in ("operations", "purchases", "sales"):
            types = requirement.get("operation_types")
            treatment_type = PPP_RULE_TYPES.get(rid)
            candidates = [r for r in candidates if (kind != "operations" or not types or r["data"].get("type") in types)
                          and (not treatment_type or not r["data"].get("treatment_type") or r["data"]["treatment_type"] == treatment_type)
                          and (not _day(r["data"].get("date")) or _day(r["data"]["date"]).year == year)]
        elif kind == "documents":
            # Never treat an arbitrary upload as a specific certificate or return.
            desired = requirement.get("document_types") or ([requirement["key"]] if requirement.get("key") else [])
            linked = {source["document_id"] for fact in rows["facts"]
                      if fact["data"].get("key") == requirement.get("key")
                      and fact["data"].get("review_status") == "confirmed"
                      and matches_reporting_period(fact["data"], year, basis=requirement.get("temporal_basis"))
                      for source in fact["data"].get("sources", []) if isinstance(source, dict) and source.get("document_id")}
            candidates = [r for r in candidates if (desired and r["data"].get("document_type") in desired)
                          or r["id"] in linked]
        if requirement.get("parcel_id"):
            candidates = [r for r in candidates if physical_identity(r["data"]) == requirement["parcel_id"]]
    if not candidates:
        issues.append(_issue("missing_evidence", f"Add or identify evidence for: {label}. No saved event is not proof of no activity.", rid, farm_id, kind=kind or "facts"))
        if kind == "operations" and rows["purchases"]:
            issues.append(_issue("purchase_is_not_use", "Purchase evidence does not establish actual product use, its date, dose or treated area.", rid, farm_id, kind="operations"))
    parcels = _parcels(farm)
    for record in candidates:
        data = record["data"]
        if (requirement.get("current_fields_only") is True
                and kind not in ("operations", "purchases", "sales")
                and data.get("temporal_basis") != "calendar_date"
                and not _day(data.get("date"))
                and physical_identity(data) in parcels
                and parcels[physical_identity(data)].get("active") is False):
            # Only an explicitly current-state requirement may exclude a retired
            # field. Its actual dated events remain evidence after a split/merge.
            continue
        evidence[record["id"]] = _evidence(record)
        if kind != "documents" and data.get("review_status") != "confirmed":
            issues.append(_issue("evidence_needs_review", "Review this proposed evidence before relying on it.", rid, farm_id, [record], kind=kind))
        issues.extend(_source_issues(record, rid, farm_id, by_id, requirement.get("source_required", False)))
        if kind in ("operations", "purchases", "sales"):
            issues.extend(_event_issues(record, rid, farm_id))
        if rid in PPP_RULE_TYPES and not data.get("treatment_type"):
            issues.append(_issue("treatment_type_required", "Choose the actual surface, closed-space or seed treatment type. The farm's activities do not establish this event's type.", rid, farm_id, [record], kind=kind))
        if kind == "facts" and requirement.get("unit") and data.get("unit") != requirement["unit"]:
            issues.append(_issue("wrong_unit", "This evidence does not use the source requirement's unit. Review without silently converting it.", rid, farm_id, [record], "error"))
        if kind == "facts" and data.get("temporal_basis") == "calendar_date" and (_day(data.get("period")) is None or _day(data["period"]) > date.today()):
            issues.append(_issue("invalid_actual_period", "Review the actual evidence date. A future or invalid day cannot establish an event that already happened.", rid, farm_id, [record], "error"))
        for field in requirement.get("fields", []):
            direct, value, unit, supporting, confirmed = _field_evidence(field, record, rows["facts"], year)
            evidence.update((r["id"], _evidence(r)) for r in supporting)
            conditional_flag = {"start_time": "label_time_required", "growth_stage": "label_growth_stage_required"}.get(field.get("key"))
            condition = data.get(conditional_flag) if conditional_flag else None
            if field.get("required") == "conditional" and condition is False:
                continue
            if field.get("required") == "conditional" and condition is not True and not direct and not confirmed:
                issues.append(_issue("conditional_field_review", f"Establish whether {field.get('label', field['key'])} is required: {field.get('condition', 'the source gives a condition')}. Missing is not an exemption.", rid, farm_id, [record], "adviser", kind))
                continue
            if not direct and not confirmed:
                issues.append(_issue("missing_field", f"Add {field.get('label', field['key'])} for this event and field, with its actual date.", rid, farm_id, [record], kind=kind))
                continue
            if direct and field.get("key") in ("parcel_id", "facility_id", "treated_unit_id") and not _present(data.get(field["key"])):
                issues.append(_issue("location_format_review", "The supplied treatment location has been retained exactly. Confirm the nationally accepted identifier or alternative location format; no official identifier was invented.", rid, farm_id, [record], "adviser", kind))
            supplied = [(value, unit, record)] if direct else []
            supplied += [(r["data"].get("value"), r["data"].get("unit"), r) for r in confirmed]
            if len({_hash([v, u]) for v, u, _ in supplied}) > 1:
                issues.append(_issue("contradictory_field", f"Competing values for {field.get('label', field['key'])} need an explicit resolution.", rid, farm_id, [r for _, _, r in supplied], "error", kind))
            for supplied_value, supplied_unit, source in supplied:
                if field.get("key") == "date" or field.get("key", "").endswith("_date"):
                    actual = _day(supplied_value)
                    if actual is None or actual > date.today():
                        issues.append(_issue("invalid_actual_date", f"Review the actual date for {field.get('label', field['key'])}; no date has been inferred from the reporting year.", rid, farm_id, [source], "error", kind))
                options = field.get("unit_options")
                if options and (not supplied_unit or str(supplied_unit).casefold() not in [str(u).casefold() for u in options]):
                    examples = field.get("unit_options_are_examples") or field.get("preserve_other_recorded_units")
                    issues.append(_issue("unit_needs_review" if examples else "wrong_unit", f"Review the original unit for {field.get('label', field['key'])}; source examples include {', '.join(options)}. No conversion or legal invalidity is inferred.", rid, farm_id, [source], "adviser" if examples else "error", kind))
                if field.get("key") in ("dose", "treated_size", "treated_area", "treated_extent", "treated_quantity", "quantity", "quantity_administered") and not supplied_unit:
                    issues.append(_issue("quantity_unit_required", f"Keep the original unit for {field.get('label', field['key'])}; no unit has been guessed.", rid, farm_id, [source], kind=kind))
                if field.get("key") in ("dose", "treated_size", "treated_area", "treated_fraction", "treated_extent", "treated_quantity", "quantity", "quantity_administered"):
                    numeric = _number(supplied_value)
                    if numeric is None or numeric <= 0:
                        issues.append(_issue("invalid_quantity", f"Enter a positive, finite {field.get('label', field['key'])} in the original unit.", rid, farm_id, [source], "error", kind))
                    elif field.get("key") == "treated_area" and str(supplied_unit).casefold() == "ha":
                        parcel = parcels.get(physical_identity(data), {})
                        stated_area = _number(parcel.get("area_ha"))
                        if stated_area is not None and numeric > stated_area:
                            issues.append(_issue("treated_area_exceeds_field", "The supplied treated area exceeds this field's supplied area. Review the units and original figures; outline estimates are not official area evidence.", rid, farm_id, [record, source], "error", kind))
                issues.extend(_source_issues(source, rid, farm_id, by_id, requirement.get("source_required", False)))
        if kind in ("operations", "purchases", "sales"):
            signature = [data.get(k) for k in ("date", "type", "product", "invoice_number", "quantity", "unit", "amount", "currency")]
            duplicates = [r for r in candidates if r["id"] != record["id"]
                          and physical_identity(r["data"]) == physical_identity(data)
                          and [r["data"].get(k) for k in ("date", "type", "product", "invoice_number", "quantity", "unit", "amount", "currency")] == signature]
            if duplicates:
                issues.append(_issue("possible_duplicate", "These records have the same supplied event or invoice details. Check the originals before counting both; no record has been deleted.", rid, farm_id, [record, *duplicates], kind=kind))
    if candidates and not evidence:
        issues.append(_issue("no_current_field_evidence", "Only retired-field evidence was found. Select the current field explicitly; historical records were preserved.", rid, farm_id, kind=kind or "facts"))
    # Deduplicate repeated source checks without losing separate event identities.
    issues = list({_hash(issue): issue for issue in issues}.values())
    for summary in evidence.values():
        source_record = by_id.get(summary["id"])
        refs = set(summary["source_document_ids"])
        if source_record:
            refs.update(s["record_id"] for s in source_record["data"].get("sources", [])
                        if isinstance(s, dict) and s.get("record_id"))
        summary["source_records"] = [{"id": by_id[ref]["id"], "kind": by_id[ref]["kind"],
                                      "revision": by_id[ref]["revision"], "checksum": _hash(by_id[ref]["data"])}
                                     for ref in sorted(refs) if ref in by_id]
    status = "needs_adviser" if any(i["severity"] in ("adviser", "error") for i in issues) else "needs_information" if issues else "ready_for_review"
    steps = [_step(f"{identifier}:{issue['code']}:{_hash([issue['record_ids'], issue['message']])[:10]}",
                   issue["message"][:160], issue["message"], issue["href"],
                   "needs_adviser" if issue["severity"] in ("adviser", "error") else "needs_information",
                   "adviser" if issue["severity"] == "adviser" else "evidence") for issue in issues]
    if not steps:
        steps = [_step(identifier, label, "Review the supplied evidence against the original source.",
                       _href(kind or "facts", farm_id), status)]
    return {"id": identifier, "label": label, "status": status, "issues": issues, "evidence": list(evidence.values()), "steps": steps}


def _deadline(rule):
    spec = rule.get("deadline", {})
    supplied = _day(spec.get("date"))
    established = spec.get("type") == "fixed_date" and supplied is not None and bool(rule.get("citations"))
    return {"status": "established" if established else "unknown", "date": supplied.isoformat() if established else None,
            "message": spec.get("reason") or ("Source-established date; check the stated scope." if established else "The applicable national or recipient deadline has not been established. Ask the authority or adviser."),
            "legal_timing": rule.get("legal_timing"), "source": spec.get("source"), "rule_id": rule["id"]}


def check_farm(conn, session, farm_id, year=None):
    """Read only, using the caller's existing RLS transaction; no network or writes."""
    farm = fetch_record(conn, "farms", farm_id)
    year = year if year is not None else farm["data"].get("reporting_year") or date.today().year
    if isinstance(year, bool) or not isinstance(year, int) or not 2000 <= year <= 2100:
        raise ApiError(422, "invalid_year", "Choose the actual reporting year between 2000 and 2100.")
    catalogue = load_rules()
    found = json_safe(conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
        "WHERE kind=ANY(%s) AND deleted_at IS NULL AND data->>'farm_id'=%s ORDER BY id LIMIT 10001",
        (list(KINDS), farm["id"])).fetchall())
    if len(found) > 10000:
        raise ApiError(422, "review_too_large", "This farm has more than 10,000 evidence records. Narrow the review before continuing; nothing was silently omitted.")
    from .reconciliation import selected_fact_ids
    excluded = selected_fact_ids(conn, farm["id"])["excluded_fact_ids"]
    rows = {kind: [r for r in found if r["kind"] == kind and r["id"] not in excluded] for kind in KINDS}
    by_id = {r["id"]: r for r in found}
    attempted_sources = set()
    # Include only explicitly cited sources, never arbitrary unassigned uploads.
    for record in found:
        data = record["data"]
        references = [(data.get("document_id"), "documents")]
        for source in data.get("sources", []):
            if isinstance(source, dict):
                references.extend([(source.get("document_id"), "documents"), (source.get("record_id"), source.get("record_kind", "facts"))])
        for identifier, kind in references:
            if not identifier or identifier in by_id or kind not in KINDS or (identifier, kind) in attempted_sources:
                continue
            attempted_sources.add((identifier, kind))
            if len(attempted_sources) > 1000:
                raise ApiError(422, "source_review_too_large", "More than 1,000 additional source references need review. Narrow the evidence set before continuing.")
            try:
                source_record = fetch_record(conn, kind, identifier)
            except ApiError as exc:
                if exc.status == 404:
                    continue
                raise
            if source_record["data"].get("farm_id") in (None, farm["id"]):
                by_id[identifier] = source_record
                if kind == "documents":
                    rows["documents"].append(source_record)
    obligations, questions, issues = [], {}, []
    for rule in catalogue["rules"]:
        applicability = rule_applicability(rule, farm, rows["facts"], rows["operations"], year)
        for question in applicability["questions"]:
            if question["key"] in questions:
                previous = questions[question["key"]]
                previous["sources"] = list({_hash(s): s for s in previous["sources"] + question["sources"]}.values())
            else:
                questions[question["key"]] = question
        requirements, own_issues, steps = [], [], []
        state = applicability["status"]
        if state == "applies":
            requirements = [_requirement(req, rule, farm, rows, year, by_id) for req in rule["requirements"]]
            own_issues.extend(issue for req in requirements for issue in req["issues"])
            steps.extend(step for req in requirements for step in req["steps"])
        elif state != "does_not_apply":
            own_issues.append(_issue("applicability_conflict" if state == "conflict" else "applicability_unknown",
                applicability.get("reason") or ("Resolve contradictory applicability answers before relying on this rule." if state == "conflict" else "Answer the farm activity questions and confirm national or scheme applicability. No exemption has been inferred."),
                rule["id"], farm["id"], severity="adviser" if state == "conflict" or applicability.get("reason") else "warning"))
            steps.append(_step("applicability", "Confirm whether this applies", own_issues[-1]["message"], own_issues[-1]["href"], "needs_adviser" if state == "conflict" else "needs_information", "profile"))
        deadline = _deadline(rule)
        if state == "applies" and deadline["status"] == "unknown":
            own_issues.append(_issue("national_deadline_unknown", "Confirm the applicable national or recipient deadline with the authority or adviser. A European maximum or retention period has not been turned into a filing date.", rule["id"], farm["id"], severity="adviser"))
            steps.append(_step("national-deadline", "Confirm the applicable deadline", deadline["message"], "/app/adviser", "needs_adviser", "adviser"))
        if state == "applies" and rule.get("review_status") != "sourced_baseline":
            own_issues.append(_issue("domain_review_required", "This rule's mapping needs domain review before relying on the evidence checks.", rule["id"], farm["id"], severity="adviser"))
        status = "needs_adviser" if any(i["severity"] in ("adviser", "error") for i in own_issues) else "needs_information" if own_issues else "ready_for_review"
        progress = {"required": len(requirements), "with_evidence": sum(bool(r["evidence"]) for r in requirements),
                    "needs_review": sum(r["status"] != "ready_for_review" for r in requirements)}
        obligation = {"id": rule["id"], "title": rule["title"], "workflow_id": rule.get("workflow_id"),
                      "applicability": state, "status": status, "requirements": requirements,
                      "applicability_evidence": applicability["evidence"], "deadline": deadline,
                      "citations": rule["citations"], "progress": progress, "steps": steps,
                      "issues": own_issues, "limits": rule.get("limits", rule.get("limitations", [])),
                      "retention": rule.get("retention"), "effective": rule.get("effective"), "national_options": rule.get("national_options")}
        obligation["fingerprint"] = _hash({"rule": rule, "assessment": obligation})
        obligations.append(obligation)
        issues.extend(own_issues)
    deadlines = [dict(o["deadline"], title=o["title"], href=f"/app/checks?farm_id={farm['id']}")
                 for o in obligations if o["applicability"] != "does_not_apply"]
    for request in rows["requests"]:
        data = request["data"]
        if data.get("status") != "responded" and _day(data.get("deadline")):
            deadlines.append({"status": "recorded", "date": data["deadline"], "title": data.get("title", "Recorded request"),
                              "message": "Farmer-recorded request date, not a verified national deadline.", "request_id": request["id"],
                              "href": _href("requests", farm["id"], request["id"]), "overdue": _day(data["deadline"]) < date.today()})
    included = [o for o in obligations if o["applicability"] != "does_not_apply"]
    overall = "needs_adviser" if any(o["status"] == "needs_adviser" for o in included) else "needs_information" if any(o["status"] == "needs_information" for o in included) else "ready_for_review"
    return {"farm_id": farm["id"], "farm_revision": farm["revision"], "year": year,
            "rules_version": catalogue["version"], "rules_updated_at": catalogue.get("updated_at"), "rules_hash": _hash(catalogue),
            "input_fingerprint": _hash({"farm": farm, "records": sorted(by_id.values(), key=lambda r: r["id"]), "excluded": sorted(excluded), "year": year, "rules": _hash(catalogue)}),
            "input_records": [{"id": r["id"], "kind": r["kind"], "revision": r["revision"], "checksum": _hash(r["data"])}
                              for r in sorted(by_id.values(), key=lambda r: r["id"])],
            "profile_questions": list(questions.values()), "obligations": obligations, "issues": issues,
            "overall": overall, "deadlines": deadlines,
            "progress": {"required": len(included), "with_evidence": sum(o["progress"]["with_evidence"] > 0 for o in included),
                         "needs_review": sum(o["status"] != "ready_for_review" for o in included)},
            "limits": list(dict.fromkeys(LIMITS + catalogue.get("limits", [])))}


def _locked_farm(conn, session, farm_id, expected_farm_revision):
    require_roles(session, "owner", "adviser")
    farm = fetch_record(conn, "farms", farm_id)
    permission = conn.execute("SELECT record_access(id,kind,data,true) AS allowed FROM records WHERE id=%s AND kind='farms'",
                              (farm["id"],)).fetchone()
    if not permission or not permission["allowed"]:
        raise ApiError(403, "review_permission_required", "Your current farm grant permits reading, not creating review drafts.")
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm['id']}",))
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='farms' FOR UPDATE", (farm["id"],))
    farm = fetch_record(conn, "farms", farm["id"])
    if farm["revision"] != expected_farm_revision:
        raise ApiError(409, "revision_conflict", "The farm profile changed. Review the current checks before creating drafts.", {"current_revision": farm["revision"]})
    return farm


def create_checklists(conn, session, farm_id, rule_ids, expected_farm_revision, year=None, *, expected_input_fingerprint=None):
    """Create explicit actionable drafts in an already-authorized transaction."""
    require_roles(session, "owner", "adviser")
    if not isinstance(rule_ids, list) or not 1 <= len(rule_ids) <= 20 or any(not isinstance(r, str) for r in rule_ids) or len(set(rule_ids)) != len(rule_ids):
        raise ApiError(422, "rule_selection_required", "Select between one and twenty distinct source-backed rules.")
    farm = _locked_farm(conn, session, farm_id, expected_farm_revision)
    checked = check_farm(conn, session, farm["id"], year)
    if expected_input_fingerprint is not None and expected_input_fingerprint != checked["input_fingerprint"]:
        raise ApiError(409, "compliance_checks_changed", "The evidence or source catalogue changed. Review the current checks before creating drafts.")
    selected = {r["id"]: r for r in checked["obligations"]}
    if any(identifier not in selected for identifier in rule_ids):
        raise ApiError(422, "unknown_rule", "A selected rule is not present in the current source catalogue.")
    if sum(max(1, len(selected[identifier]["steps"])) for identifier in rule_ids) > 100:
        raise ApiError(422, "checklist_selection_too_large", "Select fewer rules or resolve repeated record issues before creating more than 100 draft tasks at once.")
    existing = json_safe(conn.execute("SELECT id,data FROM records WHERE kind='checklists' AND deleted_at IS NULL "
        "AND data->>'farm_id'=%s AND data->>'compliance_version'=%s ORDER BY id", (farm["id"], str(checked["rules_version"]))).fetchall())
    checklists, tasks, skipped = [], [], []
    for identifier in rule_ids:
        rule = selected[identifier]
        prior = next((r for r in existing if r["data"].get("compliance_rule_id") == identifier and r["data"].get("scheme") == f"{identifier}:{checked['year']}"), None)
        if prior or rule["applicability"] == "does_not_apply":
            skipped.append({"rule_id": identifier, "reason": ("existing_checklist_needs_refresh" if prior["data"].get("compliance_hash") != rule["fingerprint"] else "existing_checklist") if prior else "explicitly_not_applicable", "checklist_id": prior["id"] if prior else None})
            continue
        provenance = {"compliance_rule_id": identifier, "compliance_version": checked["rules_version"],
                      "compliance_hash": rule["fingerprint"], "source_citations": rule["citations"]}
        steps = rule["steps"] or [_step("source-review", "Review against the original sources", "Review this evidence with the recipient or adviser; no legal acceptance is implied.", f"/app/checks?farm_id={farm['id']}", "ready_for_review")]
        items = [{"key": step["id"], "label": step["title"], "done": False, "evidence_ids": [],
                  "note": step["message"] + " Open: " + step["href"], "deadline": rule["deadline"]["date"]} for step in steps]
        checklist = insert_record(conn, "checklists", {"farm_id": farm["id"], "title": rule["title"] + " — evidence review",
            "scheme": f"{identifier}:{checked['year']}", "version": str(checked["rules_version"]), "items": items,
            "notes": "Draft checklist only; not a complete inventory of obligations and not a finding of legal compliance.",
            "deadline": rule["deadline"]["date"], **provenance})
        checklists.append(checklist)
        for step in steps:
            tasks.append(insert_record(conn, "tasks", {"farm_id": farm["id"], "title": step["title"], "description": step["message"],
                "due_date": rule["deadline"]["date"], "status": "open", "checklist_id": checklist["id"],
                "notes": "Open: " + step["href"] + ". Explicit human review required; do not infer completion.", **provenance}))
    return {"checklists": checklists, "tasks": tasks, "skipped": skipped, "rules_version": checked["rules_version"]}


def propose_profile(conn, session, farm_id, year, expected_farm_revision, answers):
    """Typed farm activity answers remain proposals until a separate review."""
    farm = _locked_farm(conn, session, farm_id, expected_farm_revision)
    if isinstance(year, bool) or not isinstance(year, int) or year != farm["data"].get("reporting_year"):
        raise ApiError(422, "profile_year_mismatch", "Choose the farm's saved reporting year before recording its activity answers.",
                       {"reporting_year": farm["data"].get("reporting_year")})
    if not isinstance(answers, list) or not 1 <= len(answers) <= len(PROFILE):
        raise ApiError(422, "profile_answers_required", "Provide at least one of the displayed farm activity answers.")
    normalized, seen = [], set()
    for answer in answers:
        if not isinstance(answer, dict) or set(answer) != {"key", "value"} or not isinstance(answer.get("key"), str):
            raise ApiError(422, "invalid_profile_answer", "Use the displayed activity questions and their explicit answers.")
        key, value = answer["key"], answer["value"]
        if key not in PROFILE or key in seen:
            raise ApiError(422, "invalid_profile_question", "Select each displayed activity question at most once.")
        seen.add(key)
        label, kind, options = PROFILE[key]
        if kind == "boolean":
            if not isinstance(value, bool):
                raise ApiError(422, "invalid_profile_answer", "Answer this activity question with an explicit yes or no. Leave unknown answers unanswered.", {"key": key})
        elif kind == "choice":
            supplied = value if isinstance(value, list) else [value]
            if not supplied or len(supplied) > len(options) or any(not isinstance(v, str) or v not in options for v in supplied) or len(set(supplied)) != len(supplied):
                raise ApiError(422, "invalid_profile_answer", "Choose one or more of the displayed activity types.", {"key": key, "choices": options})
            if isinstance(value, list):
                value = sorted(value)
        normalized.append({"farm_id": farm["id"], "key": key, "label": label, "value": value,
                           "temporal_basis": "campaign_year", "period": str(year), "review_status": "proposed",
                           "sources": [{"kind": "manual", "note": f"Explicit farm activity answer supplied by a workspace member for reporting year {year}."}]})
    existing = json_safe(conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
        "WHERE kind='facts' AND deleted_at IS NULL AND data->>'farm_id'=%s AND data->>'temporal_basis'='campaign_year' "
        "AND data->>'period'=%s AND data->>'key'=ANY(%s) ORDER BY created_at DESC,id DESC LIMIT 10001",
        (farm["id"], str(year), list(seen))).fetchall())
    if len(existing) > 10000:
        raise ApiError(422, "profile_review_too_large", "Review the existing activity answers before creating more than 10,000 profile records for this year.")
    facts, notices = [], []
    for data in normalized:
        identical = next((row for row in existing if row["data"].get("key") == data["key"]
                          and physical_identity(row["data"]) is None and _same(row["data"].get("value"), data["value"])
                          and row["data"].get("review_status") in ("proposed", "confirmed")), None)
        if identical:
            if identical["data"]["review_status"] == "proposed":
                facts.append(identical)
                notices.append(f"A matching answer for {data['label']} already awaits review; no duplicate was created.")
            else:
                notices.append(f"This exact answer for {data['label']} is already confirmed for {year}; no duplicate was created.")
            continue
        facts.append(insert_record(conn, "facts", validate_data(conn, "facts", data)))
    notices.append("Saved answers are proposals, not confirmed facts. Read each answer and use the separate confirmation action; conflicting answers are not silently replaced.")
    return {"facts": facts, "notices": notices}


class ChecklistSelection(StrictModel):
    rule_ids: list[str] = Field(min_length=1, max_length=20)
    expected_farm_revision: int = Field(ge=1, strict=True)
    year: int | None = Field(default=None, ge=2000, le=2100, strict=True)
    expected_input_fingerprint: str | None = Field(default=None, pattern="^[0-9a-f]{64}$")


class ProfileAnswer(StrictModel):
    key: str = Field(min_length=1, max_length=100)
    value: Any


class ProfileAnswers(StrictModel):
    year: int = Field(ge=2000, le=2100, strict=True)
    expected_farm_revision: int = Field(ge=1, strict=True)
    answers: list[ProfileAnswer] = Field(min_length=1, max_length=len(PROFILE))


@router.get("/farms/{farm_id}")
def get_compliance(farm_id: str, year: int | None = Query(None, ge=2000, le=2100), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return check_farm(conn, session, farm_id, year)


@router.post("/farms/{farm_id}/checklist")
def generate_checklists(farm_id: str, body: ChecklistSelection, session: Session = Depends(require_session),
                        idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        fetch_record(conn, "farms", farm_id)
        return idempotent(conn, idempotency_key, f"compliance:{farm_id}", body.model_dump(mode="json"),
                          lambda: create_checklists(conn, session, farm_id, body.rule_ids, body.expected_farm_revision, body.year,
                                                    expected_input_fingerprint=body.expected_input_fingerprint))


@router.post("/farms/{farm_id}/profile")
def save_profile(farm_id: str, body: ProfileAnswers, session: Session = Depends(require_session),
                 idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        fetch_record(conn, "farms", farm_id)
        return idempotent(conn, idempotency_key, f"compliance-profile:{farm_id}", body.model_dump(mode="json"),
                          lambda: propose_profile(conn, session, farm_id, body.year, body.expected_farm_revision,
                                                  [answer.model_dump(mode="json") for answer in body.answers]))
