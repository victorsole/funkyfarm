"""Tenant-scoped records with narrow writable fields and explicit fact review."""

from datetime import date, datetime, timezone
import json
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from psycopg.types.json import Jsonb

from .db import fetch_record, idempotent, insert_record, json_safe, list_records, transaction, update_record
from .models import ApiError, CreateRecord, PreferencesUpdate, ReviewFact, UpdateRecord
from .security import Session, require_roles, require_session

router = APIRouter(tags=["farm records"])
COLLECTIONS = {"farms", "facts", "requests", "operations", "purchases", "sales", "tasks", "checklists"}
FARM_TYPES = {"arable", "livestock", "mixed", "horticulture", "other"}
FIELDS = {
    "farms": {"name", "country", "region", "reporting_year", "external_id", "origin", "area_ha", "sites", "parcels", "crops", "people", "reporting_periods", "notes", "address", "coordinates", "farm_type", "onboarding"},
    "facts": {"farm_id", "key", "label", "value", "unit", "period", "temporal_basis", "sources", "review_status", "supersedes_id", "notes", "parcel_id", "field_id", "group_id"},
    "requests": {"farm_id", "title", "recipient", "country", "region", "reporting_year", "deadline", "pack_id", "requirements", "status", "notes", "document_id"},
    "operations": {"farm_id", "title", "date", "type", "quantity", "unit", "parcel", "parcel_id", "field_id", "group_id", "crop", "product", "operator", "hours", "note", "notes", "document_id", "external_id", "origin", "period", "temporal_basis", "sources", "review_status", "treatment_type", "product_authorisation", "dose", "dose_unit", "treated_size", "treated_unit", "treated_location", "start_time", "eppo_code", "bbch_stage", "batch_number", "contractor", "label_time_required", "label_growth_stage_required", "cz_ppp", "supersedes_id"},
    "purchases": {"farm_id", "title", "date", "category", "quantity", "unit", "amount", "currency", "document_id", "supplier", "invoice_number", "tax_amount", "tax_rate", "note", "notes", "external_id", "origin", "credit", "period", "temporal_basis", "sources", "review_status"},
    "sales": {"farm_id", "title", "date", "category", "quantity", "unit", "amount", "currency", "document_id", "buyer", "invoice_number", "tax_amount", "tax_rate", "note", "notes", "external_id", "origin", "credit", "period", "temporal_basis", "sources", "review_status"},
    "tasks": {"farm_id", "title", "description", "due_date", "status", "assignee", "request_id", "document_id", "evidence_documents", "notes", "checklist_id", "checklist_item_key", "compliance_rule_id", "compliance_version", "compliance_hash", "source_citations"},
    "checklists": {"farm_id", "title", "pack_id", "version", "scheme", "items", "notes", "deadline", "request_id", "reporting_year", "compliance_rule_id", "compliance_version", "compliance_hash", "source_citations"},
    "settings": {"language", "country", "region", "reporting_year", "notifications"},
}


def _invalid(message, **details):
    raise ApiError(422, "invalid_record", message, details)


def _uuid(value, field):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError):
        _invalid(f"{field} must be a valid record identifier.", field=field)


def _string(data, key, required=False, maximum=4000):
    value = data.get(key)
    if value is None and not required:
        return
    if not isinstance(value, str) or (required and not value.strip()) or len(value) > maximum:
        _invalid(f"Enter a valid {key.replace('_', ' ')}.", field=key)


def _date(data, key):
    if data.get(key) is not None:
        try:
            value = data[key]
            parsed = date.fromisoformat(value)
            if not isinstance(value, str) or parsed.isoformat() != value:
                raise ValueError
        except (ValueError, TypeError):
            _invalid(f"{key} must use YYYY-MM-DD.", field=key)


def _sources(conn, sources, farm_id):
    if not isinstance(sources, list) or len(sources) > 100:
        _invalid("Sources must be a list of at most 100 structured locations.")
    for source in sources:
        if not isinstance(source, dict):
            _invalid("Each source needs a structured location or origin.")
        for field, target in (("document_id", "documents"), ("import_id", "imports"), ("row_id", "import_rows"), ("record_id", "facts"), ("request_id", "requests")):
            if source.get(field):
                if field == "record_id" and source.get("record_kind") is not None:
                    if source["record_kind"] not in ("facts", "operations", "purchases", "sales"):
                        _invalid("Choose a fact, work record, purchase or sale as the linked source.")
                    target = source["record_kind"]
                related = fetch_record(conn, target, _uuid(source[field], field))
                if related["data"].get("farm_id") not in (None, farm_id):
                    _invalid("A linked source belongs to another farm.", field=field)
                if field == "record_id" and source.get("revision") is not None:
                    revision = source["revision"]
                    if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1 or revision > related["revision"]:
                        _invalid("The cited source revision does not exist.")
                if field == "document_id" and source.get("document_revision") is not None:
                    revision = source["document_revision"]
                    if isinstance(revision, bool) or not isinstance(revision, int) or not 1 <= revision <= related["revision"]:
                        _invalid("The cited document revision does not exist.")
        if source.get("import_id") and source.get("row_id"):
            row = fetch_record(conn, "import_rows", source["row_id"])
            if row["data"].get("import_id") != str(source["import_id"]):
                _invalid("This source row belongs to another import.")


def physical_identity(data):
    return next((data.get(key) for key in ("parcel_id", "field_id", "group_id") if data.get(key) is not None), None)


def _pt_journal(conn, data, *, lock=False):
    """The literal source has no inferred event/field scope or unpinned files."""
    from .manual_journal import FACT_KEY, validate_value
    if data.get("key") != FACT_KEY:
        return
    farm = fetch_record(conn, "farms", data["farm_id"])
    if farm["data"].get("country") != "PT" or data.get("temporal_basis") != "static" or data.get("period") is not None or data.get("unit") is not None or physical_identity(data) is not None:
        raise ApiError(422, "pt_journal_scope", "Keep this Portuguese whole-farm literal journal static, without a unit, period or field identity.")
    data["value"] = validate_value(data.get("value"))
    sources = data.get("sources", [])
    if not isinstance(sources, list) or len(sources) > 100 or any(
        not isinstance(source, dict) or set(source) != {"document_id", "document_revision"} or not source.get("document_id")
        for source in sources
    ):
        raise ApiError(422, "pt_journal_sources", "Journal sources are optional actual-document selections with document_id and document_revision only. Leave the list empty when no document was selected.")
    ids = sorted({_uuid(source["document_id"], "document_id") for source in sources if isinstance(source, dict) and source.get("document_id")})
    if lock and ids:
        conn.execute("SELECT id FROM records WHERE id=ANY(%s::uuid[]) AND kind='documents' ORDER BY id FOR SHARE", (ids,)).fetchall()
    for source in sources:
        document = fetch_record(conn, "documents", source["document_id"])
        if document["data"].get("farm_id") != data["farm_id"]:
            raise ApiError(422, "pt_journal_source_farm", "Select source documents explicitly assigned to this same farm.")
        revision = source.get("document_revision")
        if type(revision) is not int or revision != document["revision"]:
            raise ApiError(409, "pt_journal_source_changed", "Review and select the exact current source-document revision.", {"document_id": document["id"]})


def matches_reporting_period(data, year, *, basis=None, period=None):
    """Match an actual observation without turning a reporting year into a date."""
    actual_basis = data.get("temporal_basis")
    if basis is not None and actual_basis != basis:
        return False
    if period is not None and data.get("period") != period:
        return False
    if actual_basis == "static":
        return data.get("period") in (None, "")
    if actual_basis == "campaign_year":
        return str(data.get("period")) == str(year)
    if actual_basis == "calendar_date":
        try:
            return date.fromisoformat(data.get("period")).year == int(year)
        except (ValueError, TypeError):
            return False
    return False


def _physical_scope(farm_data, data):
    supplied = [data[key] for key in ("parcel_id", "field_id", "group_id") if data.get(key) is not None]
    if not supplied:
        return
    if any(not isinstance(value, str) or not 1 <= len(value) <= 100 for value in supplied):
        _invalid("Choose a field or site identifier recorded on this farm.", field="parcel_id")
    if len(set(supplied)) != 1:
        _invalid("The supplied field identifiers disagree. Choose one field or site.", field="parcel_id")
    identifiers = []
    for index, parcel in enumerate(farm_data.get("parcels", [])):
        if isinstance(parcel, dict):
            identifiers.append(str(parcel.get("id") or f"legacy-{index}"))
    for index, site in enumerate(farm_data.get("sites", [])):
        if not isinstance(site, dict):
            continue
        site_id = str(site.get("id") or f"site-{index}")
        identifiers.append(site_id)
        for parcel_index, parcel in enumerate(site.get("parcels", [])):
            if isinstance(parcel, dict):
                identifiers.append(str(parcel.get("id") or f"{site_id}:parcel-{parcel_index}"))
    if supplied[0] not in identifiers:
        _invalid("This field or site does not belong to the selected farm.", field="parcel_id")
    if identifiers.count(supplied[0]) != 1:
        _invalid("More than one field or site uses this identifier. Give them distinct identifiers before linking records.", field="parcel_id")
    data["parcel_id"] = supplied[0]
    data.pop("field_id", None)
    data.pop("group_id", None)


def _operation_correction(conn, data, *, record_id=None):
    """Validate an explicit successor; callers serialize confirmation per farm."""
    predecessor_id = data.get("supersedes_id")
    if not predecessor_id:
        return
    previous = fetch_record(conn, "operations", predecessor_id)
    if str(record_id) == previous["id"] or previous["data"].get("farm_id") != data["farm_id"] or previous["data"].get("type") != data.get("type") or previous["data"].get("review_status") != "confirmed":
        raise ApiError(409, "operation_correction_conflict", "Choose a confirmed application of the same kind on this farm as the original correction source.")
    successor = conn.execute("SELECT id FROM records WHERE kind='operations' AND deleted_at IS NULL "
        "AND data->>'farm_id'=%s AND data->>'supersedes_id'=%s AND data->>'review_status'='confirmed' "
        "AND id<>%s ORDER BY id LIMIT 1", (data["farm_id"], previous["id"], UUID(str(record_id)) if record_id else UUID(int=0))).fetchone()
    if successor:
        raise ApiError(409, "operation_correction_conflict", "This application already has a confirmed correction. Reload and correct its current successor instead.", {"successor_id": str(successor["id"])})


def _operation_views(conn, items):
    """Read-only journal metadata for the current bounded page, not saved data."""
    candidates = [item for item in items if item["data"].get("type") == "pesticide_application"]
    if not candidates:
        return items
    farm_ids = list({UUID(item["data"]["farm_id"]) for item in candidates})
    farms = conn.execute("SELECT id FROM records WHERE kind='farms' AND id=ANY(%s) "
        "AND deleted_at IS NULL AND data->>'country'='CZ'", (farm_ids,)).fetchall()
    authorized = {str(row["id"]) for row in farms}
    candidates = [item for item in candidates if item["data"]["farm_id"] in authorized]
    if not candidates:
        return items
    by_id = {item["id"]: item for item in candidates}
    rows = conn.execute("SELECT id,data->>'supersedes_id' AS predecessor,data->>'farm_id' AS farm_id FROM records "
        "WHERE kind='operations' AND deleted_at IS NULL AND data->>'review_status'='confirmed' "
        "AND data->>'supersedes_id'=ANY(%s) ORDER BY id LIMIT %s", (list(by_id), len(by_id) + 1)).fetchall()
    if len(rows) > len(by_id):
        raise ApiError(409, "operation_correction_conflict", "Resolve competing confirmed application corrections before choosing the current record.")
    successors = {}
    for row in rows:
        predecessor = row["predecessor"]
        if row["farm_id"] != by_id[predecessor]["data"]["farm_id"]:
            continue
        if predecessor in successors:
            raise ApiError(409, "operation_correction_conflict", "Resolve competing confirmed application corrections before choosing the current record.")
        successors[predecessor] = str(row["id"])
    from .ppp_journal import journal_issues
    result = []
    for item in items:
        if item["id"] not in by_id:
            result.append(item)
            continue
        try:
            issues = journal_issues(item["data"])
        except ApiError as exc:
            issues = [{"code": exc.code, "severity": "error", "field": exc.details.get("field"), "message": exc.message}]
        result.append({**item, "journal_issues": issues, "active": item["id"] not in successors,
            "confirmed_successor_id": successors.get(item["id"])})
    return result


def validate_data(conn, kind, patch, old=None, *, record_id=None):
    if kind not in FIELDS:
        raise ApiError(404, "not_found", "This collection is not available.")
    unknown = set(patch) - FIELDS[kind]
    if unknown:
        _invalid("These fields cannot be written through this form.", fields=sorted(unknown))
    data = {**(old or {}), **patch}
    try:
        if len(json.dumps(data, allow_nan=False).encode()) > 512_000:
            _invalid("This record is too large. Attach source files as documents.")
    except (ValueError, TypeError):
        _invalid("Use ordinary JSON values for this record.")
    if kind != "farms" and kind != "settings":
        data["farm_id"] = _uuid(data.get("farm_id"), "farm_id")
        farm = fetch_record(conn, "farms", data["farm_id"])
        if old and old.get("farm_id") != data["farm_id"]:
            _invalid("A record cannot be moved to another farm; create a new record with its source retained.")
        if kind in {"facts", "operations"}:
            _physical_scope(farm["data"], data)
    for field, target in (("document_id", "documents"), ("request_id", "requests"), ("supersedes_id", "operations" if kind == "operations" else "facts"), ("checklist_id", "checklists")):
        if data.get(field):
            data[field] = _uuid(data[field], field)
            related = fetch_record(conn, target, data[field])
            if data.get("farm_id") and related["data"].get("farm_id") not in (None, data["farm_id"]):
                _invalid("The linked record belongs to another farm.", field=field)
    if "country" in data and data["country"] is not None:
        countries = {"AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"}
        if not isinstance(data["country"], str) or data["country"] not in countries:
            _invalid("Choose one of the 27 EU country codes.", field="country")
    if "reporting_year" in data and (isinstance(data["reporting_year"], bool) or not isinstance(data["reporting_year"], int) or not 1900 <= data["reporting_year"] <= 2200):
        _invalid("Enter a reporting year between 1900 and 2200.")
    for field in ("quantity", "amount", "tax_amount", "tax_rate", "hours", "area_ha", "dose", "treated_size"):
        if field in data and data[field] is not None:
            if isinstance(data[field], bool) or not isinstance(data[field], (float, int)):
                _invalid(f"{field} must be a number or null.", field=field)
            if field not in {"amount", "tax_amount"} and data[field] < 0:
                _invalid(f"{field} cannot be negative.", field=field)
    if kind == "farms":
        _string(data, "name", required=True, maximum=200)
        if not data.get("country"):
            _invalid("Choose the farm country.")
        if "farm_type" in data and (not isinstance(data["farm_type"], str) or data["farm_type"] not in FARM_TYPES):
            _invalid("Choose crops, livestock, mixed farming, horticulture or other for your farm type.", field="farm_type")
        if "onboarding" in patch:
            onboarding = data["onboarding"]
            if not isinstance(onboarding, dict) or set(onboarding) - {"previous_document_ids"}:
                _invalid("Farm setup may link your previous documents; it cannot approve evidence.", field="onboarding")
            documents = onboarding.get("previous_document_ids", [])
            if not isinstance(documents, list) or len(documents) > 100:
                _invalid("Choose at most 100 previous documents.")
            ids = []
            for document_id in documents:
                document = fetch_record(conn, "documents", _uuid(document_id, "document_id"))
                if document["data"].get("farm_id") not in (None, str(record_id) if record_id else None):
                    _invalid("Choose documents that belong to this farm or have not been assigned to a farm.")
                ids.append(document["id"])
            data["onboarding"] = {"previous_document_ids": list(dict.fromkeys(ids))}
        for field in ("sites", "parcels", "crops", "people", "reporting_periods"):
            if field in data and (not isinstance(data[field], list) or len(data[field]) > 2000):
                _invalid(f"{field} must be a list with at most 2000 entries.")
        for field in ("sites", "parcels"):
            for item in data.get(field, []):
                if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                    _invalid(f"Each {field} entry needs a name.")
    elif kind == "facts":
        for field in ("key", "label"):
            _string(data, field, required=True, maximum=300)
        if "value" not in data:
            _invalid("A fact needs a value; null is allowed when the value is unknown.")
        from .compliance import validate_profile_value
        data["value"] = validate_profile_value(data.get("key"), data["value"])
        if data["key"] == "cz.ppp.holder":
            from .ppp_journal import validate_holder
            if data.get("temporal_basis") != "static" or data.get("period") not in (None, "") or data.get("unit") is not None or physical_identity(data) is not None:
                _invalid("The journal holder is a standing, whole-farm identity without an observation unit or field.", field="value")
            data["value"] = validate_holder(data["value"])
        if "review_status" in patch and patch["review_status"] != "proposed":
            _invalid("Confirm or reject facts through the explicit review action.")
        if old and old.get("review_status") == "confirmed":
            raise ApiError(409, "confirmed_fact_immutable", "Create a proposed correction to this confirmed fact. Its reviewed revision is retained.")
        data["review_status"] = "proposed"
        if not isinstance(data.get("temporal_basis"), str) or data["temporal_basis"] not in {"static", "campaign_year", "calendar_date"}:
            _invalid("Choose static, campaign_year or calendar_date for the fact's temporal basis.")
        if data["temporal_basis"] == "campaign_year":
            if not isinstance(data.get("period"), str) or not data["period"].isdigit() or len(data["period"]) != 4:
                _invalid("Campaign facts need a four-digit period year.")
        elif data["temporal_basis"] == "calendar_date":
            _date(data, "period")
            if not data.get("period"):
                _invalid("Dated facts need a period date.")
        elif data.get("period") not in (None, ""):
            _invalid("Static facts cannot be labelled as an annual observation.")
        for field in ("unit", "period"):
            _string(data, field, maximum=200)
        sources = data.setdefault("sources", [])
        _sources(conn, sources, data["farm_id"])
        _pt_journal(conn, data)
    elif kind == "requests":
        for field in ("title", "recipient", "pack_id"):
            _string(data, field, required=True, maximum=500)
        if not data.get("country") or not data.get("reporting_year"):
            _invalid("Requests need a country and reporting year.")
        _date(data, "deadline")
        data.setdefault("status", "draft")
        if "status" in patch and (not isinstance(patch["status"], str) or patch["status"] not in {"draft", "review", "waiting"}) and (not old or patch["status"] != old.get("status")):
            _invalid("Ready and responded states are set by reviewed reports and response receipts.")
        if old and old.get("status") in {"ready", "responded"} and patch.get("status") not in (None, old["status"]):
            _invalid("Retain the issued response status; create a correction request when needed.")
        requirements = data.setdefault("requirements", [])
        if not isinstance(requirements, list) or len(requirements) > 500:
            _invalid("Requirements must be a list of at most 500 questions.")
        for item in requirements:
            if not isinstance(item, dict) or not isinstance(item.get("key"), str) or not isinstance(item.get("label"), str):
                _invalid("Each requirement needs a key and label.")
            if set(item) - {"key", "label", "required", "description", "unit", "temporal_basis", "parcel_id", "field_id", "group_id", "period"}:
                _invalid("Requirements cannot carry approval or completion claims.")
            _physical_scope(farm["data"], item)
            if item.get("period") is not None:
                if item.get("temporal_basis") == "calendar_date":
                    _date(item, "period")
                elif item.get("temporal_basis") == "campaign_year" and str(item["period"]) != str(data["reporting_year"]):
                    _invalid("The requested campaign period must match this request's reporting year.")
                elif item.get("temporal_basis") != "campaign_year":
                    _invalid("A requested date needs an explicit calendar-date time basis.")
    elif kind in {"operations", "purchases", "sales", "tasks", "checklists"}:
        _string(data, "title", required=True, maximum=500)
        if kind == "operations":
            if old and old.get("supersedes_id") and data.get("supersedes_id") != old["supersedes_id"]:
                _invalid("A saved correction must retain its original application link.", field="supersedes_id")
            if "cz_ppp" in data:
                from .ppp_journal import validate_details
                if data.get("type") != "pesticide_application":
                    _invalid("Czech crop-protection details belong to a pesticide application.", field="type")
                data = validate_details(data)
            if data.get("supersedes_id"):
                _operation_correction(conn, data, record_id=record_id)
            for field in ("product_authorisation", "dose_unit", "treated_unit", "treated_location", "start_time", "eppo_code", "bbch_stage", "batch_number", "contractor", "operator"):
                _string(data, field, maximum=500)
            if data.get("treatment_type") not in (None, "", "surface", "closed_space", "seed"):
                _invalid("Choose a field, closed space or seed treatment.", field="treatment_type")
            for field in ("label_time_required", "label_growth_stage_required"):
                if data.get(field) is not None and not isinstance(data[field], bool):
                    _invalid("Choose yes, no or not known for the label requirement.", field=field)
            if data.get("start_time"):
                try:
                    datetime.strptime(data["start_time"], "%H:%M")
                except ValueError:
                    _invalid("Enter the actual start time as hours and minutes.", field="start_time")
        for field in ("date", "due_date", "deadline"):
            _date(data, field)
        if kind == "purchases" and (not isinstance(data.get("currency"), str) or len(data["currency"]) != 3 or not data["currency"].isupper()):
            _invalid("Purchases need an uppercase three-letter currency code.")
        if kind == "sales":
            _string(data, "category", required=True, maximum=200)
            for field in ("buyer", "invoice_number", "unit", "external_id", "origin"):
                _string(data, field, maximum=500)
            for field in ("note", "notes"):
                _string(data, field)
            currency = data.get("currency")
            if not isinstance(currency, str) or len(currency) != 3 or any(letter not in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" for letter in currency):
                _invalid("Sales need an uppercase three-letter currency code.", field="currency")
            if data.get("amount") is None:
                _invalid("Enter the actual total shown on the sale or sales invoice.", field="amount")
            if data.get("quantity") not in (None, 0) and not data.get("unit"):
                _invalid("Choose the unit of the quantity shown on this sale.", field="unit")
            if "credit" in data and not isinstance(data["credit"], bool):
                _invalid("Record explicitly whether this is a credit note.", field="credit")
            actual_date = data.get("date")
            if not isinstance(actual_date, str) or len(actual_date) != 10 or actual_date[4] != "-" or actual_date[7] != "-":
                _invalid("Enter the actual sale date in YYYY-MM-DD format. An annual total cannot supply a sale date.", field="date")
            if date.fromisoformat(actual_date) > date.today():
                _invalid("This sale date is in the future. Record an actual sale after it happens.", field="date")
            if data.get("temporal_basis") not in (None, "calendar_date") or data.get("period") not in (None, actual_date):
                _invalid("A sale uses its actual calendar date. Keep annual totals separate from dated sales.", field="period")
            data["temporal_basis"] = "calendar_date"
            data["period"] = actual_date
        if kind == "tasks":
            if old and old.get("document_id") and data.get("document_id") != old["document_id"]:
                _invalid("Keep the original document linked to this task. Add supporting documents to your answer instead.", field="document_id")
            evidence = data.get("evidence_documents", [])
            if not isinstance(evidence, list) or len(evidence) > 20:
                _invalid("Choose up to 20 supporting documents.", field="evidence_documents")
            seen = set()
            for source in evidence:
                if not isinstance(source, dict) or set(source) != {"document_id", "document_revision"}:
                    _invalid("Choose a supporting document and its saved version.", field="evidence_documents")
                document_id = _uuid(source["document_id"], "document_id")
                if document_id in seen:
                    _invalid("Choose each supporting document only once.", field="evidence_documents")
                seen.add(document_id)
                if type(source["document_revision"]) is not int or source["document_revision"] < 1:
                    _invalid("Choose a valid supporting document version.", field="evidence_documents")
            if seen:
                conn.execute("SELECT id FROM records WHERE id=ANY(%s::uuid[]) AND kind='documents' ORDER BY id FOR SHARE", (sorted(seen),)).fetchall()
            for source in evidence:
                document = fetch_record(conn, "documents", _uuid(source["document_id"], "document_id"))
                if document["data"].get("farm_id") != data["farm_id"]:
                    _invalid("Choose supporting documents saved for this farm.", field="evidence_documents")
                if source["document_revision"] != document["revision"]:
                    raise ApiError(409, "task_evidence_changed", "A supporting document changed. Read its latest version and select it again.", {"document_id": document["id"]})
            if "evidence_documents" in patch:
                data["evidence_documents"] = [{"document_id": _uuid(source["document_id"], "document_id"), "document_revision": source["document_revision"]} for source in evidence]
            data.setdefault("status", "open")
            if not isinstance(data["status"], str) or data["status"] not in {"open", "in_progress", "done", "cancelled"}:
                _invalid("Choose a supported task status.")
            if "notes" in patch:
                _string(data, "notes", maximum=4000)
            if old and old.get("purpose") == "missing_information":
                if any(key in patch and patch[key] != old.get(key) for key in ("title", "description", "assignee", "request_id")):
                    _invalid("Keep the original question unchanged. Save your answer in the answer box.")
                if data["status"] in {"done", "cancelled"} and (not isinstance(data.get("notes"), str) or not data["notes"].strip()):
                    _invalid("Add your answer, or explain why you cannot answer, before closing this question.", field="notes")
            if data["status"] == "done" and data.get("checklist_id"):
                from .obligations import require_task_evidence
                require_task_evidence(conn, data)
        if kind == "checklists":
            if not isinstance(data.get("items", []), list):
                _invalid("Checklist items must be a list.")
            managed = bool(old and (old.get("compliance_rule_id") or old.get("pack_id")
                                    or any(isinstance(item, dict) and "reviewed_by" in item for item in old.get("items", []))))
            if managed and "items" in patch and patch["items"] != old.get("items"):
                raise ApiError(422, "checklist_review_required", "Use this checklist item's evidence or source-review action; a checkbox cannot replace its checks.")
            allowed = {"key", "label", "done", "evidence_ids", "deadline", "note"}
            if managed:
                allowed |= {"check", "status", "evidence_fact_ids", "evidence_operation_ids", "evidence_purchase_ids", "evidence_sale_ids", "evidence_revisions", "reviewed_by", "reviewed_at", "reviewed_input_fingerprint", "remaining_issues", "official_field", "candidate_fact_ids", "required", "unit", "temporal_basis", "period", "parcel_id", "resolved_conflicting_fact_ids"}
            for item in data.get("items", []):
                if not isinstance(item, dict) or set(item) - allowed:
                    _invalid("Checklist items may record actions and evidence, not compliance approvals.")
                for evidence_id in item.get("evidence_ids", []):
                    fetch_record(conn, "documents", _uuid(evidence_id, "evidence_id"))
        if kind in {"tasks", "checklists"}:
            protected = {"compliance_rule_id", "compliance_version", "compliance_hash", "source_citations", "checklist_item_key"}
            if old and old.get("compliance_rule_id"):
                protected |= {"farm_id", "checklist_id", "scheme", "version", "pack_id", "reporting_year"}
            if any(key in patch and (not old or patch[key] != old.get(key)) for key in protected):
                raise ApiError(422, "generated_provenance_protected", "Generated rule provenance and action links are set by the source-backed workflow, not ordinary record edits.")
        if kind in {"operations", "purchases", "sales"}:
            if old and old.get("review_status") == "confirmed":
                raise ApiError(409, "confirmed_record_immutable", "Create a proposed correction; this reviewed record retains its history.")
            if "review_status" in patch and patch["review_status"] != "proposed":
                _invalid("Confirm or reject records through the explicit review action.")
            data["review_status"] = "proposed"
            if data.get("temporal_basis") is not None and (not isinstance(data["temporal_basis"], str) or data["temporal_basis"] not in {"static", "campaign_year", "calendar_date"}):
                _invalid("Choose a supported temporal basis.")
            if data.get("temporal_basis") == "campaign_year" and (not isinstance(data.get("period"), str) or len(data["period"]) != 4 or not data["period"].isdigit()):
                _invalid("Campaign summaries need an explicit period year.")
            if data.get("temporal_basis") == "calendar_date":
                _date(data, "period")
                if not data.get("period"):
                    _invalid("Dated records need an explicit period date.")
            if data.get("temporal_basis") == "static" and data.get("period") not in (None, ""):
                _invalid("Static records cannot become annual observations.")
            _sources(conn, data.get("sources", []), data["farm_id"])
    return data


@router.get("/settings")
def settings(session: Session = Depends(require_session)):
    with transaction(session) as conn:
        page = list_records(conn, "settings", 1)
        return page["items"][0] if page["items"] else {"id": None, "kind": "settings", "revision": 0, "workspace_id": session.workspace_id, "data": {"language": "en", "notifications": True}}


@router.patch("/settings")
def save_settings(body: PreferencesUpdate, session: Session = Depends(require_session)):
    require_roles(session, "owner")
    with transaction(session) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':settings',0))")
        page = list_records(conn, "settings", 1)
        old = page["items"][0] if page["items"] else None
        data = validate_data(conn, "settings", body.data, old["data"] if old else None)
        if not old and body.expected_revision != 0:
            raise ApiError(409, "revision_conflict", "Reload settings before saving.")
        return update_record(conn, "settings", old["id"], body.expected_revision, data) if old else insert_record(conn, "settings", data)


@router.post("/facts/{record_id}/review")
def review_fact(record_id: str, body: ReviewFact, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        def perform():
            # Row locks serialize review and replacement with concurrent edits.
            initial = fetch_record(conn, "facts", record_id)
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{initial['data']['farm_id']}",))
            conn.execute("SELECT id FROM records WHERE id=%s AND kind='facts' FOR UPDATE", (_uuid(record_id, "id"),))
            fact = fetch_record(conn, "facts", record_id)
            if fact["data"].get("review_status") == body.decision:
                if fact["revision"] != body.expected_revision:
                    raise ApiError(409, "revision_conflict", "This fact was already reviewed. Reload its history.")
                return fact
            if (fact["data"].get("review_status") == "confirmed" or fact["data"].get("supersedes_id")) and not body.note.strip():
                _invalid("Explain the correction or rejection so the review history remains useful.")
            data = {**fact["data"], "review_status": body.decision,
                    "reviewed_by": session.user_id, "reviewed_at": datetime.now(timezone.utc).isoformat(), "review_note": body.note}
            if body.decision == "confirmed":
                _pt_journal(conn, data, lock=True)
            if body.decision == "confirmed" and data.get("supersedes_id"):
                previous = fetch_record(conn, "facts", data["supersedes_id"])
                if any(previous["data"].get(k) != data.get(k) for k in ("farm_id", "key", "period", "temporal_basis")):
                    _invalid("A correction must concern the same farm, fact and period.")
                if physical_identity(previous["data"]) != physical_identity(data):
                    _invalid("A correction must concern the same field or site as the original answer.")
                if previous["data"].get("review_status") != "confirmed":
                    raise ApiError(409, "correction_conflict", "The original fact is no longer confirmed. Review its latest history.")
                update_record(conn, "facts", previous["id"], previous["revision"], {
                    **previous["data"], "review_status": "rejected", "superseded_by": fact["id"],
                    "reviewed_by": session.user_id, "reviewed_at": data["reviewed_at"], "review_note": body.note,
                })
            return update_record(conn, "facts", record_id, body.expected_revision, data)
        return idempotent(conn, idempotency_key, f"fact-review:{record_id}:{session.user_id}", body.model_dump(), perform)


@router.post("/operations/{record_id}/review")
@router.post("/purchases/{record_id}/review")
@router.post("/sales/{record_id}/review")
def review_ledger(record_id: str, body: ReviewFact, request: Request, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    kind = request.url.path.split("/")[-3]
    with transaction(session) as conn:
        def perform():
            item = fetch_record(conn, kind, record_id)
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{item['data']['farm_id']}",))
            conn.execute("SELECT id FROM records WHERE id=%s AND kind=%s AND deleted_at IS NULL FOR UPDATE", (UUID(record_id), kind))
            item = fetch_record(conn, kind, record_id)
            if item["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "This record changed. Reload it before reviewing.")
            if kind == "operations":
                successor = conn.execute("SELECT id FROM records WHERE kind='operations' AND deleted_at IS NULL AND data->>'farm_id'=%s "
                    "AND data->>'supersedes_id'=%s AND data->>'review_status'='confirmed' LIMIT 1", (item["data"]["farm_id"], item["id"])).fetchone()
                if successor:
                    raise ApiError(409, "operation_correction_conflict", "Review the current confirmed correction, not the superseded application.", {"successor_id": str(successor["id"])})
            if kind == "operations" and body.decision == "confirmed":
                _operation_correction(conn, item["data"], record_id=record_id)
                if item["data"].get("supersedes_id") and not body.note.strip():
                    raise ApiError(422, "review_note_required", "Explain the correction you checked before confirming this application.")
            if item["data"].get("review_status") == body.decision:
                if item["revision"] != body.expected_revision:
                    raise ApiError(409, "revision_conflict", "This record was already reviewed. Reload it before continuing.")
                return item
            if body.decision == "confirmed":
                from .workflows import check_capture
                value = item["data"]
                satellite = "satellite" in str(value.get("origin", "")) or any("satellite" in str(source.get("source_kind", source.get("kind", ""))) for source in value.get("sources", []) if isinstance(source, dict))
                operation_type = value.get("type") if isinstance(value.get("type"), str) else ""
                actual_work = kind == "operations" and (operation_type in {"fertiliser_application", "pesticide_application", "input_application", "irrigation", "harvest"} or operation_type.startswith("animal_"))
                dated_event = kind == "sales" or satellite or actual_work or value.get("temporal_basis") not in {"static", "campaign_year"}
                # A review uses the saved record as its source; stale and malformed
                # proposals cannot bypass the same checks shown during capture.
                checked = check_capture(conn, kind, {}, record_id=record_id, event_required=dated_event, strict_type=False)
                if not checked["can_save"]:
                    raise ApiError(422, "review_needs_changes", "Correct these details before confirming the record.", checked)
                if checked["requires_acknowledgement"] and not body.note.strip():
                    raise ApiError(422, "review_note_required", "Check these warnings and explain what you verified before confirming.", checked)
                item["data"] = checked["normalized_data"]
            if item["data"].get("review_status") == "confirmed" and not body.note.strip():
                _invalid("Explain why this reviewed record should change.")
            data = {**item["data"], "review_status": body.decision, "reviewed_by": session.user_id,
                    "reviewed_at": datetime.now(timezone.utc).isoformat(), "review_note": body.note}
            return update_record(conn, kind, record_id, body.expected_revision, data)
        return idempotent(conn, idempotency_key, f"ledger-review:{kind}:{record_id}:{session.user_id}", body.model_dump(), perform)


@router.get("/account")
def account(request: Request, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        preferences = conn.execute("SELECT revision,data FROM user_preferences WHERE user_id=%s", (UUID(session.user_id),)).fetchone()
        row = request.state.session_row
        return {"user": {"id": session.user_id, "display_name": row["display_name"], "email": row["email"]},
                "revision": preferences["revision"] if preferences else 0,
                "data": preferences["data"] if preferences else {"language": "en", "country": None}}


@router.patch("/account")
def update_account(body: PreferencesUpdate, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.user_id}:preferences",))
        old = conn.execute("SELECT revision,data FROM user_preferences WHERE user_id=%s", (UUID(session.user_id),)).fetchone()
        if body.expected_revision != (old["revision"] if old else 0):
            raise ApiError(409, "revision_conflict", "Account preferences changed. Reload them before saving.")
        data = validate_data(conn, "settings", body.data, old["data"] if old else None)
        languages = {"bg","hr","cs","da","nl","en","et","fi","fr","de","el","hu","ga","it","lv","lt","mt","pl","pt","ro","sk","sl","es","sv"}
        if not isinstance(data.get("language", "en"), str) or data.get("language", "en") not in languages:
            _invalid("Choose one of the 24 official EU language codes.")
        if old:
            conn.execute("UPDATE user_preferences SET revision=revision+1,data=%s WHERE user_id=%s", (Jsonb(data), UUID(session.user_id)))
        else:
            conn.execute("INSERT INTO user_preferences(user_id,data) VALUES(%s,%s)", (UUID(session.user_id), Jsonb(data)))
        return {"revision": body.expected_revision + 1, "data": data}


@router.get("/{kind}/{record_id}/history")
def history(kind: str, record_id: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    if kind not in COLLECTIONS:
        raise ApiError(404, "not_found", "This collection was not found.")
    with transaction(session) as conn:
        fetch_record(conn, kind, record_id)
        rows = conn.execute("SELECT revision,data,actor_id,recorded_at FROM record_history WHERE record_id=%s ORDER BY revision DESC LIMIT %s OFFSET %s", (UUID(record_id), limit, offset)).fetchall()
        count = conn.execute("SELECT count(*) AS count FROM record_history WHERE record_id=%s", (UUID(record_id),)).fetchone()["count"]
        return {"items": json_safe(rows), "total": count, "limit": limit, "offset": offset}


@router.get("/{kind}")
def collection(kind: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), farm_id: str | None = None,
               task_state: Literal["all", "active"] = "all", fact_key: str | None = Query(None, min_length=1, max_length=300), session: Session = Depends(require_session)):
    if kind not in COLLECTIONS:
        raise ApiError(404, "not_found", "This collection was not found.")
    with transaction(session) as conn:
        if farm_id:
            fetch_record(conn, "farms", farm_id)
        if fact_key is not None:
            if kind != "facts":
                _invalid("The exact fact-key filter is only available for facts.")
            where = "kind='facts' AND deleted_at IS NULL AND data->>'key'=%s"
            args = [fact_key]
            if farm_id:
                where += " AND data->>'farm_id'=%s"
                args.append(farm_id)
            rows = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE " + where
                + " ORDER BY created_at,id LIMIT %s OFFSET %s", (*args, limit, offset)).fetchall()
            total = conn.execute("SELECT count(*) AS total FROM records WHERE " + where, args).fetchone()["total"]
            page = {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}
        elif task_state == "active":
            if kind != "tasks":
                _invalid("The unfinished-task filter is only available for tasks.")
            where = "kind='tasks' AND deleted_at IS NULL AND coalesce(data->>'status','open') IN ('open','in_progress')"
            args = []
            if farm_id:
                where += " AND data->>'farm_id'=%s"
                args.append(farm_id)
            rows = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE " + where
                + " ORDER BY nullif(data->>'due_date','') NULLS LAST,updated_at,id LIMIT %s OFFSET %s", (*args, limit, offset)).fetchall()
            total = conn.execute("SELECT count(*) AS total FROM records WHERE " + where, args).fetchone()["total"]
            page = {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}
        else:
            page = list_records(conn, kind, limit, offset, farm_id)
        if kind == "operations":
            page["items"] = _operation_views(conn, page["items"])
        return page


@router.post("/{kind}", status_code=201)
def create(kind: str, body: CreateRecord, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    if kind not in COLLECTIONS:
        raise ApiError(404, "not_found", "This collection was not found.")
    with transaction(session) as conn:
        def perform():
            data = validate_data(conn, kind, body.data)
            return insert_record(conn, kind, data)
        return idempotent(conn, idempotency_key, f"create:{kind}:{session.user_id}", body.model_dump(), perform)


@router.get("/{kind}/{record_id}")
def detail(kind: str, record_id: str, session: Session = Depends(require_session)):
    if kind not in COLLECTIONS:
        raise ApiError(404, "not_found", "This collection was not found.")
    with transaction(session) as conn:
        item = fetch_record(conn, kind, record_id)
        return _operation_views(conn, [item])[0] if kind == "operations" else item


@router.patch("/{kind}/{record_id}")
def edit(kind: str, record_id: str, body: UpdateRecord, idempotency_key: str | None = Header(default=None), session: Session = Depends(require_session)):
    if kind not in COLLECTIONS:
        raise ApiError(404, "not_found", "This collection was not found.")
    with transaction(session) as conn:
        if kind == "tasks":
            current = fetch_record(conn, kind, record_id)
            allowed = conn.execute("SELECT record_access(%s,'tasks',%s::jsonb,true) AS allowed",
                (current["id"], json.dumps(current["data"]))).fetchone()["allowed"]
            if not allowed:
                raise ApiError(403, "task_write_required", "You can read this task, but your current farm permission does not allow changing its answer or status.")
        def perform():
            current = fetch_record(conn, kind, record_id)
            return update_record(conn, kind, record_id, body.expected_revision, validate_data(conn, kind, body.data, current["data"], record_id=record_id))
        return idempotent(conn, idempotency_key, f"edit:{kind}:{record_id}:{session.user_id}", body.model_dump(), perform)
