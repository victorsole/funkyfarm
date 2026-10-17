"""Reviewed, source-linked response packs and immutable issued snapshots."""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .db import fetch_record, idempotent, insert_record, json_safe, transaction, update_record
from .security import Session, require_roles, require_session
from .models import ApiError, StrictModel
from . import manual_journal
from .records import matches_reporting_period, physical_identity as _physical_identity
from .reconciliation import selected_fact_ids, reconciliation_for_farm
from .report_render import csv_bytes, literal, pdf_bytes, readable, xlsx_bytes
from .parcel_formats import row_issues
from .report_views import BYTE_LIMIT, PAGE_LIMIT, SECTIONS, bounded_page, compact_record, summary_data_sql


router = APIRouter(tags=["reporting"])
PACK_DIRECTORY = Path(__file__).resolve().parents[3] / "packs"


def fail(code, message, status=422, **details):
    raise ApiError(status, code, message, details)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def _pack_values():
    values = []
    for path in sorted(PACK_DIRECTORY.glob("*.json")):
        content = json.loads(path.read_text(encoding="utf-8-sig"))
        values.extend(content if isinstance(content, list) else content.get("packs", [content]))
    return values


load_packs = _pack_values


def get_pack(pack_id):
    for pack in _pack_values():
        if pack.get("id") == pack_id:
            return deepcopy(pack)
    fail("pack_not_found", "This reporting pack is not available.", 404)


@router.get("/packs")
def list_packs(country: str | None = None, year: int | None = None, workflow_id: str | None = None, session: Session = Depends(require_session)):
    packs = [pack for pack in _pack_values() if (not country or pack.get("country") in (None, country.upper())) and (not year or _pack_year_matches(pack, year)) and (not workflow_id or pack.get("workflow_id") == workflow_id)]
    return {"items": packs, "total": len(packs), "limit": len(packs), "offset": 0}


@router.get("/packs/{pack_id}")
def pack_detail(pack_id: str, session: Session = Depends(require_session)):
    return get_pack(pack_id)


def _pack_year_matches(pack, year):
    years = pack.get("years", pack.get("reporting_years"))
    if years is not None:
        return year in years
    fixed = pack.get("reporting_year", pack.get("year"))
    return fixed is None or fixed == year


def _get(conn, kind, record_id):
    record = fetch_record(conn, kind, str(record_id))
    if record is None:
        fail("not_found", "This record is not available in your workspace.", 404)
    return record


def _records(conn, kind, farm_id=None):
    params = [kind]
    where = "kind = %s AND deleted_at IS NULL"
    if farm_id is not None:
        where += " AND data->>'farm_id' = %s"
        params.append(str(farm_id))
    rows = conn.execute(f"SELECT id FROM records WHERE {where} ORDER BY created_at, id", params).fetchall()
    return [_get(conn, kind, row["id"] if isinstance(row, dict) else row[0]) for row in rows]


def _field_specs(pack):
    fields = pack.get("fields") or pack.get("mappings") or pack.get("field_mappings") or pack.get("required_facts") or []
    if isinstance(fields, dict):
        fields = [dict(value, field=key) if isinstance(value, dict) else {"field": key, "fact_key": value} for key, value in fields.items()]
    result = []
    for value in fields:
        field = {"key": value} if isinstance(value, str) else dict(value)
        key = field.get("fact_key", field.get("source_key", field.get("key", field.get("fact"))))
        if not key:
            continue
        field["fact_key"] = key
        field["field"] = field.get("official_field", field.get("target", field.get("field_code", field.get("field", key))))
        field["label"] = field.get("label", key)
        field["required"] = field.get("required", True)
        result.append(field)
    return result


def _revision(record):
    return {"id": str(record["id"]), "revision": record["revision"], "data": deepcopy(record["data"])}


def _request_context(data):
    result = {key: deepcopy(data.get(key)) for key in ("farm_id", "title", "recipient", "country", "region", "reporting_year", "deadline", "pack_id")}
    result["requirements"] = []
    for requirement in data.get("requirements", []):
        if isinstance(requirement, str):
            result["requirements"].append(requirement)
        elif isinstance(requirement, dict):
            result["requirements"].append({key: deepcopy(requirement[key]) for key in ("key", "fact_key", "label", "required", "type", "unit", "temporal_basis", "period", "parcel_id", "field_id", "group_id") if key in requirement})
    return result


def _farm_groups(data):
    groups = []
    parcels = data.get("parcels")
    for index, parcel in enumerate(parcels if isinstance(parcels, list) else []):
        if isinstance(parcel, dict):
            groups.append({"id": str(parcel.get("id", f"legacy-{index}")), "name": parcel.get("name"), "type": "parcel", "parent_id": parcel.get("parent_id"), "revision": parcel.get("revision")})
    sites = data.get("sites")
    for index, site in enumerate(sites if isinstance(sites, list) else []):
        if not isinstance(site, dict) or not site.get("id"):
            continue
        site_id = str(site["id"])
        groups.append({"id": site_id, "name": site.get("name"), "type": "site", "parent_id": None, "revision": site.get("revision")})
        nested = site.get("parcels")
        for parcel in (nested if isinstance(nested, list) else []):
            if isinstance(parcel, dict) and parcel.get("id"):
                groups.append({"id": str(parcel["id"]), "name": parcel.get("name"), "type": "parcel", "parent_id": site_id, "revision": parcel.get("revision")})
    return groups


def _farm_context(data, group_ids):
    result = {key: deepcopy(data.get(key)) for key in ("name", "country", "region")}
    result["groups"] = []
    result["groups"] = [group for group in _farm_groups(data) if group["id"] in group_ids]
    return result


def _recipient_request(record):
    if record is None:
        return None
    public = _request_context(record["data"])
    del public["farm_id"]
    return {"id": str(record["id"]), "revision": record["revision"], "data": public}


def _same_period(fact, year):
    return matches_reporting_period(fact["data"], year)


def _record_uuid(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError):
        return None


def _matches_requirement(fact, requirement, year):
    data = fact["data"]
    key = requirement.get("fact_key", requirement.get("key"))
    group = _physical_identity(requirement)
    basis = requirement.get("temporal_basis")
    prefix = requirement.get("fact_key_prefix")
    matches_key = bool(re.fullmatch(re.escape(prefix) + r"[a-f0-9]{64}", str(data.get("key", "")))) if prefix else data.get("key") == key
    return matches_key and (group is None or _physical_identity(data) == group) and matches_reporting_period(data, year, basis=basis, period=requirement.get("period"))


def _source_refs(data, selected, record_kinds=None):
    result = []
    for value in data.get("sources", []):
        if not isinstance(value, dict):
            continue
        document_id = value.get("document_id")
        record_id = _record_uuid(value.get("record_id"))
        record_kind = (record_kinds or {}).get(record_id, value.get("record_kind"))
        if record_kind in ("document", "documents") and record_id:
            document_id = record_id
        if document_id is not None and str(document_id) not in selected:
            continue
        # A report carries source locations, never file paths, access URLs or raw documents.
        allowed = ("document_id", "document_revision", "record_id", "record_kind", "source_id", "source_kind", "file_name", "row", "row_number", "sheet", "column", "page", "line_start", "line_end", "quote", "location", "source_key", "adapter", "revision", "origin", "import_id", "row_id", "source_name", "sha256", "grain", "adapter_profile", "decimal_separator", "source_year")
        retained = {key: deepcopy(value[key]) for key in allowed if key in value and (key != "quote" or document_id is not None)}
        if record_kind:
            retained["record_kind"] = record_kind
        if document_id is not None:
            retained["document_id"] = str(document_id)
        result.append(retained)
    return result


def _current_operation(records, operation_id):
    """Follow explicit confirmed corrections only, never a field/date match."""
    by_id = {str(record["id"]): record for record in records}
    current, seen = str(operation_id), set()
    while current in by_id:
        if current in seen:
            return by_id[current], True
        seen.add(current)
        successors = [record for record in records if record["data"].get("review_status") == "confirmed"
                      and str(record["data"].get("supersedes_id")) == current]
        if not successors:
            return by_id[current], False
        if len(successors) != 1:
            return by_id[current], True
        current = str(successors[0]["id"])
    return None, False


class ManualJournalSelection(StrictModel):
    source_fact_id: UUID
    source_fact_revision: int = Field(ge=1, strict=True)
    entry_ids: list[UUID] = Field(min_length=1, max_length=256)
    acknowledged_unresolved: bool = Field(strict=True)


class CreateReport(BaseModel):
    farm_id: UUID
    request_id: UUID | None = None
    pack_id: str = Field(min_length=1, max_length=160)
    reporting_year: int = Field(ge=2000, le=2200)
    fact_ids: list[UUID] | None = Field(default=None, max_length=5000)
    selected_document_ids: list[UUID] = Field(default_factory=list, max_length=250)
    operation_ids: list[UUID] = Field(default_factory=list, max_length=1000)
    manual_journal_selection: ManualJournalSelection | None = None


class ApproveReport(BaseModel):
    expected_revision: int = Field(ge=1)
    snapshot_checksum: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    check_fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ReissueReport(ApproveReport):
    fact_ids: list[UUID] | None = Field(default=None, max_length=5000)
    selected_document_ids: list[UUID] | None = Field(default=None, max_length=250)
    operation_ids: list[UUID] | None = Field(default=None, max_length=1000)
    manual_journal_selection: ManualJournalSelection | None = None


class ReceiptInput(ApproveReport):
    reference: str = Field(min_length=1, max_length=500)
    date: date


def _prepare(conn, body, actor, correction_of=None):
    farm = _get(conn, "farms", body.farm_id)
    pack = get_pack(body.pack_id)
    if not _pack_year_matches(pack, body.reporting_year):
        fail("pack_period", "This pack does not cover the selected reporting year.")
    country = farm["data"].get("country")
    if country and pack.get("country") and country.upper() != pack["country"].upper():
        fail("pack_country", "The pack country must match the farm country.")
    pack_region = pack.get("region")
    farm_region = farm["data"].get("region")
    if pack_region not in (None, "") and (not isinstance(farm_region, str) or farm_region.strip().casefold() != str(pack_region).strip().casefold()):
        fail("pack_region", "Select the reporting format for the farm's region.")
    request = _get(conn, "requests", body.request_id) if body.request_id else None
    if request:
        request_data = request["data"]
        if request_data.get("farm_id") != str(body.farm_id):
            fail("request_farm", "The request belongs to another farm.")
        if request_data.get("reporting_year") not in (None, body.reporting_year):
            fail("request_period", "The request and report must use the same reporting year.")
        if pack.get("country") and request_data.get("country") not in (None, pack.get("country")):
            fail("request_country", "The request and reporting pack use different countries.")
        request_region = request_data.get("region")
        if pack_region not in (None, "") and request_region not in (None, "") and str(request_region).strip().casefold() != str(pack_region).strip().casefold():
            fail("request_region", "The request and reporting format use different regions.")
        if request_data.get("pack_id") not in (None, "", body.pack_id):
            fail("request_pack", "Use the reporting pack selected for this request.")
    specs = _field_specs(pack)
    journal_pack = pack.get("journal_schema") == "cz-ppp-journal-v1"
    manual_pack = pack.get("journal_schema") == manual_journal.SCHEMA_ID
    manual_selection = body.manual_journal_selection
    if manual_selection is not None and not manual_pack:
        fail("pt_journal_pack", "Use the Portuguese literal-journal preparation pack for this selection.")
    if manual_pack and (manual_selection is None or body.fact_ids is None or body.operation_ids):
        fail("pt_journal_selection_required", "Explicitly select the source journal fact and its dated rows. This manual preparation does not select work records.")
    farm_facts = _records(conn, "facts", body.farm_id)
    excluded = selected_fact_ids(conn, str(body.farm_id))["excluded_fact_ids"]
    if body.fact_ids is not None:
        facts = [_get(conn, "facts", fact_id) for fact_id in dict.fromkeys(body.fact_ids)]
        if any(fact["data"].get("farm_id") != str(body.farm_id) for fact in facts):
            fail("fact_farm", "All selected facts must belong to the selected farm.")
    else:
        requirements = [{"key": item} if isinstance(item, str) else item for item in (request["data"].get("requirements", []) if request else [])]
        selectors = [*specs, *(item for item in requirements if isinstance(item, dict) and item.get("type") != "evidence")]
        facts = [fact for fact in farm_facts if str(fact["id"]) not in excluded and fact["data"].get("review_status") != "rejected" and any(_matches_requirement(fact, selector, body.reporting_year) for selector in selectors)]
    selected = {str(value) for value in body.selected_document_ids}
    manual = None
    if manual_pack:
        sources = [fact for fact in facts if fact["data"].get("key") == manual_journal.FACT_KEY]
        if len(sources) != 1 or str(sources[0]["id"]) != str(manual_selection.source_fact_id):
            fail("pt_journal_selection_required", "Select exactly one Portuguese source journal, including its ID in fact_ids.")
        if str(sources[0]["id"]) in excluded:
            fail("pt_journal_source_unreviewed", "Select a current source journal that has not been excluded by reconciliation.")
        manual = manual_journal.build_journal(farm, sources[0], manual_selection.entry_ids, body.reporting_year,
            source_fact_revision=manual_selection.source_fact_revision, acknowledged_unresolved=manual_selection.acknowledged_unresolved)
    operation_dependencies = {}
    record_dependencies = {}
    journal_document_dependencies = {}
    operations = []
    selected_operations = {str(value) for value in body.operation_ids}
    selected_operation_records = [_get(conn, "operations", operation_id) for operation_id in sorted(selected_operations)]
    selected_operations_by_id = {str(record["id"]): record for record in selected_operation_records}
    if any(record["data"].get("farm_id") != str(body.farm_id) for record in selected_operation_records):
        fail("operation_farm", "Select activities belonging to this farm.")
    if journal_pack:
        from .ppp_journal import active_entries
        active_ids = {str(record["id"]) for record in active_entries(_records(conn, "operations", body.farm_id)) if record["data"].get("review_status") == "confirmed"}
        if selected_operations - active_ids:
            fail("journal_active_entries_required", "Select confirmed current applications, not an earlier corrected or unreviewed entry.", operation_ids=sorted(selected_operations - active_ids))
    linked_operations = set()
    source_records = [("fact_id", fact) for fact in facts]
    if journal_pack:
        source_records.extend(("operation_id", record) for record in selected_operation_records)

    def retain_journal_document(document, source_owner, cited_revision, identity_key):
        if manual_pack and (document["data"].get("farm_id") != str(body.farm_id) or type(cited_revision) is not int or cited_revision != document["revision"]):
            fail("pt_journal_source_changed", "Review the exact current same-farm source document before selecting this journal.", 409, document_id=str(document["id"]))
        if document["data"].get("farm_id") not in (None, "", str(body.farm_id)):
            fail("source_farm", "A journal input's cited document belongs to a different farm.", **{identity_key: str(source_owner["id"])})
        retained = journal_document_dependencies.setdefault(str(document["id"]), {
            "revision": document["revision"], "checksum": digest(document["data"]),
            "cited_revisions": [], "operation_ids": [], "fact_ids": [],
        })
        if cited_revision is not None and cited_revision not in retained["cited_revisions"]:
            retained["cited_revisions"].append(cited_revision)
        owner_id = str(source_owner["id"])
        identities = retained["operation_ids" if identity_key == "operation_id" else "fact_ids"]
        if owner_id not in identities:
            identities.append(owner_id)

    for identity_key, source_owner in source_records:
        for source in source_owner["data"].get("sources", []):
            if not isinstance(source, dict):
                continue
            # Dependency validation is private and independent of attachment
            # selection. Read the original source before recipient filtering.
            if (journal_pack or manual_pack) and (document_id := _record_uuid(source.get("document_id"))):
                document = _get(conn, "documents", document_id)
                retain_journal_document(document, source_owner, source.get("document_revision"), identity_key)
            if not (record_id := _record_uuid(source.get("record_id"))):
                continue
            # The database is authoritative for legacy references without a kind.
            # Do not probe every source UUID as an operation: it may be a reused
            # fact, purchase or another workspace-scoped source record.
            row = conn.execute("SELECT kind FROM records WHERE id = %s", (record_id,)).fetchone()
            if row is None:
                fail("source_unavailable", "A selected answer's source record is no longer available. Review its provenance.", 409, **{identity_key: str(source_owner["id"])}, record_id=record_id)
            actual_kind = row["kind"]
            declared = source.get("record_kind")
            aliases = {"fact": "facts", "purchase": "purchases", "sale": "sales", "operation": "operations", "document": "documents"}
            if declared is not None and aliases.get(str(declared), str(declared)) != actual_kind:
                fail("source_kind_mismatch", "A selected answer's source type differs from its stored record. Review its provenance.", 409, **{identity_key: str(source_owner["id"])}, record_id=record_id)
            source_record = fetch_record(conn, actual_kind, record_id)
            source_farm = str(source_record["id"]) if actual_kind == "farms" else source_record["data"].get("farm_id")
            if source_farm not in (None, "", str(body.farm_id)):
                fail("source_farm", "A selected answer's source record belongs to a different farm.", **{identity_key: str(source_owner["id"])})
            if (journal_pack or manual_pack) and actual_kind == "documents":
                retain_journal_document(source_record, source_owner, source.get("document_revision", source.get("revision")), identity_key)
            if actual_kind == "operations":
                linked_operations.add(record_id)
            else:
                record_dependencies[record_id] = {"kind": actual_kind, "revision": source_record["revision"], "checksum": digest(source_record["data"])}
    for operation_id in sorted(selected_operations | linked_operations):
        operation = selected_operations_by_id.get(operation_id) or fetch_record(conn, "operations", operation_id)
        if operation is None:
            if operation_id in selected_operations:
                fail("operation_not_found", "A selected farm activity is not available.", 404)
            continue
        if operation["data"].get("farm_id") != str(body.farm_id):
            if operation_id in selected_operations:
                fail("operation_farm", "Select activities belonging to this farm.")
            continue
        operation_dependencies[operation_id] = {"revision": operation["revision"], "checksum": digest(operation["data"])}
        if operation_id in selected_operations:
            public_keys = ("title", "date", "type", "quantity", "unit", "parcel", "parcel_id", "field_id", "crop", "product", "operator", "hours", "period", "temporal_basis", "review_status")
            if journal_pack:
                public_keys += ("farm_id", "dose", "dose_unit", "treated_size", "treated_unit", "cz_ppp", "supersedes_id", "sources")
            operations.append({"id": operation_id, "revision": operation["revision"], "data": {key: deepcopy(operation["data"][key]) for key in public_keys if key in operation["data"]}})
    evidence = []
    for document_id in sorted(selected):
        document = _get(conn, "documents", document_id)
        linked_farm = document["data"].get("farm_id")
        if linked_farm not in (None, "", str(body.farm_id)):
            fail("evidence_farm", "Selected evidence belongs to another farm.")
        evidence.append({"id": str(document["id"]), "revision": document["revision"], "data_checksum": digest(document["data"]), "name": document["data"].get("name", document["data"].get("filename", "Document"))})
    snapshot_facts = []
    source_record_kinds = {record_id: state["kind"] for record_id, state in record_dependencies.items()}
    source_record_kinds.update({record_id: "operations" for record_id in operation_dependencies})
    if journal_pack:
        for operation in operations:
            operation["data"]["sources"] = _source_refs(operation["data"], selected, source_record_kinds)
    for fact in facts:
        retained = {"id": str(fact["id"]), "revision": fact["revision"], "data": {key: deepcopy(fact["data"][key]) for key in ("key", "label", "value", "unit", "period", "temporal_basis", "review_status", "sources", "parcel_id", "field_id", "group_id") if key in fact["data"]}}
        retained["data"]["sources"] = _source_refs(fact["data"], selected, source_record_kinds)
        if manual and str(fact["id"]) == manual["holder"]["fact_id"]:
            # Recipient snapshots contain only the explicitly selected rows, in
            # reviewed order. The private dependency hash still binds all input.
            by_id = {entry["entry_id"]: entry for entry in retained["data"]["value"]["entries"]}
            retained["data"]["value"]["entries"] = [by_id[identifier] for identifier in manual["selection"]["entry_ids"]]
        snapshot_facts.append(retained)
    fields = []
    if specs:
        for spec in specs:
            matching = [fact for fact in snapshot_facts if _matches_requirement(fact, spec, body.reporting_year)]
            if not matching:
                if spec.get("fact_key_prefix") and not spec["required"]:
                    continue
                fields.append({"field": spec["field"], "label": spec["label"], "required": spec["required"], "missing": True, "fact_key": spec["fact_key"], "physical_group_id": _physical_identity(spec)})
            seen_values = set()
            for fact in matching:
                data = fact["data"]
                signature = canonical([data.get("key") if spec.get("fact_key_prefix") else None, data.get("value"), data.get("unit"), data.get("period"), data.get("temporal_basis"), _physical_identity(data)])
                if signature in seen_values:
                    continue
                seen_values.add(signature)
                field = {"field": spec["field"], "label": spec["label"], "required": spec["required"], "fact_key": data.get("key") if spec.get("fact_key_prefix") else spec["fact_key"], "fact_id": fact["id"], "fact_revision": fact["revision"], "value": deepcopy(data.get("value")), "unit": data.get("unit"), "period": data.get("period"), "temporal_basis": data.get("temporal_basis"), "sources": deepcopy(data.get("sources", []))}
                if spec.get("import_profile") and spec.get("row_columns"):
                    # An issued document must render from its retained definitions,
                    # never from a later country-profile file.
                    field["row_schema"] = {"id": spec["import_profile"], **{key: deepcopy(spec[key]) for key in ("row_columns", "holding_column", "identity_columns", "minimum_headers")}}
                    field["label"] = data.get("label") or spec["label"]
                    field["group_label"] = spec["label"]
                fields.append(field)
    else:
        for fact in snapshot_facts:
            data = fact["data"]
            fields.append({"field": data.get("key", ""), "label": data.get("label", data.get("key", "")), "required": False, "fact_key": data.get("key"), "fact_id": fact["id"], "fact_revision": fact["revision"], "value": deepcopy(data.get("value")), "unit": data.get("unit"), "period": data.get("period"), "temporal_basis": data.get("temporal_basis"), "sources": deepcopy(data.get("sources", []))})
    selected_facts_by_id = {fact["id"]: fact for fact in snapshot_facts}
    for field in fields:
        if not field.get("missing"):
            field["physical_group_id"] = _physical_identity(selected_facts_by_id.get(field.get("fact_id"), {}).get("data", {}))
    included = {canonical([field.get("fact_key"), field.get("value"), field.get("unit"), field.get("period"), field.get("temporal_basis"), field.get("physical_group_id")]) for field in fields if not field.get("missing")}
    for fact in snapshot_facts:
        data = fact["data"]
        signature = canonical([data.get("key"), data.get("value"), data.get("unit"), data.get("period"), data.get("temporal_basis"), _physical_identity(data)])
        if signature not in included:
            fields.append({"field": "annex." + data.get("key", "fact"), "label": data.get("label", data.get("key", "Farm detail")), "required": False, "fact_key": data.get("key"), "fact_id": fact["id"], "fact_revision": fact["revision"], "value": deepcopy(data.get("value")), "unit": data.get("unit"), "period": data.get("period"), "temporal_basis": data.get("temporal_basis"), "sources": deepcopy(data.get("sources", [])), "group_label": "Additional selected farm facts", "mapping": "supporting_fact", "physical_group_id": _physical_identity(data)})
            included.add(signature)
    reference_only = pack.get("capability", pack.get("status", pack.get("mapping_status"))) == "reference_only" or pack.get("reference_only") is True
    if manual:
        fields = [field for field in fields if field.get("fact_id") != manual["holder"]["fact_id"]]
        literal_fields = manual_journal.mapped_fields(manual)
        retained_source = next(fact for fact in snapshot_facts if fact["id"] == manual["holder"]["fact_id"])
        for field in literal_fields:
            field["sources"] = deepcopy(retained_source["data"].get("sources", []))
        fields.extend(literal_fields)
    if reference_only:
        notice = "Reference-only dossier: this pack has no implemented national compliance mapping."
    elif pack.get("capability") == "generic_dossier" or pack.get("country") is None:
        notice = "Generic farm evidence dossier. It is not a national form or a legal compliance determination."
    else:
        notice = "Prepared country-specific draft. Domain review and authority acceptance are separate from report approval."
    validation_sources = {"farm": {"id": str(farm["id"]), "revision": farm["revision"], "checksum": digest(farm["data"])}, "request": {"id": str(request["id"]), "checksum": digest(_request_context(request["data"]))} if request else None, "facts": {str(fact["id"]): digest(fact["data"]) for fact in facts}, "documents": {item["id"]: item["data_checksum"] for item in evidence}, "operations": operation_dependencies, "records": record_dependencies}
    if journal_document_dependencies:
        validation_sources["journal_documents"] = journal_document_dependencies
    for item in evidence:
        del item["data_checksum"]
    all_groups = _farm_groups(farm["data"])
    referenced = {str(identity) for item in [*snapshot_facts, *operations] if (identity := _physical_identity(item["data"])) not in (None, "")}
    referenced.update(str(item["data"]["parcel"]) for item in operations if item["data"].get("parcel") not in (None, ""))
    chosen_group_ids = {group["id"] for group in all_groups if group["id"] in referenced or str(group.get("name")) in referenced}
    pending = list(chosen_group_ids)
    while pending:
        group_id = pending.pop()
        group = next((item for item in all_groups if item["id"] == group_id), None)
        parent_id = str(group["parent_id"]) if group and group.get("parent_id") else None
        if parent_id and parent_id not in chosen_group_ids:
            chosen_group_ids.add(parent_id)
            pending.append(parent_id)
    physical_groups = [group for group in all_groups if group["id"] in chosen_group_ids]

    def group_label(group):
        labels, seen = [], set()
        while group and group["id"] not in seen:
            seen.add(group["id"])
            if group.get("name"):
                labels.append(str(group["name"]))
            group = next((item for item in physical_groups if item["id"] == str(group.get("parent_id"))), None)
        return " / ".join(reversed(labels))

    for operation in operations:
        group = next((item for item in physical_groups if item["id"] == str(_physical_identity(operation["data"]))), None)
        if group:
            operation["data"]["physical_group_label"] = group_label(group)
    group_ids = [group["id"] for group in physical_groups]
    validation_sources["farm"].update(projection="recipient_farm_context_v1", group_ids=group_ids, checksum=digest(_farm_context(farm["data"], group_ids)))
    facts_by_id = {fact["id"]: fact for fact in snapshot_facts}
    for field in fields:
        source = facts_by_id.get(field.get("fact_id"), {}).get("data", {})
        group_id = source.get("parcel_id", source.get("field_id", source.get("group_id")))
        group = next((item for item in physical_groups if str(item.get("id")) == str(group_id)), None)
        field["group_label"] = group_label(group) if group else field.get("group_label") or next((spec.get("section", spec.get("group")) for spec in specs if spec["field"] == field["field"]), None)
    snapshot = {"schema_version": 2, "pack": pack, "farm": {"id": str(farm["id"]), "revision": farm["revision"], "name": farm["data"].get("name", ""), "country": country}, "request": _recipient_request(request), "reporting_year": body.reporting_year, "facts": snapshot_facts, "fields": fields, "operations": operations, "physical_groups": physical_groups, "evidence": evidence, "capability_notice": notice, "created_at": now(), "correction_of": correction_of}
    if manual:
        snapshot["journals"] = [manual]
        snapshot["capability_notice"] = manual["capability_notice"]
        snapshot["warnings"] = [deepcopy(issue) for issue in manual["issues"] if issue.get("severity") == "warning"]
        snapshot["warnings"].extend({**deepcopy(issue), "entry_id": entry["entry_id"]}
            for entry in manual["entries"] for issue in entry["issues"] if issue.get("severity") == "warning")
    if journal_pack:
        from .ppp_journal import build_journal
        holder = next((deepcopy(fact) for fact in facts if fact["data"].get("key") == "cz.ppp.holder"
                       and fact["data"].get("review_status") == "confirmed"
                       and fact["data"].get("temporal_basis") == "static" and str(fact["id"]) not in excluded), None)
        if holder:
            holder["data"]["sources"] = _source_refs(holder["data"], selected, source_record_kinds)
        journal = build_journal(farm, holder, operations, body.reporting_year)
        snapshot["journals"] = [journal]
        snapshot["capability_notice"] = journal["capability_notice"]
        snapshot["warnings"] = [deepcopy(issue) for issue in journal.get("issues", []) if issue.get("severity") == "warning"]
        snapshot["warnings"].extend({**deepcopy(issue), "operation_id": str(entry["operation_id"])}
                                    for entry in journal["entries"] for issue in entry.get("issues", []) if issue.get("severity") == "warning")
        context = {key: deepcopy(journal[key]) for key in ("schema_id", "pack_id", "title", "country", "reporting_year", "source", "columns")}
        for operation in operations:
            entry = next(item for item in journal["entries"] if str(item["operation_id"]) == operation["id"])
            operation["journal_entry"] = {**deepcopy(context), "entry": deepcopy(entry)}
    data = {"farm_id": str(body.farm_id), "request_id": str(body.request_id) if body.request_id else None, "pack_id": body.pack_id, "reporting_year": body.reporting_year, "status": "draft", "snapshot": snapshot, "checksum": digest(snapshot), "created_by": str(actor.user_id), "approval": None, "correction_of": correction_of, "filing_status": "not_filed"}
    data["validation_sources"] = validation_sources
    data["blockers"] = _blockers(conn, data)
    return data


def _blockers(conn, data):
    snapshot = data["snapshot"]
    validation_sources = data.get("validation_sources", {})
    blockers = []

    def add(code, message, **details):
        entry = {"code": code, "message": message, **details}
        if entry not in blockers:
            blockers.append(entry)

    if digest(snapshot) != data["checksum"]:
        add("snapshot_integrity", "The retained snapshot checksum does not match.")
    if not snapshot["fields"] and not snapshot.get("operations"):
        add("no_facts", "Select at least one farm fact or reviewed activity to prepare this report.")
    for document_id, retained in validation_sources.get("journal_documents", {}).items():
        current = conn.execute("SELECT revision,data FROM records WHERE id=%s AND kind='documents' AND deleted_at IS NULL", (document_id,)).fetchone()
        changed = current is None or current["revision"] != retained["revision"] or digest(current["data"]) != retained["checksum"]
        wrong_citation = current is None or any(revision != current["revision"] for revision in retained["cited_revisions"])
        if changed or wrong_citation:
            for key, identities in (("operation_id", retained["operation_ids"]), ("fact_id", retained["fact_ids"])):
                for owner_id in identities:
                    add("stale_journal_source", "A journal input's cited document changed or its retained citation is out of date. Review the original source before approval.", **{key: owner_id}, record_id=document_id, record_kind="documents")
    for journal in snapshot.get("journals", []):
        for issue in journal.get("issues", []):
            if issue.get("severity") == "error":
                add(issue["code"], issue["message"], **{key: issue[key] for key in ("field", "operation_id", "fact_id") if key in issue})
        for entry in journal.get("entries", []):
            for source in entry.get("data", {}).get("sources", []):
                source_id = _record_uuid(source.get("record_id")) or _record_uuid(source.get("document_id"))
                cited_revision = source.get("revision", source.get("document_revision"))
                if source_id and cited_revision is not None:
                    current_source = conn.execute("SELECT revision FROM records WHERE id=%s AND deleted_at IS NULL", (source_id,)).fetchone()
                    if current_source is None or current_source["revision"] != cited_revision:
                        add("stale_journal_source", "A journal entry cites an earlier source revision. Review the current source before preparing this entry.", operation_id=str(entry["operation_id"]), record_id=source_id)
            for issue in entry.get("issues", []):
                if issue.get("severity") == "error":
                    add(issue["code"], issue["message"], operation_id=str(entry["operation_id"]), **({"field": issue["field"]} if issue.get("field") else {}))
    for field in snapshot["fields"]:
        if field.get("required") and (field.get("missing") or field.get("value") is None or field.get("value") == ""):
            add("missing_fact", f"Provide {field['label']} before approval.", field=field["field"])
    specs = _field_specs(snapshot["pack"])
    if minimum := snapshot["pack"].get("minimum_mapped_rows"):
        mapped = sum(not field.get("missing") and bool(field.get("row_schema")) for field in snapshot["fields"])
        if mapped < minimum:
            add("mapped_rows_required", "Add and confirm at least one source row for this preparation format. This is an app check, not a government filing requirement.")
    all_facts = _records(conn, "facts", data["farm_id"])
    excluded = selected_fact_ids(conn, data["farm_id"])["excluded_fact_ids"]
    for fact in snapshot["facts"]:
        current = fetch_record(conn, "facts", fact["id"])
        fact_data = fact["data"]
        if fact["id"] in excluded:
            add("reconciliation_changed", "This fact was excluded by a recorded reconciliation. Prepare a fresh draft.", fact_id=fact["id"])
        source_checksum = validation_sources.get("facts", {}).get(fact["id"], fact.get("source_checksum"))
        if current is None or current["revision"] != fact["revision"] or digest(current["data"]) != source_checksum:
            add("stale_fact", "A selected fact changed. Prepare a fresh draft before approval.", fact_id=fact["id"])
        if fact_data.get("review_status") != "confirmed":
            add("unreviewed_fact", "Every selected fact needs explicit confirmation.", fact_id=fact["id"])
        if not _same_period(fact, data["reporting_year"]):
            add("wrong_period", "A selected fact does not cover this reporting period.", fact_id=fact["id"])
        conflict_data = current["data"] if current else fact_data
        if conflict_data.get("conflict_status") in ("unresolved", "conflict") or conflict_data.get("has_conflict") or conflict_data.get("conflicts"):
            add("unresolved_conflict", "Resolve the selected fact's conflicting evidence.", fact_id=fact["id"])
        for other in all_facts:
            if current and (current["data"].get("review_status") == "rejected" or current["data"].get("superseded_by")):
                break
            candidate = other["data"]
            if str(other["id"]) == fact["id"] or str(other["id"]) in excluded or candidate.get("review_status") == "rejected" or candidate.get("superseded_by") or candidate.get("conflict_status") == "resolved":
                continue
            if candidate.get("key") == fact_data.get("key") and candidate.get("period") == fact_data.get("period") and candidate.get("temporal_basis") == fact_data.get("temporal_basis") and _physical_identity(candidate) == _physical_identity(fact_data):
                comparison = current["data"] if current and fact_data.get("key") == manual_journal.FACT_KEY else fact_data
                if canonical([candidate.get("value"), candidate.get("unit")]) != canonical([comparison.get("value"), comparison.get("unit")]):
                    add("unresolved_conflict", "Another fact gives a different value or unit for the same field and period.", fact_id=fact["id"], conflicting_fact_id=str(other["id"]))
    for field in snapshot["fields"]:
        spec = next((item for item in specs if item["field"] == field["field"] and (_physical_identity(item) is None or _physical_identity(item) == field.get("physical_group_id"))), {})
        if spec.get("unit") is not None and not field.get("missing") and field.get("unit") != spec["unit"]:
            add("wrong_unit", "The recorded unit differs from the reporting field. Review it without guessing a conversion.", field=field["field"])
        if spec.get("temporal_basis") and not field.get("missing") and field.get("temporal_basis") != spec["temporal_basis"]:
            add("wrong_temporal_basis", "This reporting field needs a different temporal basis.", field=field["field"])
        if field.get("row_schema") and not field.get("missing"):
            schema = field["row_schema"]
            reviews = [source for source in field.get("sources", []) if source.get("adapter_profile") == schema["id"]]
            separators = {source.get("decimal_separator") for source in reviews}
            separator = next(iter(separators)) if len(separators) == 1 else None
            if not reviews or any(source.get("source_year") != data["reporting_year"] for source in reviews):
                add("source_format_review_required", "Review the original source format and year before using this row.", fact_id=field["fact_id"])
            if field.get("unit") is not None or field.get("physical_group_id") is not None:
                add("source_row_scope", "Keep this source row separate from a mapped farm field and retain its units on the original columns.", fact_id=field["fact_id"])
            for issue in row_issues(schema, field.get("value"), separator):
                if issue["severity"] == "error":
                    add(issue["code"], issue["message"], field=issue.get("field"), fact_id=field["fact_id"])
    for document in snapshot["evidence"]:
        current = fetch_record(conn, "documents", document["id"])
        source_checksum = validation_sources.get("documents", {}).get(document["id"], document.get("data_checksum"))
        if current is None or current["revision"] != document["revision"] or digest(current["data"]) != source_checksum:
            add("stale_evidence", "Selected evidence changed. Prepare a fresh draft before approval.", document_id=document["id"])
    operation_sources = validation_sources.get("operations", {})
    farm_operations = _records(conn, "operations", data["farm_id"]) if operation_sources else []
    for operation_id, retained in operation_sources.items():
        current = fetch_record(conn, "operations", operation_id)
        if current is None or current["revision"] != retained["revision"] or digest(current["data"]) != retained["checksum"]:
            add("stale_operation", "A farm activity used by this report changed. Prepare an amendment from the updated record.", operation_id=operation_id)
        if current and current["data"].get("review_status") != "confirmed":
            add("unreviewed_operation", "Confirm every selected farm activity before approval.", operation_id=operation_id)
        successor, conflict = _current_operation(farm_operations, operation_id)
        if conflict:
            add("operation_correction_conflict", "Resolve the competing or circular confirmed application corrections before approval.", operation_id=operation_id)
        elif successor and str(successor["id"]) != operation_id:
            add("operation_superseded", "A separately confirmed correction replaces this application. Prepare a fresh draft from the current entry.", operation_id=operation_id, successor_id=str(successor["id"]))
    for record_id, retained in validation_sources.get("records", {}).items():
        row = conn.execute("SELECT kind, revision, data FROM records WHERE id = %s", (record_id,)).fetchone()
        if row is None or row["kind"] != retained["kind"] or row["revision"] != retained["revision"] or digest(row["data"]) != retained["checksum"]:
            add("stale_source_record", "A source record used by a selected farm answer changed. Review it and prepare an amendment.", record_id=record_id, record_kind=retained["kind"])
        if row and retained["kind"] == "sales" and row["data"].get("review_status") != "confirmed":
            add("unreviewed_source_record", "Check and confirm the sale used as a source before approving this response.", record_id=record_id, record_kind="sales")
    for operation in snapshot.get("operations", []):
        recorded = operation["data"]
        operation_date = recorded.get("date")
        period = recorded.get("period")
        if not ((isinstance(operation_date, str) and operation_date[:4] == str(data["reporting_year"])) or period in (data["reporting_year"], str(data["reporting_year"]))):
            add("operation_period", "Check the selected activity's date or reporting period.", operation_id=operation["id"])
    for kind, retained in (("farms", snapshot["farm"]), ("requests", snapshot.get("request"))):
        if not retained:
            continue
        current = fetch_record(conn, kind, retained["id"])
        source = validation_sources.get("request" if kind == "requests" else "farm") or {}
        old_checksum = source.get("checksum", retained.get("data_checksum", digest(_request_context(retained.get("data", {})))))
        if current and kind == "requests":
            current_checksum = digest(_request_context(current["data"]))
        elif current and source.get("projection") == "recipient_farm_context_v1":
            current_checksum = digest(_farm_context(current["data"], source.get("group_ids", [])))
        else:
            current_checksum = digest(current["data"]) if current else None
        if current is None or current_checksum != old_checksum or (kind != "requests" and not source.get("projection") and current["revision"] != retained["revision"]):
            add("stale_context", "The farm or request changed. Prepare a fresh draft before approval.")
    selected_keys = {(fact["data"].get("key"), literal(fact["data"].get("period")), fact["data"].get("temporal_basis"), _physical_identity(fact["data"])) for fact in snapshot["facts"]}
    for conflict in reconciliation_for_farm(conn, data["farm_id"]):
        conflict_data = conflict["data"]
        if conflict_data.get("status") != "resolved" and (conflict_data.get("key"), literal(conflict_data.get("period")), conflict_data.get("temporal_basis"), _physical_identity(conflict_data)) in selected_keys:
            add("unresolved_conflict", "Resolve the recorded evidence disagreement before approval.", conflict_id=str(conflict["id"]))
    try:
        current_pack = get_pack(data["pack_id"])
        if digest(current_pack) != digest(snapshot["pack"]):
            add("stale_pack", "The reporting pack changed. Prepare a fresh draft before approval.")
    except (HTTPException, ApiError):
        add("stale_pack", "The original reporting pack is no longer available.")
    if snapshot.get("request"):
        for requirement in snapshot["request"]["data"].get("requirements", []):
            req = {"key": requirement} if isinstance(requirement, str) else requirement
            if not isinstance(req, dict) or req.get("required", True) is False:
                continue
            key = req.get("fact_key", req.get("key"))
            matching = [field for field in snapshot["fields"] if key and field.get("fact_key") == key and not field.get("missing") and (_physical_identity(req) is None or field.get("physical_group_id") == _physical_identity(req))]
            context_matching = [field for field in matching if matches_reporting_period(field, data["reporting_year"], basis=req.get("temporal_basis"), period=req.get("period"))]
            if key and not any(field.get("value") is not None and field.get("value") != "" for field in matching):
                add("missing_requirement", f"Provide {req.get('label', key)} requested by the recipient.", field=key)
            elif matching and not context_matching:
                if req.get("temporal_basis") is not None and not any(field.get("temporal_basis") == req["temporal_basis"] for field in matching):
                    add("requirement_temporal_basis", f"Review the time basis for {req.get('label', key)} requested by the recipient.", field=key)
                else:
                    add("requirement_period", f"Provide {req.get('label', key)} for the exact reporting period requested by the recipient.", field=key)
            elif key and not any(field.get("value") is not None and field.get("value") != "" for field in context_matching):
                add("missing_requirement", f"Provide {req.get('label', key)} requested by the recipient.", field=key)
            if req.get("unit") is not None and any(field.get("unit") != req["unit"] for field in context_matching):
                add("requirement_unit", f"Review the recorded unit for {req.get('label', key)} requested by the recipient.", field=key)
            if req.get("type") == "evidence" and not snapshot["evidence"]:
                add("missing_evidence", "Select evidence requested by the recipient.")
    return blockers


def _impact(conn, report, blockers=None):
    if report["data"].get("status") != "issued":
        return {"needed": False, "changes": [], "message": "Review this draft before approval."}
    relevant = {"stale_fact", "stale_operation", "stale_source_record", "unreviewed_source_record", "stale_evidence", "stale_context", "stale_pack", "reconciliation_changed", "unresolved_conflict", "unreviewed_operation", "operation_superseded", "operation_correction_conflict", "stale_journal_source"}
    changes = [deepcopy(item) for item in (blockers if blockers is not None else _blockers(conn, report["data"])) if item["code"] in relevant]
    unique = {}
    for change in changes:
        identity = next(((kind, change[key]) for kind, key in (("fact", "fact_id"), ("activity", "operation_id"), ("document", "document_id"), ("source", "record_id")) if change.get(key)), ("context", change["code"]))
        if identity not in unique or change["code"] in ("stale_fact", "stale_operation"):
            unique[identity] = change
    changes = list(unique.values())
    farm_operations = _records(conn, "operations", report["data"]["farm_id"]) if any(change.get("operation_id") for change in changes) else []
    for change in changes:
        if change.get("fact_id"):
            prior = next((fact for fact in report["data"]["snapshot"]["facts"] if fact["id"] == change["fact_id"]), None)
            current = fetch_record(conn, "facts", change["fact_id"])
            visited = set()
            while current and current["data"].get("superseded_by") and str(current["id"]) not in visited:
                visited.add(str(current["id"]))
                current = fetch_record(conn, "facts", current["data"]["superseded_by"])
            if prior:
                change["label"] = prior["data"].get("label", prior["data"].get("key", "Farm detail"))
                change["previous"] = {key: deepcopy(prior["data"].get(key)) for key in ("value", "unit", "period")}
            if current:
                change["current"] = {key: deepcopy(current["data"].get(key)) for key in ("value", "unit", "period", "review_status")}
            if change["code"] == "stale_fact":
                change["message"] = "A farm detail or its reviewed source changed after this version was prepared."
        if change.get("operation_id"):
            prior = next((operation for operation in report["data"]["snapshot"].get("operations", []) if operation["id"] == change["operation_id"]), None)
            current, correction_conflict = _current_operation(farm_operations, change["operation_id"])
            if current:
                change["current_operation_id"] = str(current["id"])
                change["current_operation_revision"] = current["revision"]
            if correction_conflict:
                change["message"] = "Resolve the confirmed correction lineage before preparing an amendment."
            if prior:
                change["label"] = prior["data"].get("title", "Farm activity")

                def activity_summary(data):
                    parts = [str(data.get("date") or data.get("period") or "Date not recorded")]
                    if data.get("product"):
                        parts.append(str(data["product"]))
                    if data.get("dose") is not None:
                        raw = (data.get("cz_ppp") or {}).get("original_numbers", {}).get("dose", data["dose"])
                        parts.append(f"Dose {raw} {data.get('dose_unit') or 'unit not supplied'}")
                    if "quantity" in data:
                        parts.append(readable(data["quantity"]) + (f" {data['unit']}" if data.get("unit") not in (None, "") else ""))
                    if "hours" in data:
                        parts.append(f"{readable(data['hours'])} hours")
                    return " · ".join(parts)

                change["previous_text"] = activity_summary(prior["data"])
                change["current_text"] = activity_summary(current["data"]) if current else "Activity no longer available"
                if prior.get("journal_entry"):
                    change["previous"] = {"operation_id": prior["id"], "revision": prior["revision"], "data": deepcopy(prior["data"])}
                    if current:
                        public = {key: deepcopy(current["data"][key]) for key in prior["data"] if key in current["data"] and key != "sources"}
                        change["current"] = {"operation_id": str(current["id"]), "revision": current["revision"], "data": public}
    return {"needed": bool(changes), "changes": changes, "message": "Records used by this issued report have changed. Review the changes and prepare an amendment; the issued version stays intact." if changes else "The records used by this issued version have not changed.", "next_action": "prepare_amendment" if changes else None}


def _summary_records(conn, where, params, *, limit=None, offset=0, newest=False):
    order = "created_at DESC,id DESC" if newest else "created_at,id"
    suffix = " LIMIT %s OFFSET %s" if limit is not None else ""
    arguments = [*params, limit, offset] if limit is not None else params
    rows = conn.execute("SELECT id,kind,workspace_id,revision," + summary_data_sql() + " AS data,created_at,updated_at "
                        f"FROM records WHERE {where} ORDER BY {order}{suffix}", arguments).fetchall()
    return [compact_record(row) for row in json_safe(rows)]


def _report_history(conn, report):
    """Read only this report's receipts and small correction identities."""
    report_id = str(report["id"])
    receipts = conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records "
                            "WHERE kind='report_receipts' AND deleted_at IS NULL AND data->>'report_id'=%s "
                            "ORDER BY created_at,id", (report_id,)).fetchall()
    reissues = conn.execute("SELECT id,data->>'status' AS status FROM records WHERE kind='reports' "
                           "AND deleted_at IS NULL AND data->>'correction_of'=%s ORDER BY created_at,id",
                           (report_id,)).fetchall()
    return json_safe(receipts), json_safe(reissues)


def _review_state(conn, report, session, blockers=None):
    blockers = _blockers(conn, report["data"]) if blockers is None else blockers
    impact = _impact(conn, report, blockers)
    receipts, reissues = _report_history(conn, report)
    issued = report["data"]["status"] == "issued"
    can_approve = False
    if report["data"]["status"] == "draft" and not blockers and session.role in ("owner", "adviser"):
        access = conn.execute("SELECT record_access(id,kind,data,true) AS allowed FROM records "
                              "WHERE kind='reports' AND id=%s AND deleted_at IS NULL", (str(report["id"]),)).fetchone()
        can_approve = bool(access and access["allowed"])
    reason = "Approval is recorded for this retained version." if issued else (
        "Resolve the outstanding report issues." if blockers else (
            None if can_approve else "Only an owner or an adviser with review permission can approve."))
    snapshot = report["data"]["snapshot"]
    sections = {key: snapshot.get(key, []) for key in ("fields", "operations", "evidence")}
    sections.update(blockers=blockers, changes=impact["changes"], receipts=receipts, reissues=reissues)
    # No timestamps/random tokens: the same evaluated content has the same
    # fingerprint, including when checked again under the approval source locks.
    fingerprint = digest({"report_id": str(report["id"]), "report_revision": report["revision"],
                          "snapshot_checksum": report["data"]["checksum"], "blockers": blockers,
                          "amendment": impact, "receipts": receipts, "reissues": reissues,
                          "can_approve": can_approve, "approval_blocked_reason": reason})
    return {"sections": sections, "check_fingerprint": fingerprint, "can_approve": can_approve,
            "approval_blocked_reason": reason, "supported_formats": ["pdf", "csv", "json", "xlsx"] if issued else [],
            "amendment": {key: impact.get(key) for key in ("needed", "message", "next_action")}}


def _review_record(conn, report, session):
    current = _review_state(conn, report, session)
    result = compact_record(report, "review")
    result["data"].update({key: current[key] for key in ("can_approve", "approval_blocked_reason", "supported_formats", "amendment")})
    result["data"]["review"] = {"report_revision": report["revision"], "snapshot_checksum": report["data"]["checksum"],
                                "check_fingerprint": current["check_fingerprint"],
                                "sections": {key: len(current["sections"][key]) for key in SECTIONS},
                                "page_limit": PAGE_LIMIT, "byte_limit": BYTE_LIMIT}
    return result


def _approval_payload(body):
    # Preserve hashes for keys created before this additive optional field.
    excluded = {"check_fingerprint"} if body.check_fingerprint is None else set()
    if hasattr(body, "manual_journal_selection") and body.manual_journal_selection is None:
        excluded.add("manual_journal_selection")
    return body.model_dump(mode="json", exclude=excluded)


@router.post("/reports", status_code=201)
def create_report(body: CreateReport, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"), view: Literal["summary"] | None = None):
    with transaction(session) as conn:
        payload = body.model_dump(mode="json", exclude={"manual_journal_selection"} if body.manual_journal_selection is None else set())
        report = idempotent(conn, idempotency_key, "report-create", payload, lambda: insert_record(conn, "reports", _prepare(conn, body, session)))
        return compact_record(report) if view == "summary" else report


@router.get("/reports")
def list_reports(farm_id: UUID | None = None, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session), view: Literal["summary"] | None = None):
    with transaction(session) as conn:
        params = ["reports"]
        where = "kind = %s"
        if farm_id is not None:
            where += " AND data->>'farm_id' = %s"
            params.append(str(farm_id))
        if view == "summary":
            records = _summary_records(conn, where + " AND deleted_at IS NULL", params, limit=limit, offset=offset, newest=True)
            total_row = conn.execute(f"SELECT count(*) AS total FROM records WHERE {where} AND deleted_at IS NULL", params).fetchone()
            return {"items": records, "total": total_row["total"], "limit": limit, "offset": offset}
        total_row = conn.execute(f"SELECT count(*) AS total FROM records WHERE {where}", params).fetchone()
        rows = conn.execute(f"SELECT id FROM records WHERE {where} ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s", [*params, limit, offset]).fetchall()
        records = [_get(conn, "reports", row["id"]) for row in rows]
        for record in records:
            record["data"]["amendment"] = _impact(conn, record)
        return {"items": records, "total": total_row["total"], "limit": limit, "offset": offset}


@router.get("/reports/{report_id}")
def report_detail(report_id: UUID, session: Session = Depends(require_session), view: Literal["review"] | None = None):
    with transaction(session) as conn:
        report = _get(conn, "reports", report_id)
        if view == "review":
            return _review_record(conn, report, session)
        result = deepcopy(report)
        result["data"]["current_blockers"] = _blockers(conn, report["data"])
        result["data"]["amendment"] = _impact(conn, report, result["data"]["current_blockers"])
        result["data"]["can_approve"] = session.role in ("owner", "adviser") and report["data"]["status"] == "draft" and not result["data"]["current_blockers"]
        result["data"]["supported_formats"] = ["pdf", "csv", "json", "xlsx"] if report["data"]["status"] == "issued" else []
        result["data"]["approval_blocked_reason"] = "Approval is recorded for this retained version." if report["data"]["status"] == "issued" else ("Resolve the outstanding report issues." if result["data"]["current_blockers"] else ("Only an owner or adviser can approve." if session.role not in ("owner", "adviser") else None))
        result["data"]["receipts"], result["data"]["reissues"] = _report_history(conn, report)
        return result


@router.get("/reports/{report_id}/review")
def report_review_page(report_id: UUID, section: Literal["fields", "operations", "evidence", "blockers", "changes", "receipts", "reissues"],
                       expected_revision: int = Query(ge=1), snapshot_checksum: str = Query(pattern=r"^[a-f0-9]{64}$"),
                       check_fingerprint: str = Query(pattern=r"^[a-f0-9]{64}$"), offset: int = Query(0, ge=0),
                       limit: int = Query(PAGE_LIMIT, ge=1, le=PAGE_LIMIT), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        report = _get(conn, "reports", report_id)
        if report["revision"] != expected_revision:
            fail("revision_conflict", "The report changed. Reload its review before continuing.", 409)
        if report["data"]["checksum"] != snapshot_checksum:
            fail("snapshot_changed", "The report preview changed. Reload its review before continuing.", 409)
        if section in ("fields", "operations", "evidence"):
            items = report["data"]["snapshot"].get(section, [])
        else:
            current = _review_state(conn, report, session)
            if current["check_fingerprint"] != check_fingerprint:
                fail("review_checks_changed", "The report checks changed. Reload the review before continuing.", 409)
            items = current["sections"][section]
        content = bounded_page(items, section=section, report=report, fingerprint=check_fingerprint, offset=offset, limit=limit)
    return Response(content, media_type="application/json", headers={"Cache-Control": "private, no-store"})


def _approver(session):
    require_roles(session, "owner", "adviser")


def _check_snapshot_binding(report, body):
    if body.snapshot_checksum is not None and body.snapshot_checksum != report["data"].get("checksum"):
        fail("snapshot_changed", "The report preview changed. Review this version before continuing.", 409)


def _farm_lock(conn, session, farm_id):
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm_id}",))


def _approve_in_transaction(conn, report_id, body, session):
    report = _get(conn, "reports", report_id)
    access = conn.execute("SELECT record_access(id,kind,data,true) AS allowed FROM records "
                          "WHERE kind='reports' AND id=%s AND deleted_at IS NULL", (str(report_id),)).fetchone()
    if not access or not access["allowed"]:
        fail("role_required", "This farm's report approval requires review permission.", 403)
    # Every fact creator/reviewer and reconciliation resolver uses this farm lock.
    # Acquire it before row locks, matching the correction transaction lock order.
    _farm_lock(conn, session, report["data"]["farm_id"])
    conn.execute("SELECT id FROM records WHERE id = %s FOR UPDATE", (str(report_id),))
    report = _get(conn, "reports", report_id)
    _check_snapshot_binding(report, body)
    if report["revision"] != body.expected_revision:
        fail("revision_conflict", "The report changed. Refresh it before approving.", 409)
    if report["data"]["status"] == "issued":
        return report
    snapshot = report["data"]["snapshot"]
    source_ids = {report["data"]["farm_id"], *(fact["id"] for fact in _records(conn, "facts", report["data"]["farm_id"])), *(document["id"] for document in snapshot["evidence"])}
    source_ids.update(report["data"].get("validation_sources", {}).get("operations", {}).keys())
    source_ids.update(report["data"].get("validation_sources", {}).get("records", {}).keys())
    source_ids.update(report["data"].get("validation_sources", {}).get("journal_documents", {}).keys())
    if report["data"].get("request_id"):
        source_ids.add(report["data"]["request_id"])
    # Protect farm/request/evidence edits that do not participate in the farm lock.
    # Re-read blockers only after these locks; they remain held through issuance.
    conn.execute("SELECT id FROM records WHERE id = ANY(%s::uuid[]) ORDER BY id FOR SHARE", (sorted(source_ids),)).fetchall()
    blockers = _blockers(conn, report["data"])
    if body.check_fingerprint is not None:
        current = _review_state(conn, report, session, blockers)
        if current["check_fingerprint"] != body.check_fingerprint:
            fail("review_checks_changed", "The report checks changed. Reload and review this version before approving.", 409)
    if blockers:
        fail("approval_blocked", "Review the outstanding report issues before approval.", 409, blockers=blockers)
    data = deepcopy(report["data"])
    data.update(status="issued", blockers=[], approval={"actor_id": str(session.user_id), "role": session.role, "at": now(), "snapshot_checksum": data["checksum"]})
    issued = update_record(conn, "reports", str(report_id), body.expected_revision, data)
    if data.get("request_id"):
        request = _get(conn, "requests", data["request_id"])
        request_data = deepcopy(request["data"])
        request_data.update(status="ready", prepared_report_id=str(report_id))
        update_record(conn, "requests", request["id"], request["revision"], request_data)
    return issued


@router.post("/reports/{report_id}/approve")
def approve_report(report_id: UUID, body: ApproveReport, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"), view: Literal["summary"] | None = None):
    _approver(session)
    with transaction(session) as conn:
        try:
            report = idempotent(conn, idempotency_key, "report-approve:" + str(report_id), _approval_payload(body), lambda: _approve_in_transaction(conn, report_id, body, session))
        except ApiError as error:
            if view == "summary" and error.code == "approval_blocked":
                fail(error.code, error.message, error.status, blocker_count=len(error.details.get("blockers", [])),
                     review_url=f"/reports/{report_id}?view=review")
            raise
        return compact_record(report) if view == "summary" else report


@router.post("/reports/{report_id}/reissue", status_code=201)
def reissue_report(report_id: UUID, body: ReissueReport, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"), view: Literal["summary"] | None = None):
    with transaction(session) as conn:
        def perform():
            old = _get(conn, "reports", report_id)
            _check_snapshot_binding(old, body)
            if old["revision"] != body.expected_revision:
                fail("revision_conflict", "The report changed. Refresh before preparing a correction.", 409)
            data = old["data"]
            manual_pack = data["snapshot"]["pack"].get("journal_schema") == manual_journal.SCHEMA_ID
            manual_selection = body.manual_journal_selection
            if manual_pack:
                if manual_selection is None:
                    retained = next((journal.get("selection") for journal in data["snapshot"].get("journals", [])
                                     if journal.get("schema_id") == manual_journal.SCHEMA_ID), None)
                    if retained is None:
                        fail("pt_journal_selection_required", "Review and explicitly select the source journal revision and rows again.")
                    manual_selection = ManualJournalSelection(**retained)
                elif body.fact_ids is None:
                    fail("pt_journal_selection_required", "Include the explicitly reviewed source journal in fact_ids when changing the selection.")
            selected = body.selected_document_ids if body.selected_document_ids is not None else [item["id"] for item in data["snapshot"]["evidence"]]
            operation_ids = body.operation_ids
            if operation_ids is None:
                farm_operations = _records(conn, "operations", data["farm_id"])
                operation_ids = []
                for item in data["snapshot"].get("operations", []):
                    current, conflict = _current_operation(farm_operations, item["id"])
                    if conflict:
                        fail("operation_correction_conflict", "Resolve the application correction lineage before preparing this amendment.", 409, operation_id=item["id"])
                    operation_ids.append(str(current["id"]) if current else item["id"])
            fact_ids = body.fact_ids
            if manual_pack and fact_ids is None:
                # Unlike ordinary scalar answers, a manual row selection must
                # never silently follow a corrected fact or newer revision.
                fact_ids = [fact["id"] for fact in data["snapshot"]["facts"]]
            if fact_ids is None:
                prior_keys = {(fact["data"].get("key"), literal(fact["data"].get("period")), fact["data"].get("temporal_basis"), _physical_identity(fact["data"])) for fact in data["snapshot"]["facts"]}
                selectors = _field_specs(get_pack(data["pack_id"]))
                current_request = _get(conn, "requests", data["request_id"]) if data.get("request_id") else None
                requirements = [{"key": item} if isinstance(item, str) else item for item in (current_request["data"].get("requirements", []) if current_request else [])]
                selectors.extend(item for item in requirements if isinstance(item, dict) and item.get("type") != "evidence")
                excluded = selected_fact_ids(conn, data["farm_id"])["excluded_fact_ids"]
                fact_ids = [fact["id"] for fact in _records(conn, "facts", data["farm_id"]) if str(fact["id"]) not in excluded and fact["data"].get("review_status") != "rejected" and _same_period(fact, data["reporting_year"]) and (any(_matches_requirement(fact, selector, data["reporting_year"]) for selector in selectors) or (fact["data"].get("key"), literal(fact["data"].get("period")), fact["data"].get("temporal_basis"), _physical_identity(fact["data"])) in prior_keys)]
            create = CreateReport(farm_id=data["farm_id"], request_id=data.get("request_id"), pack_id=data["pack_id"], reporting_year=data["reporting_year"], fact_ids=fact_ids, selected_document_ids=selected, operation_ids=operation_ids, manual_journal_selection=manual_selection)
            return insert_record(conn, "reports", _prepare(conn, create, session, correction_of=str(report_id)))
        report = idempotent(conn, idempotency_key, "report-reissue:" + str(report_id), _approval_payload(body), perform)
        return compact_record(report) if view == "summary" else report


@router.get("/facts/{fact_id}/reports")
def fact_reports(fact_id: UUID, session: Session = Depends(require_session), view: Literal["summary"] | None = None):
    with transaction(session) as conn:
        fact = _get(conn, "facts", fact_id)
        lineage = {str(fact_id)}
        predecessor = fact["data"].get("supersedes_id")
        while predecessor and str(predecessor) not in lineage:
            lineage.add(str(predecessor))
            prior = fetch_record(conn, "facts", str(predecessor))
            predecessor = prior["data"].get("supersedes_id") if prior else None
        if view == "summary":
            records = _summary_records(conn, "kind='reports' AND deleted_at IS NULL AND data->>'farm_id'=%s "
                                       "AND EXISTS (SELECT 1 FROM jsonb_array_elements(data#>'{snapshot,facts}') AS retained_fact(value) "
                                       "WHERE retained_fact.value->>'id'=ANY(%s::text[]))", (fact["data"].get("farm_id"), sorted(lineage)))
        else:
            records = [report for report in _records(conn, "reports", fact["data"].get("farm_id")) if any(value["id"] in lineage for value in report["data"]["snapshot"]["facts"])]
        return {"items": records, "total": len(records), "limit": len(records), "offset": 0}


@router.get("/operations/{operation_id}/reports")
def operation_reports(operation_id: UUID, session: Session = Depends(require_session), view: Literal["summary"] | None = None):
    with transaction(session) as conn:
        operation = _get(conn, "operations", operation_id)
        lineage = {str(operation_id)}
        current = operation
        while current["data"].get("supersedes_id") and str(current["data"]["supersedes_id"]) not in lineage:
            predecessor = str(current["data"]["supersedes_id"])
            prior = _get(conn, "operations", predecessor)
            if prior["data"].get("farm_id") != operation["data"].get("farm_id") or prior["data"].get("type") != operation["data"].get("type"):
                break
            lineage.add(predecessor)
            current = prior
        if view == "summary":
            records = _summary_records(conn, "kind='reports' AND deleted_at IS NULL AND data->>'farm_id'=%s "
                                       "AND (data#>'{validation_sources,operations}') ?| %s::text[]", (operation["data"].get("farm_id"), sorted(lineage)))
        else:
            records = [report for report in _records(conn, "reports", operation["data"].get("farm_id")) if lineage.intersection(report["data"].get("validation_sources", {}).get("operations", {}))]
        return {"items": records, "total": len(records), "limit": len(records), "offset": 0}


@router.get("/sales/{sale_id}/reports")
def sale_reports(sale_id: UUID, session: Session = Depends(require_session), view: Literal["summary"] | None = None):
    with transaction(session) as conn:
        sale = _get(conn, "sales", sale_id)
        if view == "summary":
            records = _summary_records(conn, "kind='reports' AND deleted_at IS NULL AND data->>'farm_id'=%s "
                                       "AND data#>>ARRAY['validation_sources','records',%s,'kind']='sales'", (sale["data"]["farm_id"], str(sale_id)))
        else:
            records = [report for report in _records(conn, "reports", sale["data"]["farm_id"])
                       if report["data"].get("validation_sources", {}).get("records", {}).get(str(sale_id), {}).get("kind") == "sales"]
        return {"items": records, "total": len(records), "limit": len(records), "offset": 0}


@router.post("/reports/{report_id}/receipts", status_code=201)
def record_receipt(report_id: UUID, body: ReceiptInput, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    _approver(session)
    with transaction(session) as conn:
        return idempotent(conn, idempotency_key, "report-receipt:" + str(report_id), _approval_payload(body), lambda: _receipt_in_transaction(conn, report_id, body, session))


def _receipt_in_transaction(conn, report_id, body, session):
    report = _get(conn, "reports", report_id)
    _farm_lock(conn, session, report["data"]["farm_id"])
    _check_snapshot_binding(report, body)
    if not body.reference.strip():
        fail("receipt_reference", "Enter the reference recorded after delivery.")
    if report["revision"] != body.expected_revision:
        fail("revision_conflict", "The report changed. Refresh before recording the receipt.", 409)
    if report["data"]["status"] != "issued":
        fail("report_unapproved", "Approve this report before recording a response reference.", 409)
    receipt = {"report_id": str(report_id), "farm_id": report["data"]["farm_id"], "reference": body.reference, "date": body.date.isoformat(), "recorded_by": str(session.user_id), "recorded_at": now(), "status": "manually_recorded", "authority_acceptance_verified": False, "notice": "User-recorded reference only; no authority filing or acceptance is established."}
    for existing in _records(conn, "report_receipts", report["data"]["farm_id"]):
        if all(existing["data"].get(key) == receipt[key] for key in ("report_id", "reference", "date")):
            return existing
    saved = insert_record(conn, "report_receipts", receipt)
    if report["data"].get("request_id"):
        request = _get(conn, "requests", report["data"]["request_id"])
        request_data = deepcopy(request["data"])
        request_data.update(status="responded", response_status="manually_recorded", response_reference=body.reference, response_date=body.date.isoformat(), authority_acceptance_verified=False)
        update_record(conn, "requests", request["id"], request["revision"], request_data)
    return saved


def render_report_download(report, format, *, require_issued=False):
    data = report["data"]
    if require_issued and data.get("status") != "issued":
        fail("report_unapproved", "Only issued reports can be shared.", 409)
    if digest(data["snapshot"]) != data.get("checksum"):
        fail("snapshot_integrity", "The retained report checksum does not match.", 409)
    if format == "json":
        # Dynamic blockers, sharing grants and receipt actors are not part of this response pack.
        payload = {"report_id": str(report["id"]), "status": data["status"], "checksum": data["checksum"], "snapshot": data["snapshot"], "approval": data.get("approval"), "filing_status": "not_filed"}
        content, media = canonical(payload), "application/json"
    elif format == "csv":
        content, media = csv_bytes(data["snapshot"]), "text/csv; charset=utf-8"
    elif format == "xlsx":
        content, media = xlsx_bytes(data["snapshot"]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    elif format == "pdf":
        try:
            content = pdf_bytes(str(report["id"]), data["snapshot"], data["checksum"], data["status"] == "issued", approval=data.get("approval"))
        except (ImportError, RuntimeError) as error:
            fail("pdf_runtime_unavailable", str(error), 503)
        media = "application/pdf"
    else:
        fail("unsupported_format", "Choose PDF, CSV, JSON or XLSX.")
    return Response(content, media_type=media, headers={"Content-Disposition": f'attachment; filename="farm-report-{report["id"]}.{format}"', "Cache-Control": "private, no-store", "X-Report-Snapshot-SHA256": data["checksum"], "X-Content-Type-Options": "nosniff"})


@router.get("/reports/{report_id}/download")
def download_report(report_id: UUID, format: Literal["pdf", "csv", "json", "xlsx"] = "pdf", session: Session = Depends(require_session)):
    with transaction(session) as conn:
        report = _get(conn, "reports", report_id)
    return render_report_download(report, format, require_issued=True)
