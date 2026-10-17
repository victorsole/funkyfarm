"""Explicit Luxembourg 2026 CSV profiles; original cells are never converted.

The checked pack supplies the column definitions. This module does not infer
authority identifiers, eligible area, crop meaning, dates, units or farm fields.
"""

from copy import deepcopy
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
from pathlib import Path
import re

from .models import ApiError

PACK = Path(__file__).resolve().parents[3] / "packs" / "LU.json"
PROFILE_IDS = {"lu-agriculture-2026", "lu-vineyard-2026", "lu-quota-lu-2026", "lu-quota-foreign-2026"}


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def profiles():
    try:
        if PACK.stat().st_size > 2_000_000:
            raise ValueError("profile size")
        packs = json.loads(PACK.read_text(encoding="utf-8-sig"))
        result = []
        for pack in packs:
            for field in pack.get("fields", []):
                identifier = field.get("import_profile")
                if identifier not in PROFILE_IDS:
                    continue
                columns = field["row_columns"]
                keys = [column["key"] for column in columns]
                if not columns or len(columns) > 256 or len(set(keys)) != len(keys):
                    raise ValueError("profile columns")
                item = {"id": identifier, "country": "LU", "source_year": 2026,
                        "label": field["label"], "fact_key_prefix": field["fact_key_prefix"],
                        "row_columns": columns, "holding_column": field["holding_column"],
                        "identity_columns": field["identity_columns"], "minimum_headers": field["minimum_headers"],
                        "sources": pack.get("sources", []), "pack_id": pack["id"], "pack_version": pack["version"],
                        "notice": "Source rows for human review only; no official filing, quota balance or eligibility has been established."}
                item["definition_hash"] = _digest(item)
                result.append(item)
        if len(result) != 4 or {item["id"] for item in result} != PROFILE_IDS:
            raise ValueError("profile inventory")
        return deepcopy(result)
    except (OSError, ValueError, TypeError, KeyError):
        raise ApiError(503, "import_profiles_unavailable", "The checked Luxembourg CSV profile definitions are unavailable; no column meanings have been guessed.") from None


def profile_for_key(value):
    for profile in profiles():
        if value == profile["id"] or isinstance(value, str) and value.startswith(profile["fact_key_prefix"]):
            return profile
    return None


def _issue(code, message, field=None, severity="error"):
    return {"code": code, "severity": severity, "message": message, **({"field": field} if field else {})}


def validate_headers(profile, headers):
    if len(headers) != len(set(headers)):
        raise ApiError(422, "profile_duplicate_headers", "This profile needs distinct source column headers. No rows were saved.")
    missing = set(profile["minimum_headers"]) - set(headers)
    if missing:
        raise ApiError(422, "profile_headers_required", "The selected profile's holding and identity headers are missing. Select the matching source export.", {"headers": sorted(missing)})


def source_values(imported, row):
    headers = [column["header"] for column in imported["data"]["columns"]]
    return dict(zip(headers, row["data"]["original_row"]))


def row_issues(profile, value, decimal_separator):
    """Pure typed review; every returned source value remains its original text."""
    if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in value.items()):
        return [_issue("profile_raw_strings_required", "Keep every original source column as text in this flat source row.")]
    if decimal_separator not in (".", ","):
        return [_issue("profile_decimal_review_required", "Explicitly review whether this source uses a decimal point or decimal comma.")]
    issues, numbers = [], {}
    expected = {column["key"] for column in profile["row_columns"]}
    missing, extra = expected - value.keys(), value.keys() - expected
    if missing:
        issues.append(_issue("profile_optional_columns_missing", "Some documented optional columns are absent; nothing has been filled in: " + ", ".join(sorted(missing)), severity="warning"))
    if extra:
        issues.append(_issue("profile_unknown_columns", "Additional source columns are retained without an inferred meaning: " + ", ".join(sorted(extra)), severity="warning"))
    for key in [profile["holding_column"], *profile["identity_columns"]]:
        if key not in value or not value[key].strip() or value[key].strip().upper() in {"NULL", "UNKNOWN"}:
            issues.append(_issue("profile_identity_required", "Keep the nonblank holding and complete original source identity. An empty identifier is not a valid parcel or quota identifier.", key))
    for column in profile["row_columns"]:
        key = column["key"]
        if key not in value:
            continue
        raw = value[key]
        if not raw.strip() or raw.strip().upper() in {"NULL", "UNKNOWN"}:
            issues.append(_issue("profile_source_unknown", "This source cell is blank or explicitly unknown. Its original text is retained, not interpreted as zero or null.", key, "warning"))
            continue
        kind = column["type"]
        if kind in ("decimal", "integer"):
            pattern = r"[+-]?[0-9]+" if kind == "integer" else rf"[+-]?(?:[0-9]+(?:{re.escape(decimal_separator)}[0-9]+)?|{re.escape(decimal_separator)}[0-9]+)"
            if len(raw) > 128 or not re.fullmatch(pattern, raw):
                issues.append(_issue("profile_invalid_number", "This cell does not match the explicitly reviewed numeric format. NaN, infinity, mixed or thousands separators are not numeric evidence.", key))
                continue
            try:
                number = Decimal(raw.replace(decimal_separator, "."))
                if not number.is_finite():
                    raise InvalidOperation
                numbers[key] = number
                if number < 0:
                    issues.append(_issue("profile_negative_quantity", "This documented area, size, slope, year or count must not be negative. Keep the original cell and correct the source before relying on it.", key))
                if key == "corg_pourc" and number > 100:
                    issues.append(_issue("profile_percentage_out_of_range", "Organic-carbon composition must be between zero and 100 percent. This is not a maximum for the separate slope column.", key))
            except InvalidOperation:
                issues.append(_issue("profile_invalid_number", "Keep a finite number in the explicitly reviewed source format.", key))
        elif kind == "boolean" and raw not in ("TRUE", "FALSE"):
            issues.append(_issue("profile_invalid_boolean", "This documented boolean column uses the literal source text TRUE or FALSE.", key))
        elif kind == "enum" and raw not in column.get("values", []):
            issues.append(_issue("profile_invalid_code", "This source code is not in this profile's documented values; no replacement code has been inferred.", key))
        if column.get("previous_year"):
            issues.append(_issue("profile_previous_year_crop", "This is the previous-year crop information inside the 2026 export, not an observation of the current crop.", key, "warning"))
        if key == "grubUp":
            issues.append(_issue("profile_grubbing_date_format_unknown", "The source documents a grubbing date but does not establish its serialization. Retain and review the literal value; no ISO date has been invented.", key, "warning"))
        if key == "bio":
            issues.append(_issue("profile_bio_source_only", "The original bio code is source evidence only, not proof of certification, eligibility or compliance.", key, "warning"))
    if profile["id"] == "lu-agriculture-2026" and all(key in numbers for key in ("a_parcel", "a_deposit", "a_eligible")):
        with localcontext() as context:
            context.prec = 300  # Exact subtraction for the bounded 128-character inputs.
            mismatch = numbers["a_parcel"] - numbers["a_deposit"] != numbers["a_eligible"]
        if mismatch:
            issues.append(_issue("profile_area_arithmetic_review", "The supplied parcel area minus deposit does not exactly match the supplied eligible-area column. Review the original figures and source rounding; no tolerance, recalculation or eligibility decision has been assumed.", severity="warning"))
    return issues


def profile_row(imported, row, *, profile=None):
    data = imported["data"]
    profile = profile or profile_for_key(data.get("format_profile"))
    if profile is None:
        raise ApiError(409, "profile_review_required", "Select and review an available source profile before mapping this row.")
    review = data.get("profile_review") or {}
    value = source_values(imported, row)
    holding = value.get(profile["holding_column"], "")
    if profile["identity_columns"]:
        identity = [profile["id"], holding, [value.get(key, "") for key in profile["identity_columns"]]]
    else:
        # Foreign quota CSV has no authority quota ID. This is only source-row
        # identity, never a fabricated authority identifier.
        identity = [profile["id"], data["sha256"], row["data"]["row_number"]]
    reference = " / ".join(value.get(key, "") for key in profile["identity_columns"]) or f"source row {row['data']['row_number']}"
    name = next((value[key] for key in ("field_name", "Name", "name") if value.get(key)), None)
    label = f"{profile['label']} — {name + ' / ' if name else ''}{reference}"[:300]
    proposed = {"farm_id": data["farm_id"], "key": profile["fact_key_prefix"] + _digest(identity), "label": label,
                "value": value, "unit": None, "period": "2026", "temporal_basis": "campaign_year", "review_status": "proposed",
                "sources": [{"kind": "authority_csv_profile", "adapter_profile": profile["id"],
                             "decimal_separator": review.get("decimal_separator"), "source_year": data.get("source_year"),
                             "note": "Original source column strings; no dates, units, areas or current farm fields inferred."}]}
    issues = row_issues(profile, value, review.get("decimal_separator"))
    if len(row["data"]["original_row"]) != len(data["columns"]):
        issues.append(_issue("profile_source_column_mismatch", "Each source row needs exactly the header's number of cells; no extra or missing cell can be silently discarded."))
    if holding != review.get("holding_reference"):
        issues.append(_issue("profile_holding_mismatch", "This source row does not match the holding number explicitly reviewed for the import.", profile["holding_column"]))
    return "facts", proposed, issues
