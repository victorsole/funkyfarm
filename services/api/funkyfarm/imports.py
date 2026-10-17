"""Bounded CSV intake. Original cell strings are evidence, never inferred facts."""

import csv
import hashlib
import io
import json
import math
import re
import tempfile
from datetime import date, datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, json_safe, list_records, transaction, update_record
from .models import ApiError, StrictModel
from .parcel_formats import profiles, profile_for_key, profile_row, validate_headers
from .records import FIELDS, validate_data
from .security import Session, require_roles, require_session

router = APIRouter(tags=["imports"])
MAX_BYTES = 20 * 1024 * 1024
MAX_ROWS = 50_000
MAX_COLUMNS = 256
MAX_WORKSPACE_ROWS = 200_000
MAX_CELL_CHARS = 256_000
MAX_PROFILE_RECORD_BYTES = 512_000


class ColumnMapping(StrictModel):
    source_index: int = Field(ge=0, lt=MAX_COLUMNS)
    target_field: str | None = Field(default=None, max_length=120)
    role: Literal["value", "identifier", "foreign_key"] = "value"
    reference_kind: Literal["farms", "facts", "operations", "purchases", "sales"] | None = None
    value_type: Literal["text", "number", "integer", "json", "date"] = "text"
    decimal_separator: Literal[".", ","] = "."
    date_format: Literal["iso", "dmy", "mdy"] = "iso"
    blank_behavior: Literal["preserve", "null", "missing"] = "preserve"
    null_tokens: list[str] = Field(default_factory=list, max_length=10)


class MappingReview(StrictModel):
    expected_revision: int = Field(ge=1)
    columns: list[ColumnMapping] = Field(max_length=MAX_COLUMNS)
    target: Literal["facts", "purchases", "sales", "operations"] | None = None
    defaults: dict[str, Any] | None = None


class ProfileReview(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    expected_farm_revision: int = Field(ge=1, strict=True)
    holding_reference: str = Field(min_length=1, max_length=500)
    decimal_separator: Literal[".", ","]
    confirm_source: bool = Field(strict=True)


class RowDraft(StrictModel):
    expected_revision: int = Field(ge=1)
    target: Literal["facts", "purchases", "sales", "operations"]
    data: dict[str, Any]


class RowReview(RowDraft):
    note: str = Field(min_length=1, max_length=4000)
    acknowledged_issues: list[str] = Field(default_factory=list, max_length=100)
    preview_token: str | None = Field(default=None, max_length=64)


class BatchRow(StrictModel):
    row_number: int = Field(ge=1)
    expected_revision: int = Field(ge=1)
    preview_token: str = Field(min_length=64, max_length=64)
    acknowledged_issues: list[str] = Field(default_factory=list, max_length=100)


class BatchReview(StrictModel):
    expected_revision: int = Field(ge=1)
    rows: list[BatchRow] = Field(min_length=1, max_length=50)
    note: str = Field(min_length=1, max_length=4000)


def _page_rows(conn, import_id: str, limit: int, offset: int):
    where = "kind='import_rows' AND data->>'import_id'=%s AND deleted_at IS NULL"
    total = conn.execute(f"SELECT count(*) AS count FROM records WHERE {where}", (import_id,)).fetchone()["count"]
    rows = conn.execute(
        f"SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE {where} "
        "ORDER BY (data->>'row_number')::integer LIMIT %s OFFSET %s", (import_id, limit, offset)
    ).fetchall()
    return {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}


def _columns(headers: list[str], mappings: list[ColumnMapping]):
    indices = [item.source_index for item in mappings]
    if len(set(indices)) != len(indices) or any(index >= len(headers) for index in indices):
        raise ApiError(422, "invalid_mapping", "Map each existing source column at most once.")
    by_index = {item.source_index: item for item in mappings}
    fields = [item.target_field for item in mappings if item.target_field]
    if len(fields) != len(set(fields)):
        raise ApiError(422, "duplicate_mapping", "Choose each destination field only once; keep other columns as source evidence.")
    columns = []
    for index, header in enumerate(headers):
        item = by_index.get(index, ColumnMapping(source_index=index))
        if item.role == "foreign_key" and item.reference_kind is None:
            raise ApiError(422, "missing_join_target", "A join column needs its explicitly selected record collection.")
        columns.append({"header": header, **item.model_dump()})
    return columns


def _diagnostics(conn, values, columns, seen_ids, seen_rows):
    fingerprint = hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    result = {"duplicate_row": fingerprint in seen_rows, "duplicate_identifiers": [],
              "missing_identifiers": [], "missing_joins": [], "joins_assessed": False,
              "identifiers_assessed": False}
    seen_rows.add(fingerprint)
    for column in columns:
        index = column["source_index"]
        value = values[index] if index < len(values) else None
        if column["role"] == "identifier":
            result["identifiers_assessed"] = True
            if value in (None, ""):
                result["missing_identifiers"].append(index)
            else:
                key = (index, value)
                if key in seen_ids:
                    result["duplicate_identifiers"].append(index)
                seen_ids.add(key)
        elif column["role"] == "foreign_key":
            result["joins_assessed"] = True
            try:
                if value in (None, ""):
                    raise ApiError(404, "not_found", "Missing join value.")
                fetch_record(conn, column["reference_kind"], value)
            except ApiError as error:
                if error.status != 404:
                    raise
                result["missing_joins"].append({"source_index": index, "value": value,
                                                "reference_kind": column["reference_kind"]})
    return fingerprint, result


def _issue(code, message, field=None, severity="error"):
    return {"code": code, "severity": severity, "message": message, **({"field": field} if field else {})}


def _parse_cell(raw, column):
    """Only an actor's saved mapping can reinterpret a source cell."""
    if raw in column.get("null_tokens", []):
        return None
    if raw == "" and column.get("blank_behavior") == "null":
        return None
    kind = column.get("value_type", "text")
    if kind == "text":
        return raw
    if kind in {"number", "integer"}:
        candidate = raw.strip()
        decimal = column.get("decimal_separator", ".")
        pattern = r"[+-]?\d+" if kind == "integer" else rf"[+-]?(?:\d+(?:{re.escape(decimal)}\d*)?|{re.escape(decimal)}\d+)"
        if not re.fullmatch(pattern, candidate):
            raise ValueError("Choose the source decimal mark; thousands separators and missing values need an explicit correction.")
        candidate = candidate.replace(decimal, ".")
        value = int(candidate) if "." not in candidate else float(candidate)
        if not math.isfinite(value) or abs(value) > 9_007_199_254_740_991:
            raise ValueError("This number cannot be represented safely. Keep identifiers and very large values as text.")
        return value
    if kind == "json":
        def invalid_constant(_):
            raise ValueError("JSON values cannot contain NaN or Infinity.")
        value = json.loads(raw, parse_constant=invalid_constant)
        # The shared web/native JSON contract must not round original identifier digits.
        def safe(item):
            if isinstance(item, (int, float)) and not isinstance(item, bool):
                return math.isfinite(item) and abs(item) <= 9_007_199_254_740_991
            if isinstance(item, list):
                return all(safe(child) for child in item)
            if isinstance(item, dict):
                return all(safe(child) for child in item.values())
            return True
        if not safe(value):
            raise ValueError("The JSON contains an unsafe number. Preserve identifiers as text.")
        return value
    formats = {"iso": "%Y-%m-%d", "dmy": "%d/%m/%Y", "mdy": "%m/%d/%Y"}
    if column.get("date_format", "iso") == "iso":
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            raise ValueError("Use the selected YYYY-MM-DD source format, or choose the actual source date format.")
        return date.fromisoformat(raw).isoformat()
    return datetime.strptime(raw, formats[column["date_format"]]).date().isoformat()


def _mapped_data(imported, original):
    if imported["data"].get("format_profile"):
        return profile_row(imported, original)
    target = imported["data"].get("target", "facts")
    data = dict(imported["data"].get("defaults", {}))
    issues = []
    source = {}
    for column in imported["data"]["columns"]:
        field = column.get("target_field")
        if not field:
            continue
        index = column["source_index"]
        if index >= len(original["data"]["original_row"]):
            issues.append(_issue("missing_source_cell", "This row has no cell for the selected column.", field))
            continue
        raw = original["data"]["original_row"][index]
        if raw == "" and column.get("blank_behavior") == "missing":
            continue
        try:
            value = _parse_cell(raw, column)
        except (ValueError, TypeError, OverflowError, RecursionError) as error:
            issues.append(_issue("invalid_source_value", f"{column['header'] or field}: {error}", field))
            continue
        if column.get("value_type") in {"number", "integer"} and "," in raw and column.get("decimal_separator") == "," and value is not None:
            issues.append(_issue("decimal_comma_conversion", f"The selected decimal-comma format reads {raw!r} as {value}.", field, "warning"))
        if column.get("value_type") == "date" and raw != value and value is not None:
            issues.append(_issue("date_format_conversion", f"The selected date format reads {raw!r} as {value}.", field, "warning"))
        if field.startswith("source."):
            source[field[7:]] = value
        else:
            data[field] = value
    if source:
        if not isinstance(data.get("sources", []), list):
            issues.append(_issue("invalid_sources", "Sources must be a list of structured source references.", "sources"))
        else:
            data["sources"] = [*data.get("sources", []), {"kind": "source_dataset", **source}]
    return target, data, issues


def _sales_date_period(data):
    """A mapped sale date supplies its matching period, never a guessed date."""
    result = dict(data)
    if result.get("date"):
        # Source columns are mapped once. The explicitly selected actual date
        # may therefore fill these structural fields without a duplicate column.
        # Supplied nulls or contradictory periods/bases remain for review.
        result.setdefault("temporal_basis", "calendar_date")
        result.setdefault("period", result["date"])
    return result


def _row_record(conn, import_id, row_number, lock=False):
    row = conn.execute("SELECT id FROM records WHERE kind='import_rows' AND data->>'import_id'=%s "
                       "AND data->>'row_number'=%s AND deleted_at IS NULL" + (" FOR UPDATE" if lock else ""),
                       (import_id, str(row_number))).fetchone()
    if row is None:
        raise ApiError(404, "not_found", "This source row was not found in this workspace.")
    return fetch_record(conn, "import_rows", str(row["id"]))


def _preview_result(conn, imported, original, target, data, mapping_issues=None):
    if imported["data"].get("format_profile"):
        _require_profile_review(conn, imported)
        profile_target, profile_data, profile_issues = profile_row(imported, original)
        if target != profile_target or data != profile_data:
            raise ApiError(422, "profile_mapping_locked", "Keep this profile's exact source row and proposed fact target; re-upload corrected source data instead of silently changing its meaning.")
        mapping_issues = profile_issues
    if target == "sales":
        data = _sales_date_period(data)
    try:
        json.dumps(data, allow_nan=False)
    except (ValueError, TypeError, OverflowError, RecursionError) as error:
        raise ApiError(422, "invalid_import_values", "Use finite numbers and ordinary JSON values for the proposed record.") from error
    issues = list(mapping_issues or [])
    diagnostics = original["data"].get("diagnostics", {})
    for flag, code, message in (
        (diagnostics.get("duplicate_row"), "duplicate_source_row", "An earlier row has the same original cells. Check whether both should be kept."),
        (diagnostics.get("duplicate_identifiers"), "duplicate_source_identifier", "A mapped source reference appears more than once."),
        (diagnostics.get("missing_identifiers"), "missing_source_identifier", "A mapped source reference is missing."),
        (diagnostics.get("missing_joins"), "missing_source_join", "A mapped link does not match an accessible workspace record."),
        (diagnostics.get("column_count_mismatch"), "source_column_mismatch", "This row has a different number of cells from the CSV header."),
        (imported["data"].get("duplicate_source_import_ids"), "duplicate_source_file", "The same source file has already been imported in this workspace."),
    ):
        if flag:
            issues.append(_issue(code, message, severity="warning"))
    required = {"farm_id", "unit", "period", "temporal_basis"}
    required |= {"key", "label", "value"} if target == "facts" else {"title"}
    for field in sorted(required - data.keys()):
        issues.append(_issue("manual_field_required", "Choose this field explicitly. Unknown units and standing-detail periods may be null.", field))
    if "temporal_basis" in data and data["temporal_basis"] not in ("static", "campaign_year", "calendar_date"):
        issues.append(_issue("invalid_temporal_basis", "Choose standing detail, campaign year or exact date explicitly.", "temporal_basis"))
    if data.get("temporal_basis") in ("campaign_year", "calendar_date") and data.get("period") in (None, ""):
        issues.append(_issue("missing_period", "Supply the actual campaign year or date; the upload date is not the reporting period.", "period"))
    if target == "sales" and data.get("temporal_basis") != "calendar_date":
        issues.append(_issue("sale_needs_actual_date", "A sale needs its actual transaction date. Keep annual income summaries separate from individual sales.", "temporal_basis"))
    if target in {"operations", "purchases", "sales"} and data.get("temporal_basis") == "calendar_date":
        if not data.get("date"):
            issues.append(_issue("actual_date_required", "A dated work, purchase or sale record needs its actual source date.", "date"))
        elif data.get("period") != data.get("date"):
            issues.append(_issue("date_period_conflict", "The actual date and calendar-date period must describe the same day.", "period"))
    if target == "operations" and data.get("type") in ("fertiliser_application", "pesticide_application", "input_application", "harvest", "irrigation"):
        if data.get("temporal_basis") != "calendar_date" or not data.get("date"):
            issues.append(_issue("application_is_not_summary", "Actual applications and harvests need a dated source event. Keep an annual total as a campaign-year fact instead.", "temporal_basis"))
    if data.get("review_status") not in (None, "proposed"):
        issues.append(_issue("normal_review_required", "Imported records must enter review as proposals.", "review_status"))
    unit = data.get("unit")
    if isinstance(unit, str) and (unit.strip().lower() in {"mixed", "unknown", "various", "n/a", "not supplied", "unspecified"} or any(mark in unit for mark in ("|", ";"))):
        issues.append(_issue("unresolved_source_unit", "The source unit is unresolved or mixed. Supply the actual unit, or explicitly keep it unknown; no conversion can be assumed.", "unit"))
    normalized = data
    workflow_token = None
    if not issues or all(issue["severity"] != "error" for issue in issues):
        try:
            from .workflows import check_capture
            check = check_capture(conn, target, data, event_required=target == "sales")
            normalized = check["normalized_data"]
            issues.extend(check["issues"])
            workflow_token = check.get("check_token")
            if imported["data"].get("farm_id") not in (None, normalized.get("farm_id")):
                issues.append(_issue("farm_mismatch", "The proposed record belongs to a different farm from this import.", "farm_id"))
        except ApiError as error:
            issues.append(_issue(error.code, error.message, error.details.get("field")))
    if original["data"].get("promoted_record"):
        issues.append(_issue("row_already_promoted", "This source row already has a proposed record."))
    payload = {"import_revision": imported["revision"], "row_id": original["id"], "row_revision": original["revision"],
               "target": target, "data": normalized, "issues": issues, "workflow_token": workflow_token}
    token = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
    return {"row": original, "target": target, "data": data, "normalized_data": normalized,
            "issues": issues, "can_save": not any(issue["severity"] == "error" for issue in issues),
            "requires_acknowledgement": sorted({issue["code"] for issue in issues if issue["severity"] == "warning"}),
            "preview_token": token}


def _import_source(imported, original):
    return {"kind": "import", "import_id": imported["id"], "row_id": original["id"],
            "row_number": original["data"]["row_number"], "source_name": imported["data"]["source_name"],
            "sha256": imported["data"]["sha256"], "grain": imported["data"]["grain"]}


def _check_profile_row_size(imported, values, row_number, profile, stored_row):
    # The eventual source-row UUID has the same 36-character serialized size.
    # An unreviewed decimal separator is null (one byte larger than "."/",").
    temporary = {"id": "00000000-0000-0000-0000-000000000000",
                 "data": {"original_row": values, "row_number": row_number}}
    _, proposed, _ = profile_row(imported, temporary, profile=profile)
    raw_bytes = len(json.dumps(proposed["value"], ensure_ascii=False, allow_nan=False).encode("utf-8"))
    stored_bytes = len(json.dumps(stored_row, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    proposed["sources"].append(_import_source(imported, temporary))
    # Match validate_data's actual serialization, including Unicode escaping,
    # every metadata field and the trusted source linkage used by promotion.
    promoted_bytes = len(json.dumps(proposed, allow_nan=False).encode("utf-8"))
    if max(raw_bytes, stored_bytes, promoted_bytes) > MAX_PROFILE_RECORD_BYTES:
        raise ApiError(422, "profile_row_too_large", "This source row cannot fit in a complete proposed fact with its provenance. Use a smaller source row; no imports or rows were saved and nothing was truncated.",
                       {"row": row_number, "limit": MAX_PROFILE_RECORD_BYTES, "raw_value_bytes": raw_bytes,
                        "stored_row_bytes": stored_bytes, "promoted_fact_bytes": promoted_bytes})


def _save_review(conn, imported, original, body, actor_id, mapping_issues=None):
    if imported["data"].get("format_profile"):
        conn.execute("SELECT id FROM records WHERE id=%s AND kind='imports' FOR SHARE", (imported["id"],))
        imported = fetch_record(conn, "imports", imported["id"])
    if original["revision"] != body.expected_revision:
        raise ApiError(409, "revision_conflict", "The row changed. Review it again before saving it.",
                       {"current_revision": original["revision"]})
    if original["data"].get("promoted_record"):
        raise ApiError(409, "row_already_promoted", "This row already has a proposed record. Review that record.", original["data"]["promoted_record"])
    if not body.note.strip():
        raise ApiError(422, "review_note_required", "Record what you checked in these source rows.")
    if body.data.get("farm_id"):
        farm = fetch_record(conn, "farms", body.data["farm_id"])
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':reconciliation:'||%s,0))", (farm["id"],))
    preview = _preview_result(conn, imported, original, body.target, body.data, mapping_issues)
    if (body.preview_token and body.preview_token != preview["preview_token"]) or (preview["requires_acknowledgement"] and not body.preview_token):
        raise ApiError(409, "preview_changed", "The mapping or comparison records changed. Preview this row again.")
    if not preview["can_save"]:
        raise ApiError(422, "import_row_needs_attention", "Correct the highlighted fields before saving this proposed record.", {"issues": preview["issues"]})
    missing_ack = set(preview["requires_acknowledgement"]) - set(body.acknowledged_issues)
    if missing_ack:
        raise ApiError(422, "review_warnings_required", "Review and acknowledge the warnings before saving this proposed record.",
                       {"issues": preview["issues"], "requires_acknowledgement": sorted(missing_ack)})
    data = dict(preview["normalized_data"])
    source = _import_source(imported, original)
    data.update({"sources": [*data.get("sources", []), source], "review_status": "proposed"})
    data = validate_data(conn, body.target, data)
    promoted = insert_record(conn, body.target, data)
    reviewed = update_record(conn, "import_rows", original["id"], body.expected_revision, {
        **original["data"], "review_status": "promoted", "reviewed_by": str(actor_id),
        "review_note": body.note, "acknowledged_issues": body.acknowledged_issues,
        "promoted_record": {"kind": body.target, "id": promoted["id"]},
    })
    return {"row": reviewed, "record": promoted}


@router.get("/imports")
def imports_list(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                 session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return list_records(conn, "imports", limit, offset)


@router.get("/imports/profiles")
def import_profiles(session: Session = Depends(require_session)):
    items = profiles()
    return {"items": items, "total": len(items), "limit": len(items), "offset": 0}


def _require_profile_review(conn, imported):
    data = imported["data"]
    profile = profile_for_key(data["format_profile"])
    review = data.get("profile_review") or {}
    farm = fetch_record(conn, "farms", data["farm_id"])
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='farms' FOR SHARE", (farm["id"],))
    farm = fetch_record(conn, "farms", farm["id"])
    if (profile is None or farm["data"].get("country") != "LU" or data.get("source_year") != 2026
            or review.get("profile_id") != data["format_profile"] or review.get("confirmed_source") is not True
            or review.get("definition_hash") != profile["definition_hash"]
            or review.get("source_year") != data.get("source_year")
            or review.get("farm_revision") != farm["revision"]
            or review.get("holding_reference") != data.get("holding_reference")
            or not str(review.get("holding_reference", "")).strip()):
        raise ApiError(409, "profile_review_required", "Confirm this source profile, holding number, source year and current farm revision before reviewing source rows.", {"farm_revision": farm["revision"]})
    return profile, farm


def _profile_delimiter(text, profile, selected):
    if selected != "auto":
        if selected not in (",", ";", "\t"):
            raise ApiError(422, "invalid_delimiter", "Choose comma, semicolon, tab, or an unambiguous profile header match.")
        return selected
    if profile is None:
        raise ApiError(422, "profile_required_for_auto", "Automatic delimiter detection requires an explicitly selected source profile.")
    matches = []
    for candidate in (",", ";", "\t"):
        text.seek(0)
        try:
            headers = next(csv.reader(text, delimiter=candidate, strict=True), [])
        except csv.Error:
            continue
        if headers and len(headers) <= MAX_COLUMNS and set(profile["minimum_headers"]).issubset(headers):
            matches.append(candidate)
    text.seek(0)
    if len(matches) != 1:
        raise ApiError(422, "profile_delimiter_ambiguous", "The source headers do not uniquely identify comma, semicolon or tab. Choose the delimiter explicitly; no source format was guessed.")
    return matches[0]


@router.post("/imports", status_code=201)
def upload_import(file: UploadFile = File(...), grain: str = Form(..., min_length=1, max_length=200),
                        farm_id: str | None = Form(None), mapping: str | None = Form(None),
                        format_profile: str | None = Form(None), source_year: int | None = Form(None),
                        delimiter: str = Form(","),
                        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
                        session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser", "worker")
    if not grain.strip():
        raise ApiError(422, "missing_grain", "Describe what one source row represents.")
    profile = profile_for_key(format_profile) if format_profile else None
    if format_profile and (profile is None or profile["id"] != format_profile):
        raise ApiError(422, "invalid_import_profile", "Choose one of the four documented Luxembourg 2026 source profiles.")
    if profile and (source_year != 2026 or not farm_id or mapping is not None):
        raise ApiError(422, "profile_source_required", "This profile requires a Luxembourg farm, explicit source year 2026 and no generic column mapping.")
    try:
        mappings = [ColumnMapping.model_validate(item) for item in json.loads(mapping)] if mapping else []
    except (ValueError, TypeError) as error:
        raise ApiError(422, "invalid_mapping", "Supply a JSON list of explicit source-column mappings.") from error
    digest = hashlib.sha256()
    size = 0
    with tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b") as source:
        try:
            while chunk := file.file.read(64 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ApiError(413, "import_too_large", "CSV imports may contain at most 20 MiB.")
                if b"\x00" in chunk:
                    raise ApiError(422, "invalid_csv", "A text CSV cannot contain NUL bytes.")
                digest.update(chunk)
                source.write(chunk)
        finally:
            file.file.close()
        if size == 0:
            raise ApiError(422, "empty_import", "Choose a CSV file with a header and at least one data row.")
        source.seek(0)
        text = io.TextIOWrapper(source, encoding="utf-8-sig", newline="")
        try:
            # csv.field_size_limit is process-global; keep it fixed, never derived from client input.
            csv.field_size_limit(MAX_CELL_CHARS)
            selected_delimiter = _profile_delimiter(text, profile, delimiter)
            reader = csv.reader(text, delimiter=selected_delimiter, strict=True)
            headers = next(reader, None)
            if not headers or len(headers) > MAX_COLUMNS:
                raise ApiError(422, "invalid_columns", "Use a CSV header with between 1 and 256 columns.")
            if profile:
                validate_headers(profile, headers)
            columns = _columns(headers, mappings)
            with transaction(session) as conn:
                acquired = conn.execute("SELECT pg_try_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':imports',0)) AS acquired").fetchone()["acquired"]
                if not acquired:
                    raise ApiError(429, "import_busy", "Another import in this workspace is running. Retry after it finishes.")
                if farm_id:
                    farm = fetch_record(conn, "farms", farm_id)
                    farm_id = farm["id"]
                    if profile and farm["data"].get("country") != "LU":
                        raise ApiError(422, "profile_country_mismatch", "These Luxembourg source profiles require an explicitly selected Luxembourg farm.")

                def save():
                    stored_count = conn.execute("SELECT count(*) AS count FROM records WHERE kind='import_rows' AND deleted_at IS NULL").fetchone()["count"]
                    duplicate_sources = conn.execute("SELECT id FROM records WHERE kind='imports' AND data->>'sha256'=%s "
                                                     "AND deleted_at IS NULL ORDER BY created_at LIMIT 20", (digest.hexdigest(),)).fetchall()
                    record = insert_record(conn, "imports", {
                        "source_name": (file.filename or "upload.csv")[:255], "sha256": digest.hexdigest(),
                        "source_bytes": size, "grain": grain, "farm_id": farm_id, "columns": columns,
                        "encoding": "UTF-8", "delimiter": selected_delimiter, "row_count": 0,
                        "unit": None, "period": None, "temporal_basis": None,
                        "null_semantics": "All source cells remain strings. Blank, NULL and zero are distinct original values.",
                        "review_status": "preview", "created_by": str(session.user_id),
                        "duplicate_source_import_ids": [str(item["id"]) for item in duplicate_sources],
                        **({"format_profile": profile["id"], "profile_definition_hash": profile["definition_hash"],
                            "source_year": source_year, "holding_reference": None, "profile_review": None} if profile else {}),
                    })
                    seen_ids, seen_rows = set(), set()
                    holding_numbers, profile_ids = set(), set()
                    count = 0
                    for count, values in enumerate(reader, 1):
                        if count > MAX_ROWS or stored_count + count > MAX_WORKSPACE_ROWS:
                            raise ApiError(413, "import_row_limit", "The file or workspace import row allowance has been reached.",
                                           {"file_limit": MAX_ROWS, "workspace_limit": MAX_WORKSPACE_ROWS})
                        if len(values) > MAX_COLUMNS:
                            raise ApiError(422, "too_many_cells", "A source row exceeds the column limit.", {"row": count})
                        if profile:
                            raw = dict(zip(headers, values))
                            holding = raw.get(profile["holding_column"], "")
                            if holding.strip():
                                holding_numbers.add(holding)
                            if len(holding_numbers) > 1:
                                raise ApiError(422, "profile_mixed_holdings", "This source contains more than one nonblank holding number. Separate holdings before importing; no rows were saved.")
                            identity = tuple(raw.get(key, "") for key in profile["identity_columns"])
                            if identity and all(part.strip() and part.strip().upper() not in {"NULL", "UNKNOWN"} for part in identity):
                                if identity in profile_ids:
                                    raise ApiError(422, "profile_duplicate_identity", "This source repeats a complete parcel or quota identity. Review the original export; no rows were saved.", {"row": count})
                                profile_ids.add(identity)
                        fingerprint, diagnostics = _diagnostics(conn, values, columns, seen_ids, seen_rows)
                        diagnostics["column_count_mismatch"] = len(values) != len(headers)
                        row_data = {
                            "import_id": record["id"], "farm_id": farm_id, "row_number": count,
                            "source_line_end": reader.line_num, "original_row": values,
                            "row_sha256": fingerprint, "source_sha256": digest.hexdigest(),
                            "source_name": record["data"]["source_name"], "grain": grain,
                            "unit": None, "period": None, "temporal_basis": None,
                            "diagnostics": diagnostics, "review_status": "unreviewed", "promoted_record": None,
                        }
                        if profile:
                            _check_profile_row_size(record, values, count, profile, row_data)
                        insert_record(conn, "import_rows", row_data)
                    if count == 0:
                        raise ApiError(422, "empty_import", "The CSV contains a header but no source rows.")
                    data = {**record["data"], "row_count": count,
                            **({"holding_reference": next(iter(holding_numbers)) if len(holding_numbers) == 1 else None} if profile else {})}
                    return update_record(conn, "imports", record["id"], record["revision"], data)

                return idempotent(conn, idempotency_key, "imports", {
                    "sha256": digest.hexdigest(), "grain": grain, "farm_id": farm_id, "columns": columns,
                    **({"delimiter": selected_delimiter} if selected_delimiter != "," else {}),
                    **({"format_profile": format_profile, "source_year": source_year,
                        "profile_definition_hash": profile["definition_hash"]} if profile else {}),
                }, save)
        except (UnicodeDecodeError, csv.Error) as error:
            raise ApiError(422, "invalid_csv", "Use a valid comma-separated UTF-8 CSV. No rows were saved.") from error
        finally:
            text.detach()


@router.post("/imports/{import_id}/profile-review")
def review_profile(import_id: str, body: ProfileReview, session: Session = Depends(require_session),
                   idempotency_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        def perform():
            imported = fetch_record(conn, "imports", import_id)
            conn.execute("SELECT id FROM records WHERE id=%s AND kind='imports' FOR UPDATE", (imported["id"],))
            imported = fetch_record(conn, "imports", import_id)
            data = imported["data"]
            if imported["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "This source import changed. Review its current profile details.")
            if not data.get("format_profile"):
                raise ApiError(422, "profile_import_required", "This source has no selected authority CSV profile; use its existing generic mapping review.")
            profile = profile_for_key(data["format_profile"])
            farm = fetch_record(conn, "farms", data["farm_id"])
            conn.execute("SELECT id FROM records WHERE id=%s AND kind='farms' FOR SHARE", (farm["id"],))
            farm = fetch_record(conn, "farms", farm["id"])
            if farm["revision"] != body.expected_farm_revision:
                raise ApiError(409, "revision_conflict", "The farm changed. Review the current farm before confirming this source.", {"farm_revision": farm["revision"]})
            if profile is None or farm["data"].get("country") != "LU" or data.get("source_year") != 2026:
                raise ApiError(422, "profile_source_required", "Confirm a Luxembourg farm and the explicit 2026 source export; the upload date does not establish its year.")
            if (body.confirm_source is not True or not body.holding_reference.strip()
                    or body.holding_reference.strip().upper() in {"NULL", "UNKNOWN"}):
                raise ApiError(422, "profile_source_confirmation_required", "Explicitly confirm the selected source and its nonblank holding number.")
            holding_index = next(column["source_index"] for column in data["columns"] if column["header"] == profile["holding_column"])
            holdings = set()
            with conn.cursor(name="profile_source_holdings") as cursor:
                cursor.execute("SELECT data FROM records WHERE kind='import_rows' AND data->>'import_id'=%s "
                               "AND deleted_at IS NULL ORDER BY (data->>'row_number')::integer", (imported["id"],))
                for source in cursor:
                    values = source["data"]["original_row"]
                    value = values[holding_index] if holding_index < len(values) else ""
                    if value.strip():
                        holdings.add(value)
                    if len(holdings) > 1:
                        break
            if holdings != {body.holding_reference} or data.get("holding_reference") != body.holding_reference:
                raise ApiError(422, "profile_holding_mismatch", "Confirm exactly the single nonblank holding number present in the original source rows.")
            review = {"profile_id": profile["id"], "definition_hash": profile["definition_hash"],
                      "source_year": 2026, "farm_revision": farm["revision"], "holding_reference": body.holding_reference,
                      "decimal_separator": body.decimal_separator, "confirmed_source": True,
                      "reviewed_by": str(session.user_id), "reviewed_at": datetime.now(timezone.utc).isoformat()}
            return update_record(conn, "imports", imported["id"], body.expected_revision,
                                 {**data, "profile_definition_hash": profile["definition_hash"], "profile_review": review})
        return idempotent(conn, idempotency_key, f"import-profile-review:{import_id}:{session.user_id}", body.model_dump(), perform)


@router.get("/imports/{import_id}")
def import_detail(import_id: str, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                  session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "imports", import_id)
        return {**record, "rows": _page_rows(conn, record["id"], limit, offset)}


@router.get("/imports/{import_id}/rows")
def import_rows(import_id: str, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "imports", import_id)
        return _page_rows(conn, record["id"], limit, offset)


@router.post("/imports/{import_id}/mapping")
def review_mapping(import_id: str, body: MappingReview, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        record = fetch_record(conn, "imports", import_id)
        if record["data"].get("format_profile"):
            raise ApiError(422, "profile_mapping_locked", "This import's selected source profile is fixed. Use its profile review, or upload a different source with the correct profile.")
        columns = _columns([column["header"] for column in record["data"]["columns"]], body.columns)
        target = body.target or record["data"].get("target", "facts")
        defaults = body.defaults if body.defaults is not None else record["data"].get("defaults", {})
        invalid = set(defaults) - (FIELDS[target] - {"review_status", "supersedes_id"})
        invalid |= {column["target_field"] for column in columns if column["target_field"] and
                    column["target_field"] not in FIELDS[target] and not column["target_field"].startswith("source.")}
        if invalid:
            raise ApiError(422, "invalid_mapping_field", "Choose a field supported by the selected record type.", {"fields": sorted(invalid)})
        if "sources" in defaults and (not isinstance(defaults["sources"], list) or any(not isinstance(item, dict) for item in defaults["sources"])):
            raise ApiError(422, "invalid_sources", "Default sources must be a list of structured source references.")
        try:
            defaults_size = len(json.dumps(defaults, allow_nan=False).encode())
        except (ValueError, TypeError, RecursionError) as error:
            raise ApiError(422, "invalid_mapping_values", "Shared mapping values must use finite numbers and ordinary JSON values.") from error
        if defaults_size > 128_000:
            raise ApiError(422, "mapping_too_large", "Use a smaller set of shared values for this import.")
        # Preserve source rows; diagnostic assessment is explicit and repeatable against this mapping.
        updated = update_record(conn, "imports", record["id"], body.expected_revision,
                                {**record["data"], "columns": columns, "target": target, "defaults": defaults,
                                 "mapping_reviewed_by": str(session.user_id)})
        seen_ids, seen_rows = set(), set()
        with conn.cursor(name="import_mapping_rows") as cursor:
            cursor.execute("SELECT id,revision,data FROM records WHERE kind='import_rows' AND data->>'import_id'=%s "
                           "AND deleted_at IS NULL ORDER BY (data->>'row_number')::integer", (record["id"],))
            for row in cursor:
                _, diagnostics = _diagnostics(conn, row["data"]["original_row"], columns, seen_ids, seen_rows)
                diagnostics["column_count_mismatch"] = len(row["data"]["original_row"]) != len(columns)
                update_record(conn, "import_rows", str(row["id"]), row["revision"],
                              {**row["data"], "diagnostics": diagnostics})
        return updated


@router.get("/imports/{import_id}/preview")
def mapping_preview(import_id: str, limit: int = Query(20, ge=1, le=50), offset: int = Query(0, ge=0),
                    session: Session = Depends(require_session)):
    with transaction(session) as conn:
        imported = fetch_record(conn, "imports", import_id)
        page = _page_rows(conn, imported["id"], limit, offset)
        return {**page, "items": [_preview_result(conn, imported, row, *_mapped_data(imported, row))
                                  for row in page["items"]], "import_revision": imported["revision"]}


@router.post("/imports/{import_id}/rows/{row_number}/preview")
def manual_preview(import_id: str, row_number: int, body: RowDraft, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        imported = fetch_record(conn, "imports", import_id)
        original = _row_record(conn, imported["id"], row_number)
        if original["revision"] != body.expected_revision:
            raise ApiError(409, "revision_conflict", "The source row changed. Load it again before reviewing it.")
        return _preview_result(conn, imported, original, body.target, body.data)


@router.post("/imports/{import_id}/rows/review")
def review_rows(import_id: str, body: BatchReview, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    if len({row.row_number for row in body.rows}) != len(body.rows):
        raise ApiError(422, "duplicate_selection", "Select each source row only once.")
    with transaction(session) as conn:
        imported = fetch_record(conn, "imports", import_id)
        # Mapping changes and a review batch cannot pass each other unnoticed.
        conn.execute("SELECT id FROM records WHERE id=%s AND kind='imports' FOR SHARE", (imported["id"],))
        imported = fetch_record(conn, "imports", import_id)
        if imported["revision"] != body.expected_revision:
            raise ApiError(409, "revision_conflict", "The column choices changed. Preview the source rows again.")
        results = []
        for selected in body.rows:
            try:
                with conn.transaction():
                    original = _row_record(conn, imported["id"], selected.row_number, lock=True)
                    target, data, issues = _mapped_data(imported, original)
                    review = RowReview(expected_revision=selected.expected_revision, target=target, data=data,
                                       note=body.note, acknowledged_issues=selected.acknowledged_issues,
                                       preview_token=selected.preview_token)
                    saved = _save_review(conn, imported, original, review, session.user_id, issues)
                results.append({"row_number": selected.row_number, "status": "saved", **saved})
            except ApiError as error:
                results.append({"row_number": selected.row_number, "status": "failed",
                                "error": {"code": error.code, "message": error.message, "details": error.details}})
        saved_count = sum(item["status"] == "saved" for item in results)
        return {"items": results, "saved_count": saved_count, "failed_count": len(results) - saved_count}


@router.post("/imports/{import_id}/rows/{row_number}/review", status_code=201)
def review_row(import_id: str, row_number: int, body: RowReview, session: Session = Depends(require_session)):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        imported = fetch_record(conn, "imports", import_id)
        original = _row_record(conn, imported["id"], row_number, lock=True)
        return _save_review(conn, imported, original, body, session.user_id)
