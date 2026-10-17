"""Plain-language farm setup, checked capture and honest annual reuse."""

from copy import deepcopy
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, json_safe, list_records, transaction, update_record
from .models import ApiError, StrictModel
from .records import matches_reporting_period, physical_identity, validate_data
from .security import Session, require_roles, require_session

router = APIRouter(prefix="/workflow", tags=["farmer workflows"])
CAPTURE_TYPES = [
    {"value": "purchase", "label": "A purchase or receipt", "kind": "purchases"},
    {"value": "sale", "label": "A sale or sales invoice", "kind": "sales"},
    {"value": "fertiliser_application", "label": "Fertiliser I applied", "kind": "operations"},
    {"value": "pesticide_application", "label": "Crop protection I applied", "kind": "operations"},
    {"value": "irrigation", "label": "Water I used", "kind": "operations", "default_unit": "m3"},
    {"value": "harvest", "label": "A harvest", "kind": "operations", "default_unit": "kg"},
    {"value": "work", "label": "Work I did", "kind": "operations", "default_unit": "h"},
    {"value": "observation", "label": "Something I noticed", "kind": "operations"},
    *[{"value": f"animal_{key}", "label": label, "kind": "operations", "default_unit": "head"}
      for key, label in (("birth", "Animals born"), ("death", "An animal death"),
                        ("purchase", "Animals arriving after a purchase"), ("sale", "Animals leaving after a sale"),
                        ("movement", "Animals moved"), ("treatment", "Animals treated"))],
]
OPERATION_TYPES = {item["value"] for item in CAPTURE_TYPES if item["kind"] == "operations"} | {"input_application"}
KNOWN_UNITS = {"ha", "m2", "kg", "g", "t", "l", "ml", "m3", "mm", "h", "head", "kg/ha", "g/ha", "l/ha", "ml/ha", "item"}
UNIT_ALIASES = {"L": "l", "litre": "l", "litres": "l", "liter": "l", "liters": "l", "m³": "m3", "m²": "m2",
                "hectare": "ha", "hectares": "ha", "hours": "h", "hour": "h", "tonne": "t", "tonnes": "t", "animals": "head"}
APPLICATION_TYPES = {"fertiliser_application", "pesticide_application", "input_application"}
ANNUAL_EXCLUDED_KEYS = re.compile(r"(^|_)(payment|paid|expense|cost|income|revenue|sale|sales|sold|yield|harvest|irrigation|application|quantity|labour|labor|hours|births|deaths)(_|$)", re.I)
MAX_FARM_RECORDS = 10_000


class OnboardInput(StrictModel):
    farm_id: UUID | None = None
    expected_revision: int | None = Field(default=None, ge=1, strict=True)
    name: str = Field(min_length=1, max_length=200)
    country: str = Field(min_length=2, max_length=2)
    region: str | None = Field(default=None, max_length=200)
    farm_type: Literal["arable", "livestock", "mixed", "horticulture", "other"]
    reporting_year: int = Field(ge=1900, le=2200, strict=True)
    previous_document_ids: list[UUID] = Field(default_factory=list, max_length=100)


class CaptureCheck(StrictModel):
    kind: Literal["facts", "operations", "purchases", "sales"]
    data: dict[str, Any]
    record_id: UUID | None = None
    expected_revision: int | None = Field(default=None, ge=1, strict=True)
    reporting_year: int | None = Field(default=None, ge=1900, le=2200, strict=True)


class CaptureInput(CaptureCheck):
    acknowledged_codes: list[str] = Field(default_factory=list, max_length=100)
    check_token: str | None = Field(default=None, max_length=64)


class AnnualDecision(StrictModel):
    farm_id: UUID
    year: int = Field(ge=1901, le=2200, strict=True)
    source_fact_id: UUID
    expected_source_revision: int = Field(ge=1, strict=True)
    decision: Literal["reuse", "changed", "not_applicable"]
    value: Any = None
    unit: str | None = Field(default=None, max_length=200)
    note: str = Field(min_length=1, max_length=4000)


class GuidedAnswer(StrictModel):
    request_id: UUID
    expected_request_revision: int = Field(ge=1, strict=True)
    key: str = Field(min_length=1, max_length=300)
    question_id: str | None = Field(default=None, max_length=64)
    parcel_id: str | None = Field(default=None, min_length=1, max_length=100)
    value: Any
    unit: str | None = Field(default=None, max_length=200)
    temporal_basis: Literal["static", "campaign_year", "calendar_date"] | None = None
    period: str | None = Field(default=None, max_length=200)
    sources: list[dict[str, Any]] = Field(default_factory=list, max_length=99)
    note: str = Field(min_length=1, max_length=4000)
    preview: bool = True
    acknowledged_codes: list[str] = Field(default_factory=list, max_length=100)
    check_token: str | None = Field(default=None, max_length=64)


def _digest(value):
    return hashlib.sha256(json.dumps(json_safe(value), sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _issue(issues, code, message, field=None, severity="warning", record_ids=None):
    item = {"code": code, "severity": severity, "message": message}
    if field:
        item["field"] = field
    if record_ids:
        item["record_ids"] = record_ids
    if item not in issues:
        issues.append(item)


def _number(value, field, issues):
    if value is None:
        return None
    if isinstance(value, bool):
        _issue(issues, "invalid_number", "Enter a number, or leave this blank when it is unknown.", field, "error")
        return value
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        if not re.fullmatch(r"[+-]?\d+(?:[.,]\d+)?", raw):
            _issue(issues, "ambiguous_number", "Enter the number without thousands separators, for example 1250.50 or 1250,50.", field, "error")
            return value
        if "," in raw:
            _issue(issues, "decimal_comma", f"Please check this number: {raw} will be saved as {raw.replace(',', '.')}.", field)
        value = raw.replace(",", ".")
    try:
        number = Decimal(str(value))
        if not number.is_finite() or abs(number) > Decimal("1000000000000"):
            raise InvalidOperation
        if number.as_tuple().exponent < -9:
            _issue(issues, "number_precision", "Use at most nine decimal places so the saved value stays clear.", field, "error")
            return value
        return int(number) if number == number.to_integral_value() else float(number)
    except (InvalidOperation, ValueError, TypeError):
        _issue(issues, "invalid_number", "Enter a finite number between minus and plus one trillion.", field, "error")
        return value


def _farm_records(conn, farm_id, kinds):
    rows = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
        "WHERE kind=ANY(%s) AND data->>'farm_id'=%s AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT %s",
        (list(kinds), str(farm_id), MAX_FARM_RECORDS + 1)).fetchall()
    if len(rows) > MAX_FARM_RECORDS:
        raise ApiError(422, "review_too_large", "This farm has many records. Review a smaller period before continuing.")
    return json_safe(rows)


def check_capture(conn, kind, data, record_id=None, reporting_year=None, *, event_required=True, value_type=None, strict_type=True):
    """Read-only checks shared by web, native, document and import capture.

    Callers retain original input and resubmit it when acknowledging warnings.
    The token detects changed checks; it grants no review or write authority.
    """
    if kind not in {"facts", "operations", "purchases", "sales"}:
        raise ApiError(422, "capture_kind", "Choose a fact, purchase, sale or work record.")
    try:
        json.dumps(data, allow_nan=False)
    except (ValueError, TypeError):
        raise ApiError(422, "invalid_record", "Use ordinary JSON values and finite numbers for this record.") from None
    issues = []
    normalized = deepcopy(data)
    old = fetch_record(conn, kind, str(record_id)) if record_id else None
    combined = {**(old["data"] if old else {}), **normalized}
    farm = fetch_record(conn, "farms", str(combined["farm_id"])) if combined.get("farm_id") else None
    if farm:
        normalized["farm_id"] = farm["id"]
    journal_input = kind == "operations" and combined.get("type") == "pesticide_application" and ("cz_ppp" in combined or farm and farm["data"].get("country") == "CZ")
    for field in ("quantity", "amount", "tax_amount", "tax_rate", "hours", "area_ha", "dose", "treated_size"):
        if field in normalized:
            normalized[field] = _number(normalized[field], field, issues)
    unit = combined.get("unit")
    if unit is not None and not isinstance(unit, str):
        _issue(issues, "invalid_unit", "Enter a unit name, or leave it blank when it is unknown.", "unit", "error")
        unit = None
    if isinstance(unit, str):
        # A mapped journal retains its supplied unit spelling alongside the
        # original numeric text; an alias is not an authority unit conversion.
        canonical = unit if journal_input else UNIT_ALIASES.get(unit.strip(), unit.strip())
        if canonical != unit:
            _issue(issues, "unit_spelling", f"The unit will be saved as {canonical}. Check that this is the unit you meant.", "unit")
            normalized["unit"] = canonical
        unit = canonical
        if unit and unit not in KNOWN_UNITS:
            _issue(issues, "unfamiliar_unit", "This unit is not in the usual list. Check its spelling and meaning before saving.", "unit")
    if kind == "facts" and "value" in normalized and (unit in KNOWN_UNITS or value_type == "number") and normalized["value"] is not None:
        normalized["value"] = _number(normalized["value"], "value", issues)
    combined.update(normalized)
    event_date = combined.get("date")
    if (kind in {"operations", "purchases"} and event_required) or kind == "sales":
        if not event_date:
            _issue(issues, "event_date_required", "When did this happen? Enter the actual date; an annual total is a different kind of record.", "date", "error")
        else:
            normalized.setdefault("temporal_basis", "calendar_date")
            normalized.setdefault("period", event_date)
            if combined.get("temporal_basis") not in (None, "calendar_date") or combined.get("period") not in (None, event_date):
                _issue(issues, "event_period_conflict", "The date and reporting period describe different things. Keep annual summaries separate from dated work.", "period", "error")
    if event_date:
        try:
            observed = date.fromisoformat(event_date)
            if observed > date.today():
                _issue(issues, "future_event", "This date is in the future. Save planned work as a task; record work after it happens.", "date", "error")
            if reporting_year and observed.year != reporting_year:
                _issue(issues, "different_calendar_year", "This date is outside the year you are reviewing. Check that you selected the right year.", "date")
        except (ValueError, TypeError):
            _issue(issues, "date_format", "Enter a date in YYYY-MM-DD format.", "date", "error")
    combined.update(normalized)
    if reporting_year and combined.get("temporal_basis") == "campaign_year" and str(combined.get("period")) != str(reporting_year):
        _issue(issues, "campaign_year_conflict", "This value belongs to another campaign year. Choose the intended year before saving.", "period", "error")
    quantity = combined.get("quantity")
    numeric_quantity = isinstance(quantity, (int, float)) and not isinstance(quantity, bool)
    if numeric_quantity and quantity != 0 and not unit:
        _issue(issues, "unit_required", "What unit is this quantity in? Choose it before saving.", "unit", "error")
    if kind == "operations":
        operation_type = combined.get("type") if isinstance(combined.get("type"), str) else ""
        if event_required and strict_type and operation_type not in OPERATION_TYPES:
            _issue(issues, "work_type_required", "Choose the kind of work or animal event you recorded.", "type", "error")
        if isinstance(operation_type, str) and operation_type.startswith("animal_"):
            if not numeric_quantity or quantity <= 0 or int(quantity) != quantity or unit != "head":
                _issue(issues, "animal_count", "Enter a positive whole number of animals and use head as the unit.", "quantity", "error")
        dose = combined.get("dose")
        recorded_ppp_dose = (operation_type == "pesticide_application"
                             and isinstance(dose, (int, float)) and not isinstance(dose, bool)
                             and dose > 0 and bool(combined.get("dose_unit")))
        if operation_type in APPLICATION_TYPES | {"harvest", "irrigation"} and not recorded_ppp_dose and (not numeric_quantity or quantity <= 0):
            _issue(issues, "work_quantity_required", "How much did you actually use or harvest? Enter a positive quantity and its unit.", "quantity", "error")
        expected_units = {"harvest": {"kg", "t", "g"}, "irrigation": {"l", "m3", "mm"}}
        if operation_type in expected_units and unit and unit not in expected_units[operation_type]:
            _issue(issues, "unit_does_not_match_work", "This unit does not match the selected kind of work. Check the quantity and unit together.", "unit", "error")
        if operation_type in APPLICATION_TYPES and unit in {"kg/ha", "g/ha", "l/ha", "ml/ha"}:
            _issue(issues, "dose_not_total", "This is a dose per hectare, not a total amount. Record the treated field or explain the treated area in your note.", "unit")
        if operation_type == "pesticide_application":
            # Missing legal details must remain visible, but a farmer can retain
            # an incomplete draft now instead of losing the event entirely.
            required = {
                "treatment_type": "Choose whether this was a field, closed-space or seed treatment.",
                "product_authorisation": "Add the product authorisation number from its label or your original record.",
                "dose": "Add the actual dose, separately from the total amount used.",
                "dose_unit": "Add the unit of the actual dose.",
                "treated_size": "Add the size or amount actually treated, not the whole farm size.",
                "treated_unit": "Add the unit of the treated area, volume or quantity.",
                "treated_location": "Add the recorded land reference, facility or seed-batch location. A private field name may not be an official identifier.",
            }
            for field, message in required.items():
                if combined.get(field) in (None, ""):
                    _issue(issues, "ppp_missing_" + field, message, field)
            treated = combined.get("treated_size")
            dose = combined.get("dose")
            for field, value in (("dose", dose), ("treated_size", treated)):
                if isinstance(value, (float, int)) and not isinstance(value, bool) and value <= 0:
                    _issue(issues, "ppp_positive_" + field, "Enter the positive amount from the actual treatment record.", field, "error")
            choices = {"surface": {"ha"}, "closed_space": {"m2", "m3"}, "seed": {"kg", "t", "seeds"}}
            treatment_type = combined.get("treatment_type")
            if treatment_type in choices and combined.get("treated_unit") and combined["treated_unit"] not in choices[treatment_type]:
                _issue(issues, "ppp_extent_unit_review", "Check the original unit against this treatment type. Do not silently convert the quantity.", "treated_unit")
            for flag, field, label in (("label_time_required", "start_time", "start time"), ("label_growth_stage_required", "bbch_stage", "growth stage")):
                if combined.get(flag) is True and not combined.get(field):
                    _issue(issues, "ppp_missing_" + field, f"The label needs the {label}; add it from the actual treatment record.", field)
                elif combined.get(flag) is None:
                    _issue(issues, "ppp_check_" + flag, f"Check whether the product label requires the {label}. Not known is not an exemption.", flag)
        source_documents = [source.get("document_id") for source in combined.get("sources", []) if isinstance(source, dict) and source.get("document_id")] if isinstance(combined.get("sources", []), list) else []
        if combined.get("document_id"):
            source_documents.append(combined["document_id"])
        for document_id in dict.fromkeys(str(value) for value in source_documents):
            if operation_type not in APPLICATION_TYPES:
                break
            document = fetch_record(conn, "documents", document_id)
            details = document["data"]
            extraction = details.get("extraction") if isinstance(details.get("extraction"), dict) else {}
            document_type = details.get("document_type") or details.get("category") or extraction.get("document_type")
            if document_type in ("receipt", "invoice"):
                _issue(issues, "purchase_is_not_use", "A receipt shows what you bought. Confirm the application date, field and quantity from what you actually used.", "document_id")
    if kind in {"purchases", "sales"}:
        sale = kind == "sales"
        if combined.get("amount") is None:
            _issue(issues, "amount_required", "Enter the actual total shown on the sale or sales invoice." if sale else "Enter the receipt total, or return when the amount is known.", "amount", "error")
        elif isinstance(combined["amount"], (int, float)):
            if combined["amount"] < 0 and combined.get("credit") is not True:
                _issue(issues, "negative_sale" if sale else "negative_receipt", "This is a negative amount. Check that it is a credit, refund or other negative entry.", "amount")
            elif combined["amount"] == 0:
                _issue(issues, "zero_sale" if sale else "zero_receipt", "The sale total is zero. Check that the amount has not been left out." if sale else "The receipt total is zero. Check that the amount has not been left out.", "amount")
    try:
        normalized = validate_data(conn, kind, normalized, old["data"] if old else None, record_id=record_id)
        if journal_input:
            from .ppp_journal import journal_issues
            for issue in journal_issues(normalized):
                # An actual incomplete event may be retained. The report keeps
                # the original error severity and will not approve it as complete.
                _issue(issues, issue["code"], issue["message"], issue["field"])
        if kind == "facts" and normalized.get("key") == "cz.ppp.holder":
            from .ppp_journal import holder_issues
            for issue in holder_issues(normalized["value"]):
                _issue(issues, issue["code"], issue["message"], issue["field"])
    except ApiError as exc:
        if exc.status not in {409, 422}:
            raise
        field = exc.details.get("field")
        _issue(issues, exc.code, exc.message, field, "error")
    peers = []
    if farm:
        if kind == "facts":
            peer_rows = conn.execute("SELECT id,revision,data FROM records WHERE kind='facts' AND data->>'farm_id'=%s "
                "AND data->>'key'=%s AND coalesce(data->>'review_status','proposed')<>'rejected' AND deleted_at IS NULL ORDER BY id LIMIT 201",
                (farm["id"], str(normalized.get("key", "")))).fetchall()
        else:
            peer_date = normalized.get("date") if isinstance(normalized.get("date"), str) else None
            peer_period = normalized.get("period") if isinstance(normalized.get("period"), str) else None
            peer_rows = conn.execute("SELECT id,revision,data FROM records WHERE kind=%s AND data->>'farm_id'=%s "
                "AND (data->>'date' IS NOT DISTINCT FROM %s::text OR (%s::text IS NULL AND data->>'period' IS NOT DISTINCT FROM %s::text)) "
                "AND coalesce(data->>'review_status','proposed')<>'rejected' AND deleted_at IS NULL ORDER BY id LIMIT 201",
                (kind, farm["id"], peer_date, peer_date, peer_period)).fetchall()
        peers = [peer for peer in json_safe(peer_rows) if peer["id"] != str(record_id)]
        if len(peers) > 200:
            _issue(issues, "many_matching_records", "There are many records for this date or detail. Check the saved records for duplicates before continuing.")
        duplicate_ids, conflicting_ids, schema_ids = [], [], []
        for peer in peers:
            candidate = peer["data"]
            if physical_identity(candidate) != physical_identity(normalized):
                continue
            if kind == "facts":
                if candidate.get("temporal_basis") != normalized.get("temporal_basis"):
                    schema_ids.append(peer["id"])
                elif candidate.get("period") == normalized.get("period"):
                    if (candidate.get("value"), candidate.get("unit")) == (normalized.get("value"), normalized.get("unit")):
                        duplicate_ids.append(peer["id"])
                    elif peer["id"] != normalized.get("supersedes_id"):
                        conflicting_ids.append(peer["id"])
            else:
                if kind in {"purchases", "sales"}:
                    fields = ("date", "amount", "currency", "buyer" if kind == "sales" else "supplier", "invoice_number")
                else:
                    fields = ("date", "type", "quantity", "unit", "parcel", "product")
                if all(candidate.get(field) == normalized.get(field) for field in fields):
                    duplicate_ids.append(peer["id"])
        if duplicate_ids:
            _issue(issues, "possible_duplicate", "A matching record is already saved. Open it before adding the same detail again.", record_ids=duplicate_ids)
        if conflicting_ids:
            _issue(issues, "different_fact_value", "Another source gives a different answer for the same period. Keep both sources and resolve the difference during review.", record_ids=conflicting_ids)
        if schema_ids:
            _issue(issues, "different_time_basis", "This detail was recorded with a different time basis before. Check whether it is a standing detail, annual summary or dated event.", "temporal_basis", record_ids=schema_ids)
    warnings = sorted({item["code"] for item in issues if item["severity"] == "warning"})
    token = _digest({"kind": kind, "input": data, "record_id": str(record_id) if record_id else None,
        "reporting_year": reporting_year, "event_required": event_required, "value_type": value_type, "strict_type": strict_type, "date": date.today().isoformat(),
        "farm_revision": farm["revision"] if farm else None, "current_revision": old["revision"] if old else None,
        "normalized_data": normalized, "issues": issues, "peers": [{"id": p["id"], "revision": p["revision"]} for p in peers]})
    return {"normalized_data": normalized, "issues": issues, "can_save": not any(i["severity"] == "error" for i in issues),
            "requires_acknowledgement": warnings, "check_token": token}


@router.post("/check")
def check_record(body: CaptureCheck, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        if body.record_id:
            current = fetch_record(conn, body.kind, str(body.record_id))
            if body.expected_revision is None:
                raise ApiError(422, "revision_required", "Reload the record before checking changes.")
            if body.expected_revision != current["revision"]:
                raise ApiError(409, "revision_conflict", "The saved record changed. Compare it with your entries before trying again.", {"current_revision": current["revision"]})
        return check_capture(conn, body.kind, body.data, str(body.record_id) if body.record_id else None, body.reporting_year)


@router.post("/capture", status_code=201)
def capture_record(body: CaptureInput, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        def perform():
            existing = fetch_record(conn, body.kind, str(body.record_id)) if body.record_id else None
            farm_id = body.data.get("farm_id") or (existing["data"].get("farm_id") if existing else None)
            if farm_id:
                fetch_record(conn, "farms", str(farm_id))
                conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm_id}",))
            checked = check_capture(conn, body.kind, body.data, str(body.record_id) if body.record_id else None, body.reporting_year)
            if not checked["can_save"]:
                raise ApiError(422, "capture_needs_changes", "Please correct the highlighted details before saving.", checked)
            if checked["requires_acknowledgement"] and body.check_token != checked["check_token"]:
                raise ApiError(409, "check_changed", "Review the current checks before saving this record.", checked)
            missing = set(checked["requires_acknowledgement"]) - set(body.acknowledged_codes)
            if missing:
                raise ApiError(422, "checks_need_acknowledgement", "Confirm the highlighted checks before saving.", {**checked, "missing_codes": sorted(missing)})
            if body.record_id:
                if body.expected_revision is None:
                    raise ApiError(422, "revision_required", "Reload the record before saving changes.")
                record = update_record(conn, body.kind, str(body.record_id), body.expected_revision, checked["normalized_data"])
            else:
                record = insert_record(conn, body.kind, checked["normalized_data"])
            return {"record": record, "issues": checked["issues"], "message": "Saved for review. Nothing has been confirmed automatically."}
        return idempotent(conn, idempotency_key, "workflow-capture", body.model_dump(mode="json"), perform)


def _requirements(pack, request_data):
    from .reporting import _field_specs
    combined = {}
    mapped = {}
    for field in (_field_specs(pack) if pack else []):
        prepared = {**field, "key": field["fact_key"]}
        combined[(field["fact_key"], physical_identity(field), field.get("period"))] = prepared
        mapped[field["fact_key"]] = prepared
    for field in request_data.get("requirements", []):
        key = field.get("key") or field.get("fact_key")
        if not key:
            continue
        identity = (key, physical_identity(field), field.get("period"))
        previous = combined.get(identity) or mapped.get(key)
        if previous:
            # A manually entered request can add questions and clarify labels;
            # the mapped format's unit, time basis and required fields remain.
            merged = {**previous, **{name: value for name, value in field.items() if name not in {"unit", "temporal_basis", "required", "type", "value_type", "choices", "enum", "format"}}}
            merged["required"] = previous.get("required", True) or field.get("required", True)
            combined[identity] = merged
        else:
            combined[identity] = deepcopy(field)
    return list(combined.values())


def _physical_labels(farm_data):
    labels = {None: "Farm details"}
    for index, parcel in enumerate(farm_data.get("parcels", [])):
        if isinstance(parcel, dict):
            labels[str(parcel.get("id") or f"legacy-{index}")] = str(parcel.get("name") or "Field")
    for index, site in enumerate(farm_data.get("sites", [])):
        if not isinstance(site, dict):
            continue
        site_id = str(site.get("id") or f"site-{index}")
        labels[site_id] = str(site.get("name") or "Site")
        for field_index, parcel in enumerate(site.get("parcels", [])):
            if isinstance(parcel, dict):
                labels[str(parcel.get("id") or f"{site_id}:parcel-{field_index}")] = f"{labels[site_id]}: {parcel.get('name') or 'Field'}"
    return labels


def _question_items(requirements, facts, request_data, farm_data, excluded, pack=None):
    """One question per supplied field and actual dated event, never a farm recopy."""
    year = request_data.get("reporting_year")
    labels = _physical_labels(farm_data)
    relevant_keys = {item.get("key") or item.get("fact_key") for item in requirements}
    active = [fact for fact in facts if fact["data"].get("review_status") != "rejected" and fact["id"] not in excluded]
    questions, completed, seen = [], 0, set()
    for requirement in requirements:
        if requirement.get("fact_key_prefix"):
            # A source table is reviewed row by row, never answered as one
            # scalar fact under the bare namespace prefix.
            continue
        key = requirement.get("key") or requirement.get("fact_key")
        if not isinstance(key, str) or not key:
            continue
        basis = requirement.get("temporal_basis")
        explicit_group = physical_identity(requirement)
        explicit_period = requirement.get("period")
        own = [fact for fact in active if fact["data"].get("key") == key]
        in_period = [fact for fact in active if fact["data"].get("key") in relevant_keys
            and matches_reporting_period(fact["data"], year, basis=basis)]
        if basis == "calendar_date":
            contexts = {(physical_identity(fact["data"]), fact["data"].get("period"), basis) for fact in in_period
                if (explicit_group is None or physical_identity(fact["data"]) == explicit_group)
                and (explicit_period is None or fact["data"].get("period") == explicit_period)}
        elif basis is None:
            contexts = {(physical_identity(fact["data"]), None if fact["data"].get("temporal_basis") == "static" else fact["data"].get("period"), fact["data"].get("temporal_basis")) for fact in own
                if matches_reporting_period(fact["data"], year)
                and (explicit_group is None or physical_identity(fact["data"]) == explicit_group)
                and (explicit_period is None or fact["data"].get("period") == explicit_period)}
        else:
            contexts = {(physical_identity(fact["data"]), str(year) if basis == "campaign_year" else None, basis) for fact in own
                if matches_reporting_period(fact["data"], year, basis=basis)
                and (explicit_group is None or physical_identity(fact["data"]) == explicit_group)}
        if not contexts:
            prior_groups = {physical_identity(fact["data"]) for fact in own if physical_identity(fact["data"]) is not None}
            groups = {explicit_group} if explicit_group is not None else prior_groups or {None}
            contexts = {(group, explicit_period if explicit_period is not None else str(year) if basis == "campaign_year" else None, basis) for group in groups}
        for group, context_period, context_basis in sorted(contexts, key=lambda item: (str(item[0]), str(item[1]), str(item[2]))):
            question_id = _digest([key, group, context_basis, context_period])
            if question_id in seen:
                continue
            seen.add(question_id)
            if len(seen) > 2000:
                raise ApiError(422, "too_many_questions", "This request covers many field events. Select a narrower set of fields or dates before continuing.")
            matches = [fact for fact in own if physical_identity(fact["data"]) == group
                and matches_reporting_period(fact["data"], year, basis=context_basis, period=context_period)
                and (not requirement.get("unit") or fact["data"].get("unit") == requirement["unit"])]
            confirmed = [fact for fact in matches if fact["data"].get("review_status") == "confirmed" and fact["data"].get("value") is not None]
            proposals = [fact for fact in matches if fact["data"].get("review_status") == "proposed"]
            holder_issues = []
            if key == "cz.ppp.holder":
                from .ppp_journal import holder_issues as check_holder, validate_holder
                for fact in confirmed:
                    try:
                        holder_issues.extend(check_holder(validate_holder(fact["data"]["value"])))
                    except ApiError as exc:
                        holder_issues.append({"code": exc.code, "severity": "error", "field": "value", "message": exc.message})
            conflict = len({_digest([fact["data"].get("value"), fact["data"].get("unit")]) for fact in confirmed}) > 1
            if confirmed and not conflict and not proposals and not holder_issues:
                completed += 1
                continue
            choices = requirement.get("choices", requirement.get("enum", []))
            choices = [{"value": item.get("value"), "label": str(item.get("label", item.get("value")))} if isinstance(item, dict)
                else {"value": item, "label": str(item)} for item in choices] if isinstance(choices, list) else []
            value_type = requirement.get("value_type", requirement.get("type"))
            if choices:
                value_type = "choice"
            elif value_type in ("number", "integer", "decimal") or requirement.get("unit") in KNOWN_UNITS:
                value_type = "number"
            elif value_type == "boolean":
                value_type = "boolean"
            elif key in {"cz.ppp.holder", "pt.ppp.surface_journal"} and value_type == "object":
                value_type = "object"
            elif value_type == "date" or requirement.get("format") == "date" or (context_basis == "calendar_date" and (key == "date" or key.endswith("_date"))):
                value_type = "date"
            else:
                value_type = "text"
            label = str(requirement.get("label", key))
            physical_label = labels.get(group, f"Recorded field {group}")
            context = f" for {physical_label}" if group is not None else ""
            if context_basis == "calendar_date" and context_period:
                context += f" on {context_period}"
            questions.append({"id": question_id, "key": key, "parcel_id": group, "physical_label": physical_label,
                "label": label, "prompt": f"What is the answer for {label.lower()}{context}?", "required": requirement.get("required", True),
                "value_type": value_type, "unit": requirement.get("unit"), "temporal_basis": context_basis, "period": context_period,
                "choices": choices, "proposals": proposals, "confirmed": confirmed,
                "state": "conflict" if conflict else "proposed" if proposals else "incomplete" if holder_issues else "missing",
                "capture_kind": requirement.get("capture_kind"), "issues": holder_issues,
                "source_references": deepcopy(requirement.get("sources", pack.get("sources", []) if pack else []))})
    return questions, completed


def _question_context(conn, request_id, *, journal_limit=50, journal_offset=0):
    from .reporting import _matches_requirement, _pack_year_matches, get_pack
    from .reconciliation import selected_fact_ids
    request = fetch_record(conn, "requests", str(request_id))
    data = request["data"]
    farm = fetch_record(conn, "farms", data["farm_id"])
    blocked = []
    pack = None
    try:
        pack = get_pack(data["pack_id"])
    except ApiError as exc:
        if exc.status != 404:
            raise
        blocked.append("The selected reporting format is unavailable. Check the request before preparing a response.")
    if data.get("country") != farm["data"].get("country"):
        blocked.append("The request and farm have different countries. Check the request's country.")
    if pack:
        if pack.get("country") and pack["country"] != farm["data"].get("country"):
            blocked.append("Choose a format for this farm's country.")
        if pack.get("region") and pack["region"] != farm["data"].get("region"):
            blocked.append("This format belongs to a different region. Choose the correct regional format.")
        if not _pack_year_matches(pack, data.get("reporting_year")):
            blocked.append("This format does not cover the selected reporting year.")
    requirements = _requirements(pack, data)
    if not requirements:
        blocked.append("This request has no reviewed questions yet. Review its requirements or select a format with defined fields.")
    facts = _farm_records(conn, farm["id"], ["facts"])
    excluded = selected_fact_ids(conn, farm["id"])["excluded_fact_ids"]
    questions, completed = _question_items(requirements, facts, data, farm["data"], excluded, pack)
    for question in questions:
        if question["key"] == "pt.ppp.surface_journal":
            question["completion_url"] = f"/app/record-work?farm_id={farm['id']}&pt_journal_request={request['id']}#portuguese-journal"
    source_tables = []
    for requirement in requirements:
        if not requirement.get("fact_key_prefix") or not requirement.get("import_profile"):
            continue
        matching = [fact for fact in facts if fact["id"] not in excluded and _matches_requirement(fact, requirement, data["reporting_year"])]
        source_tables.append({"profile_id": requirement["import_profile"], "label": requirement["label"],
            "confirmed_count": sum(fact["data"].get("review_status") == "confirmed" for fact in matching),
            "proposed_count": sum(fact["data"].get("review_status") == "proposed" for fact in matching),
            "import_url": f"/app/imports?profile={requirement['import_profile']}&farm_id={farm['id']}",
            "review_url": f"/app/fields/{farm['id']}#facts"})
    journals = []
    if pack and pack.get("journal_schema") == "cz-ppp-journal-v1":
        from .ppp_journal import COLUMNS, HOLDER_KEY, NOTICE, SCHEMA_ID, SOURCE, active_entries, journal_issues
        ledger = _farm_records(conn, farm["id"], ["operations"])
        active_ids = {entry["id"] for entry in active_entries(ledger)}
        entries = []
        for item in ledger:
            value = item["data"]
            if value.get("type") != "pesticide_application" or value.get("review_status") == "rejected":
                continue
            try:
                in_year = date.fromisoformat(value.get("date")).year == data["reporting_year"]
            except (ValueError, TypeError):
                in_year = False
            if not in_year:
                continue
            try:
                issues = journal_issues(value)
            except ApiError as exc:
                issues = [{"code": exc.code, "severity": "error", "field": exc.details.get("field"), "message": exc.message}]
            destination = f"/app/paperwork/{request['id']}?journal_operation_id={item['id']}"
            entries.append({"operation_id": item["id"], "operation_revision": item["revision"], "title": value.get("title"),
                "date": value.get("date"), "review_status": value.get("review_status", "proposed"),
                "supersedes_id": value.get("supersedes_id"), "active": item["id"] in active_ids, "issues": issues,
                "completion_url": destination, "review_url": destination + "&review=1"})
        entries.sort(key=lambda entry: (entry["date"], entry["operation_id"]))
        current = [entry for entry in entries if entry["active"]]
        journals.append({"schema_id": SCHEMA_ID, "pack_id": pack["id"], "source": deepcopy(SOURCE), "title": pack["title"],
            "holder_fact_key": HOLDER_KEY, "columns": deepcopy(COLUMNS), "entries": entries[journal_offset:journal_offset + journal_limit],
            "pagination": {"total": len(entries), "limit": journal_limit, "offset": journal_offset,
                "next_offset": journal_offset + journal_limit if journal_offset + journal_limit < len(entries) else None},
            "counts": {"total": len(current), "confirmed": sum(entry["review_status"] == "confirmed" for entry in current),
                "proposed": sum(entry["review_status"] == "proposed" for entry in current),
                "incomplete": sum(any(issue["severity"] == "error" for issue in entry["issues"]) for entry in current),
                "pending": sum(any(issue["code"] in {"cz_ppp_pending_efficacy", "cz_ppp_pending_crop_end"} for issue in entry["issues"]) for entry in current)},
            "add_url": f"/app/paperwork/{request['id']}?journal_new=1", "holder_url": f"/app/paperwork/{request['id']}#questions", "notice": NOTICE})
    return {"request": request, "questions": questions, "completed_count": completed,
            "total_count": completed + len(questions), "blocked_reasons": blocked, "source_tables": source_tables, "journals": journals}


@router.get("/questions")
def guided_questions(request_id: UUID, journal_limit: int = Query(default=50, ge=1, le=200), journal_offset: int = Query(default=0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return _question_context(conn, str(request_id), journal_limit=journal_limit, journal_offset=journal_offset)


@router.post("/answer")
def guided_answer(body: GuidedAnswer, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        def perform():
            context = _question_context(conn, str(body.request_id))
            request = context["request"]
            if request["revision"] != body.expected_request_revision:
                raise ApiError(409, "revision_conflict", "The request changed. Review its latest questions before saving.")
            if context["blocked_reasons"]:
                raise ApiError(422, "request_needs_review", "Check this request before answering its questions.", {"reasons": context["blocked_reasons"]})
            candidates = [item for item in context["questions"] if item["key"] == body.key]
            if body.question_id:
                candidates = [item for item in candidates if item["id"] == body.question_id]
            elif body.parcel_id is not None:
                candidates = [item for item in candidates if item["parcel_id"] == body.parcel_id]
            if not body.question_id and body.period is not None:
                candidates = [item for item in candidates if item["period"] in (None, body.period)]
            if len(candidates) > 1:
                raise ApiError(422, "question_scope_required", "Choose the specific field and dated question before answering.", {"question_ids": [item["id"] for item in candidates]})
            question = candidates[0] if candidates else None
            if question is None:
                raise ApiError(409, "question_already_answered", "This question is already answered or no longer belongs to the request. Refresh the questions.")
            if question["key"] == "pt.ppp.surface_journal":
                raise ApiError(422, "journal_editor_required", "Open the Portuguese journal to review the individual rows and dates.", {"fix_url": question.get("completion_url")})
            if body.parcel_id is not None and body.parcel_id != question["parcel_id"]:
                raise ApiError(422, "answer_field_scope", "The selected question belongs to another field. Refresh the questions before saving.")
            if question["state"] == "conflict":
                raise ApiError(409, "conflicting_answers", "Compare the confirmed sources and resolve their difference before recording another answer.", {"fact_ids": [item["id"] for item in question["confirmed"]]})
            if not body.note.strip():
                raise ApiError(422, "source_note_required", "Record where you checked this answer.")
            if question["value_type"] == "choice" and not any(_digest(body.value) == _digest(item["value"]) for item in question["choices"]):
                raise ApiError(422, "answer_choice", "Choose one of the options supplied for this question.")
            if question["value_type"] == "boolean" and not isinstance(body.value, bool):
                raise ApiError(422, "answer_boolean", "Answer yes or no for this question.")
            if question["value_type"] == "text" and body.value is not None and not isinstance(body.value, str):
                raise ApiError(422, "answer_text", "Enter the text requested by this question.")
            if question["value_type"] == "object" and not isinstance(body.value, dict):
                raise ApiError(422, "answer_object", "Complete the structured holder details requested by this journal.")
            if question["value_type"] == "date" and body.value is not None:
                try:
                    date.fromisoformat(body.value)
                except (ValueError, TypeError):
                    raise ApiError(422, "answer_date", "Enter the answer date in YYYY-MM-DD format.") from None
            basis = question["temporal_basis"] or body.temporal_basis
            period = question["period"] if question["period"] is not None else body.period
            if basis is None:
                raise ApiError(422, "answer_time_basis", "Choose whether this is a standing detail, campaign-year answer or dated observation.")
            if body.temporal_basis and question["temporal_basis"] and body.temporal_basis != question["temporal_basis"]:
                raise ApiError(422, "answer_time_basis", "This answer must use the time basis defined by the request.")
            if body.period is not None and question["period"] is not None and body.period != question["period"]:
                raise ApiError(422, "answer_period", "The answer period does not match this question. Choose the correct event or reporting period.")
            if basis == "campaign_year":
                period = str(request["data"]["reporting_year"])
            elif basis == "static":
                if body.period not in (None, ""):
                    raise ApiError(422, "answer_period", "A standing reference does not have an annual or event date. Check the time basis before saving.")
                period = None
            elif basis == "calendar_date":
                if body.period is not None and question["period"] is not None and body.period != question["period"]:
                    raise ApiError(422, "answer_event_date", "Use the actual date of this question's event. Choose another event to record a different date.")
                if period is None and question["value_type"] == "date" and isinstance(body.value, str):
                    period = body.value
                if not matches_reporting_period({"temporal_basis": "calendar_date", "period": period}, request["data"]["reporting_year"]):
                    raise ApiError(422, "answer_event_date", "Enter the actual event date in this reporting year. A year alone is not an observation date.")
                if question["value_type"] == "date" and body.value is not None and body.value != period:
                    raise ApiError(422, "answer_event_date", "The supplied date and event date differ. Check both before saving this answer.")
            draft = {"farm_id": request["data"]["farm_id"], "key": body.key, "label": question["label"],
                "value": body.value, "unit": question["unit"] if question["unit"] is not None else body.unit,
                "temporal_basis": basis, "period": period, "review_status": "proposed", "sources": [*body.sources,
                    {"kind": "manual", "note": body.note, "request_id": request["id"], "request_revision": request["revision"]}]}
            if question["parcel_id"] is not None:
                draft["parcel_id"] = question["parcel_id"]
            if question["unit"] is not None and body.unit is not None and body.unit != question["unit"]:
                raise ApiError(422, "answer_unit", "Use the unit requested by this field. Convert a different source unit only through an explicitly checked conversion.")
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{draft['farm_id']}",))
            checked = check_capture(conn, "facts", draft, reporting_year=request["data"]["reporting_year"], value_type=question["value_type"])
            if question["value_type"] == "number" and body.value is not None:
                value = checked["normalized_data"].get("value")
                if not isinstance(value, (int, float)) or isinstance(value, bool):
                    _issue(checked["issues"], "answer_number", "Enter a number for this question.", "value", "error")
                    checked["can_save"] = False
            if body.preview:
                return {"check": checked, "question": question}
            if not checked["can_save"]:
                raise ApiError(422, "answer_needs_changes", "Correct the highlighted details before saving this answer.", checked)
            if checked["requires_acknowledgement"] and body.check_token != checked["check_token"]:
                raise ApiError(409, "check_changed", "Review the current answer checks before saving.", checked)
            if set(checked["requires_acknowledgement"]) - set(body.acknowledged_codes):
                raise ApiError(422, "checks_need_acknowledgement", "Confirm the highlighted checks before saving this answer.", checked)
            record = insert_record(conn, "facts", checked["normalized_data"])
            return {"record": record, "issues": checked["issues"], "message": "Your answer is saved as a proposal. Check and confirm it before preparing the response."}
        if body.preview:
            return perform()
        return idempotent(conn, idempotency_key, "workflow-answer", body.model_dump(mode="json"), perform)


def _annual_items(facts, year):
    groups = {}
    for fact in facts:
        data = fact["data"]
        if data.get("review_status") != "confirmed":
            continue
        basis = data.get("temporal_basis")
        if basis not in {"static", "campaign_year"} or (basis == "campaign_year" and str(data.get("period")) != str(year - 1)):
            continue
        key = data.get("key")
        current = [f for f in facts if f["data"].get("key") == key and physical_identity(f["data"]) == physical_identity(data) and f["data"].get("review_status") != "rejected"
            and f["data"].get("temporal_basis") == "campaign_year" and str(f["data"].get("period")) == str(year)]
        financial_source = any(isinstance(source, dict) and source.get("record_kind") in ("sale", "sales") for source in data.get("sources", []))
        reusable = basis == "static" or (not financial_source and not ANNUAL_EXCLUDED_KEYS.search(str(key)))
        groups.setdefault((key, basis, physical_identity(data)), []).append({"source": fact, "current": current, "reusable": reusable})
    items = []
    for (key, basis, parcel_id), candidates in groups.items():
        differing = len({_digest([item["source"]["data"].get("value"), item["source"]["data"].get("unit")]) for item in candidates}) > 1
        for item in candidates:
            source = item["source"]
            status = "conflict" if differing else "static_reference" if basis == "static" else "already_recorded" if item["current"] else "needs_new_observation" if not item["reusable"] else "needs_review"
            items.append({"key": key, "parcel_id": parcel_id, "label": source["data"].get("label", key), "status": status,
                "source": source, "current": item["current"], "source_age_days": max(0, (date.today() - datetime.fromisoformat(source["created_at"]).date()).days),
                "can_reuse": item["reusable"] and not differing and not item["current"],
                "message": "This remains a standing reference. Reviewing it does not make it a new annual observation." if basis == "static" else
                    "Record this year's actual amount. Payments, costs and work totals are not copied as new events." if not item["reusable"] else
                    "Check whether this answer still describes the new campaign year. A reused answer still needs confirmation."})
    return sorted(items, key=lambda item: (str(item["key"]), item["source"]["id"]))


def _annual_review(conn, farm_id, year):
    from .reconciliation import selected_fact_ids
    farm = fetch_record(conn, "farms", str(farm_id))
    facts = _farm_records(conn, farm["id"], ["facts"])
    excluded = selected_fact_ids(conn, farm["id"])["excluded_fact_ids"]
    facts = [fact for fact in facts if fact["id"] not in excluded]
    items = _annual_items(facts, year)
    decisions = _farm_records(conn, farm["id"], ["annual_reviews"])
    reviewed = {row["data"].get("source_fact_id"): row for row in reversed(decisions) if row["data"].get("year") == year}
    for item in items:
        item["review"] = reviewed.get(item["source"]["id"])
    return {"farm_id": farm["id"], "year": year, "previous_year": year - 1, "items": items,
            "reusable_count": sum(item["can_reuse"] and item["review"] is None for item in items),
            "missing_count": sum(not item["current"] and item["source"]["data"].get("temporal_basis") == "campaign_year" and item["review"] is None for item in items)}


@router.get("/annual-review")
def annual_review(farm_id: UUID, year: int = Query(ge=1901, le=2200), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return _annual_review(conn, str(farm_id), year)


@router.post("/annual-review", status_code=201)
def decide_annual_review(body: AnnualDecision, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    if not body.note.strip():
        raise ApiError(422, "review_note_required", "Record what you checked before reusing or changing this answer.")
    with transaction(session) as conn:
        def perform():
            farm_id = str(body.farm_id)
            fetch_record(conn, "farms", farm_id)
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm_id}",))
            source = fetch_record(conn, "facts", str(body.source_fact_id))
            if source["revision"] != body.expected_source_revision:
                raise ApiError(409, "revision_conflict", "The previous answer changed. Review the latest source before continuing.")
            candidate = next((item for item in _annual_review(conn, farm_id, body.year)["items"] if item["source"]["id"] == source["id"]), None)
            if candidate is None or source["data"].get("farm_id") != farm_id:
                raise ApiError(422, "annual_source_unavailable", "Choose a confirmed standing detail or answer from the previous campaign year.")
            if candidate["review"] is not None:
                raise ApiError(409, "annual_answer_already_reviewed", "This annual question already has a saved decision. Review the proposed answer instead.", {"review_id": candidate["review"]["id"]})
            if candidate["status"] == "conflict":
                raise ApiError(409, "source_conflict", "Resolve the different previous answers before reusing one.")
            data = source["data"]
            proposal = None
            if body.decision != "not_applicable":
                if candidate["current"]:
                    raise ApiError(409, "current_answer_exists", "An answer for this year is already saved. Review that answer first.", {"fact_ids": [item["id"] for item in candidate["current"]]})
                if body.decision == "reuse" and not candidate["can_reuse"]:
                    raise ApiError(422, "new_observation_needed", "Enter this year's actual value. A prior amount cannot establish a new observation.")
                if body.decision == "changed" and "value" not in body.model_fields_set:
                    raise ApiError(422, "new_value_required", "Enter the changed answer; choose null only when it is unknown.")
                if data["temporal_basis"] == "static" and body.decision == "reuse":
                    # Retain the reference instead of copying static data into a new year.
                    proposal = None
                else:
                    value = body.value if body.decision == "changed" else data.get("value")
                    draft = {key: deepcopy(data.get(key)) for key in ("farm_id", "key", "label", "unit", "temporal_basis")}
                    if physical_identity(data) is not None:
                        draft["parcel_id"] = physical_identity(data)
                    draft.update(value=value, period=str(body.year) if data["temporal_basis"] == "campaign_year" else None,
                        sources=[*deepcopy(data.get("sources", [])), {"kind": "annual_review", "record_id": source["id"], "revision": source["revision"],
                            "note": body.note, "source_created_at": source["created_at"], "meaning": "Prior answer supplied as a reference; the new answer remains proposed."}],
                        review_status="proposed")
                    if body.decision == "changed" and "unit" in body.model_fields_set:
                        draft["unit"] = body.unit
                    if data["temporal_basis"] == "static":
                        draft["supersedes_id"] = source["id"]
                    proposal = insert_record(conn, "facts", validate_data(conn, "facts", draft))
            review = insert_record(conn, "annual_reviews", {"farm_id": farm_id, "year": body.year, "source_fact_id": source["id"],
                "source_revision": source["revision"], "decision": body.decision, "note": body.note,
                "proposed_fact_id": proposal["id"] if proposal else None, "reviewed_by": session.user_id,
                "reviewed_at": datetime.now(timezone.utc).isoformat(), "static_reference": data["temporal_basis"] == "static"})
            return {"fact": proposal, "review": review, "message": "Your decision is saved. Any new answer remains proposed until you confirm it."}
        return idempotent(conn, idempotency_key, "annual-review", body.model_dump(mode="json"), perform)


def _missing_information(facts, requests, year, farm_data=None):
    missing = []
    for request in requests:
        data = request["data"]
        if data.get("status") == "responded":
            continue
        pack = None
        if data.get("pack_id"):
            from .reporting import get_pack
            try:
                pack = get_pack(data["pack_id"])
            except ApiError:
                missing.append({"code": "pack_unavailable", "label": data.get("title", "Request"), "message": "Choose a supported format before preparing this response.", "request_id": request["id"], "href": f"/app/requests/{request['id']}"})
        questions, _ = _question_items(_requirements(pack, data), facts, data, farm_data or {}, set(), pack)
        for question in questions:
            if not question["required"]:
                continue
            state = question["state"]
            message = "Your confirmed sources give different answers. Compare them before preparing this response." if state == "conflict" else \
                "An answer is saved as a proposal. Check and confirm it before preparing this response." if state == "proposed" else \
                "Check this requested detail. An answer from another field or reporting period cannot replace it."
            missing.append({"code": "different_confirmed_answers" if state == "conflict" else "answer_waiting_review" if state == "proposed" else "confirmed_answer_missing",
                "label": question["label"], "message": message, "request_id": request["id"], "fact_key": question["key"],
                "question_id": question["id"], "parcel_id": question["parcel_id"], "period": question["period"], "physical_label": question["physical_label"],
                "href": f"/app/paperwork/{request['id']}"})
    return missing


def _case_home(conn, farm_id, today):
    active = "kind='admin_cases' AND deleted_at IS NULL AND data->>'farm_id'=%s AND data->>'status' NOT IN ('accepted_recorded','cancelled')"
    count = conn.execute(f"SELECT count(*) AS total FROM records WHERE {active}", (farm_id,)).fetchone()["total"]
    rows = conn.execute(f"SELECT id,data->>'title' AS title,data->>'status' AS status FROM records WHERE {active} "
        "ORDER BY data->>'deadline' NULLS LAST,updated_at DESC,id LIMIT 5", (farm_id,)).fetchall()
    messages = {
        "draft": "Pick up the saved changes, documents and next steps.",
        "ready_to_send": "Check that nothing changed, then follow the sending instructions. Nothing was sent by Funkyfarm.",
        "sent": "You recorded sending this. Keep the actual receipt or reply with this work.",
        "receipt_saved": "A receipt is recorded. Check whether the authority has asked for anything else.",
        "needs_changes": "A reply needs your attention. Work through the requested changes.",
    }
    actions = [{"id": f"case-{row['id']}", "kind": "case", "title": row["title"],
                "message": messages.get(row["status"], "Continue this saved work."),
                "href": f"/app/cases/{row['id']}", "priority": "normal", "record_id": str(row["id"])} for row in rows]
    deadlines_sql = f"""SELECT id AS case_id,data->>'title' AS title,data->>'deadline' AS deadline,NULL::text AS item_id
        FROM records WHERE {active} AND nullif(data->>'deadline','') IS NOT NULL
        UNION ALL
        SELECT r.id AS case_id,i->>'title' AS title,i->>'due_date' AS deadline,i->>'id' AS item_id
        FROM records r CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.data->'items','[]'::jsonb)) i
        WHERE r.kind='admin_cases' AND r.deleted_at IS NULL AND r.data->>'farm_id'=%s
        AND r.data->>'status' NOT IN ('accepted_recorded','cancelled')
        AND i->>'status' NOT IN ('resolved','cancelled') AND nullif(i->>'due_date','') IS NOT NULL"""
    upcoming = conn.execute(f"SELECT count(*) AS total FROM ({deadlines_sql}) d WHERE deadline >= %s", (farm_id, farm_id, today)).fetchone()["total"]
    due = conn.execute(f"SELECT * FROM ({deadlines_sql}) d ORDER BY deadline,case_id,item_id LIMIT 20", (farm_id, farm_id)).fetchall()
    deadlines = [{"id": f"case-{row['case_id']}:{row['item_id'] or 'deadline'}", "title": row["title"],
                  "deadline": row["deadline"], "overdue": row["deadline"] < today,
                  "href": f"/app/cases/{row['case_id']}"} for row in due]
    urgent = [deadline for deadline in deadlines if deadline["overdue"]]
    if urgent:
        actions.insert(0, {"id": urgent[0]["id"], "kind": "case", "title": urgent[0]["title"],
            "message": f"The recorded deadline was {urgent[0]['deadline']}. Open this work to check the next step.",
            "href": urgent[0]["href"], "priority": "high"})
    return {"count": count, "upcoming": upcoming, "actions": actions, "deadlines": deadlines}


def _task_home(conn, farm_id, today):
    # One statement keeps the exact totals and bounded previews in the same
    # database snapshot. Only task identity/date metadata is materialized.
    result = conn.execute("""WITH active AS MATERIALIZED (
        SELECT id,nullif(data->>'due_date','') AS due_date,updated_at
        FROM records WHERE kind='tasks' AND deleted_at IS NULL AND data->>'farm_id'=%s
        AND coalesce(data->>'status','open') IN ('open','in_progress')
    ), counts AS (
        SELECT count(*) AS total,count(due_date) AS dated_total,
            count(*) FILTER (WHERE due_date < %s) AS overdue_total,
            count(*) FILTER (WHERE due_date = %s) AS due_today_total,
            count(*) FILTER (WHERE due_date >= %s) AS upcoming_total FROM active
    ) SELECT counts.*,
        coalesce((SELECT jsonb_agg(to_jsonb(item)) FROM (
            SELECT r.id,r.data->>'title' AS title,r.data->>'description' AS description,a.due_date
            FROM (SELECT * FROM active ORDER BY due_date NULLS LAST,updated_at,id LIMIT 5) a
            JOIN records r ON r.id=a.id ORDER BY a.due_date NULLS LAST,a.updated_at,a.id
        ) item),'[]'::jsonb) AS action_rows,
        coalesce((SELECT jsonb_agg(to_jsonb(item)) FROM (
            SELECT r.id,r.data->>'title' AS title,a.due_date
            FROM (SELECT * FROM active WHERE due_date IS NOT NULL ORDER BY due_date,id LIMIT 20) a
            JOIN records r ON r.id=a.id ORDER BY a.due_date,a.id
        ) item),'[]'::jsonb) AS deadline_rows FROM counts""", (farm_id, today, today, today)).fetchone()
    actions = []
    for row in result["action_rows"]:
        due = row["due_date"]
        message = row["description"] or "A saved task still needs your attention."
        if due:
            message = f"{'The recorded deadline was' if due < today else 'The recorded deadline is'} {due}. {message}"
        actions.append({"id": f"task-{row['id']}", "kind": "task", "title": row["title"] or "Follow up",
            "message": message, "record_id": row["id"], "href": f"/app/tasks/{row['id']}",
            "deadline": due, "overdue": bool(due and due < today),
            "priority": "high" if due and due <= today else "normal"})
    deadlines = [{"id": f"task-{row['id']}", "title": row["title"] or "Follow up", "deadline": row["due_date"],
                  "overdue": row["due_date"] < today, "href": f"/app/tasks/{row['id']}"} for row in result["deadline_rows"]]
    preview = {key: result[key] for key in ("total", "dated_total", "overdue_total", "due_today_total", "upcoming_total")}
    preview.update(actions_returned=len(actions), deadlines_returned=len(deadlines),
        actions_truncated=result["total"] > len(actions), deadlines_truncated=result["dated_total"] > len(deadlines),
        href=f"/app/tasks?farm_id={farm_id}")
    return {"actions": actions, "deadlines": deadlines, "preview": preview}


def _home(conn, farm_id, year):
    farms = list_records(conn, "farms", 200)["items"]
    farm = fetch_record(conn, "farms", str(farm_id)) if farm_id else (farms[0] if farms else None)
    summary = {"open_requests": 0, "open_cases": 0, "open_tasks": 0, "dated_tasks": 0, "overdue_tasks": 0,
        "due_today_tasks": 0, "upcoming_task_deadlines": 0, "proposed_facts": 0, "proposed_operations": 0,
        "proposed_purchases": 0, "proposed_sales": 0, "upcoming_deadlines": 0}
    if farm is None:
        return {"farm": None, "farms": farms, "summary": summary,
            "next_actions": [{"id": "add-farm", "kind": "onboarding", "title": "Tell us about your farm", "message": "Add your country and farm type so we can show the right next steps.", "href": "/app/farm", "priority": "high"}],
            "missing_information": [{"code": "farm_missing", "label": "Farm details", "message": "Start with a name, country and farm type.", "href": "/app/farm"}],
            "annual_review": {"year": year, "previous_year": year - 1, "reusable_count": 0, "missing_count": 0},
            "task_preview": {"total": 0, "dated_total": 0, "overdue_total": 0, "due_today_total": 0, "upcoming_total": 0,
                "actions_returned": 0, "deadlines_returned": 0, "actions_truncated": False, "deadlines_truncated": False, "href": "/app/tasks"},
            "deadlines": [], "capture_types": CAPTURE_TYPES}
    records = _farm_records(conn, farm["id"], ["facts", "requests"])
    by_kind = {kind: [row for row in records if row["kind"] == kind] for kind in ("facts", "requests")}
    active_requests = [row for row in by_kind["requests"] if row["data"].get("status") != "responded"]
    today = date.today().isoformat()
    deadlines = sorted([row for row in active_requests if row["data"].get("deadline")], key=lambda row: row["data"]["deadline"])
    summary["open_requests"] = len(active_requests)
    summary["upcoming_deadlines"] = len([row for row in deadlines if row["data"]["deadline"] >= today])
    cases = _case_home(conn, farm["id"], today)
    summary["open_cases"] = cases["count"]
    summary["upcoming_deadlines"] += cases["upcoming"]
    tasks = _task_home(conn, farm["id"], today)
    for name, count_key in (("open_tasks", "total"), ("dated_tasks", "dated_total"), ("overdue_tasks", "overdue_total"),
                            ("due_today_tasks", "due_today_total"), ("upcoming_task_deadlines", "upcoming_total")):
        summary[name] = tasks["preview"][count_key]
    summary["upcoming_deadlines"] += tasks["preview"]["upcoming_total"]
    actions = cases["actions"]
    for row in deadlines[:5]:
        overdue = row["data"]["deadline"] < today
        actions.append({"id": f"request-{row['id']}", "kind": "request", "title": row["data"].get("title", "Prepare a response"),
            "message": f"{'The recorded deadline was' if overdue else 'The recorded deadline is'} {row['data']['deadline']}.",
            "href": f"/app/paperwork/{row['id']}", "priority": "high" if overdue else "normal", "record_id": row["id"]})
    for kind, label in (("facts", "farm answers"), ("operations", "work records"), ("purchases", "purchases"), ("sales", "sales")):
        count = conn.execute("SELECT count(*) AS total FROM records WHERE kind=%s AND data->>'farm_id'=%s "
            "AND coalesce(data->>'review_status','proposed')='proposed' AND deleted_at IS NULL", (kind, farm["id"])).fetchone()["total"]
        summary[f"proposed_{kind}"] = count
        if kind == "facts" and farm["data"].get("country") == "PT":
            journal_count = sum(row["data"].get("key") == "pt.ppp.surface_journal" and row["data"].get("review_status") == "proposed" for row in by_kind["facts"])
            if journal_count:
                actions.append({"id": "review-portuguese-journals", "kind": "review", "title": "Check your Portuguese journal",
                    "message": "Compare the saved rows and sources before confirming them.",
                    "href": f"/app/record-work?farm_id={farm['id']}#portuguese-journal", "priority": "normal", "count": journal_count})
                count -= journal_count
        if count:
            actions.append({"id": f"review-{kind}", "kind": "review", "title": f"Check {count} {label}",
                "message": "These are saved as proposals. Review their values and sources before using them in paperwork.",
                "href": f"/app/fields/{farm['id']}#facts" if kind == "facts" else f"/app/record-work?farm_id={farm['id']}&review=1", "priority": "normal", "count": count})
    from .reconciliation import selected_fact_ids
    excluded = selected_fact_ids(conn, farm["id"])["excluded_fact_ids"]
    missing = _missing_information([fact for fact in by_kind["facts"] if fact["id"] not in excluded], active_requests, year, farm["data"])
    for request in active_requests:
        needed = [item for item in missing if item.get("request_id") == request["id"]]
        if needed and not any(item.get("record_id") == request["id"] for item in actions):
            actions.append({"id": f"request-{request['id']}", "kind": "request", "title": request["data"].get("title", "Continue a response"),
                "message": f"{len(needed)} requested details still need your attention.", "href": f"/app/paperwork/{request['id']}",
                "priority": "normal", "record_id": request["id"], "count": len(needed)})
    if not farm["data"].get("farm_type"):
        missing.insert(0, {"code": "farm_type_missing", "label": "Farm type", "message": "Choose the kind of farming you do so the starting questions fit your farm.", "href": f"/app/fields/{farm['id']}"})
        actions.insert(0, {"id": "finish-setup", "kind": "onboarding", "title": "Finish your farm details", "message": "Choose your farm type and check the reporting year.", "href": f"/app/fields/{farm['id']}", "priority": "high"})
    # Preserve existing critical case/request/setup actions ahead of urgent
    # tasks, then show those tasks before ordinary follow-up and review work.
    actions = ([action for action in actions if action.get("priority") == "high"]
        + [action for action in tasks["actions"] if action["priority"] == "high"]
        + [action for action in actions if action.get("priority") != "high"]
        + [action for action in tasks["actions"] if action["priority"] != "high"])
    annual = _annual_review(conn, farm["id"], year)
    if annual["reusable_count"] or annual["missing_count"]:
        actions.append({"id": "annual-review", "kind": "annual_review", "title": "What changed since last year?", "message": "Reuse standing details and check this year's answers one at a time.",
            "href": f"/app/fields/{farm['id']}#annual-review", "priority": "normal", "count": sum(item["review"] is None and not item["current"] for item in annual["items"])})
    if not actions:
        actions.append({"id": "record-work", "kind": "capture", "title": "Record today's work", "message": "Save work, purchases, sales or animal events while the details are fresh.", "href": f"/app/record-work?farm_id={farm['id']}", "priority": "normal"})
    home_deadlines = [{"id": row["id"], "title": row["data"].get("title", "Request"), "deadline": row["data"]["deadline"],
                      "overdue": row["data"]["deadline"] < today, "href": f"/app/paperwork/{row['id']}"} for row in deadlines]
    home_deadlines = sorted(home_deadlines + cases["deadlines"] + tasks["deadlines"], key=lambda item: (item["deadline"], item["id"]))
    return {"farm": farm, "farms": farms, "summary": summary, "next_actions": actions, "missing_information": missing,
        "annual_review": {key: annual[key] for key in ("year", "previous_year", "reusable_count", "missing_count")},
        "deadlines": home_deadlines, "task_preview": tasks["preview"], "capture_types": CAPTURE_TYPES}


@router.get("/home")
def workflow_home(farm_id: UUID | None = None, year: int = Query(default_factory=lambda: date.today().year, ge=1901, le=2200), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return _home(conn, str(farm_id) if farm_id else None, year)


@router.post("/onboard", status_code=201)
def onboard(body: OnboardInput, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    if body.farm_id is None:
        require_roles(session, "owner")
    elif body.expected_revision is None:
        raise ApiError(422, "revision_required", "Reload your farm details before updating them.")
    with transaction(session) as conn:
        def perform():
            current = fetch_record(conn, "farms", str(body.farm_id)) if body.farm_id else None
            data = {"name": body.name.strip(), "country": body.country, "region": body.region,
                "farm_type": body.farm_type, "reporting_year": body.reporting_year,
                "onboarding": {"previous_document_ids": [str(value) for value in body.previous_document_ids]}}
            checked = validate_data(conn, "farms", data, current["data"] if current else None, record_id=str(body.farm_id) if body.farm_id else None)
            farm = update_record(conn, "farms", current["id"], body.expected_revision, checked) if current else insert_record(conn, "farms", checked)
            home = _home(conn, farm["id"], body.reporting_year)
            return {"farm": farm, "next_actions": home["next_actions"]}
        return idempotent(conn, idempotency_key, "workflow-onboard", body.model_dump(mode="json"), perform)
