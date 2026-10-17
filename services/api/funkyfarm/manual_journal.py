"""Pure literal Portuguese surface-record preparation, not legal validation."""

from copy import deepcopy
from datetime import date
import hashlib
import json
import re
from uuid import UUID

from .models import ApiError

SCHEMA_ID = "pt-ppp-surface-v1"
PACK_ID = "pt-ppp-surface-journal"
FACT_KEY = "pt.ppp.surface_journal"
NOTICE = "Manual preparation from the named DGAV source. Check missing details and the recipient's requirements. Not an authority submission, legal compliance decision or verified product authorisation. The report year is app selection metadata, not a printed workbook period."
SOURCE = {
    "title": "DGAV — Modelo para registo de aplicações de produtos fitofarmacêuticos: Tratamento de superfícies",
    "url": "https://www.dgav.pt/wp-content/uploads/2026/09/Modelo-para-registo-de-aplicacoes-de-PF_tratamentos-superficies.xlsx",
    "page_url": "https://www.dgav.pt/medicamentos/conteudo/produtos-fitofarmaceuticos/uso-sustentavel-dos-produtos-fitofarmaceuticos/",
    "edition": "Metadata modified 2026-09-14; no printed version or reporting year.",
    "sha256": "34ebb9d9d933cab566cf2084a6592ade06aa80821e363b7a428969c9f19dd2f3",
    "sheet": "Tratamento de superfícies", "headers": "A4:M4", "entry_slots": "A5:M20", "identity_cell": "A2", "observations_cell": "A21",
}
_DEFINITIONS = [
    ("A", "application_date_time_text", "Data (e hora de início, se aplicável)", None, "Preserve the literal date and optional applicable start time; confirm the actual ISO date separately, without parsing this text."),
    ("B", "location_text", "Localização ", None, "Keep the location exactly supplied; do not infer a parcel or coordinate reference."),
    ("C", "use_crop_oepp_text", "Tipo de utilização/cultura (código OEPP)", None, "Keep crop/use and OEPP text. The workbook's date format in this column is not a crop-date contract."),
    ("D", "bbch_text", "Estado fenológico (BBCH)", None, "Keep stage text, ranges and leading zeros; no code or applicability validation is inferred."),
    ("E", "target_text", "Inimigo ", None, "Keep the supplied target or purpose; no label-use inference."),
    ("F", "treated_area_text", "Área tratada\n(ha ou m2)", ["ha", "m2"], "Keep the actual area and explicit original unit, or leave it visibly unknown; do not assume hectares or convert."),
    ("G", "applicator_number_text", "N.º de aplicador", None, "Keep the applicator identifier as text, including leading zeros."),
    ("H", "product_name_text", "Nome", None, "Product name under the product heading, not the producer or applicator name."),
    ("I", "product_authorisation_text", "Número de autorização", None, "Product-authorisation identifier, not the seller's activity authorisation."),
    ("J", "seller_establishment_text", " Estabelecimento de venda ", None, "Keep the actual selling establishment distinct from producer and applicator."),
    ("K", "seller_activity_authorisation_text", "N.º de autorização de exercício de atividade", None, "Keep the seller activity-authorisation identifier; no identifier grammar is inferred."),
    ("L", "quantity_or_dose_text", "Quant. de produto aplicado (kg ou L) ou dose (kg ou L/ha ou m²)", None, "Preserve the entire amount/dose and unit/basis text. No quantity-versus-dose classification, denominator, conversion or multiplication is inferred."),
    ("M", "mixture_volume_text", "Volume de calda  (L)", "L", "Actual spray-mixture volume in printed L, not product quantity, irrigation or water abstraction."),
]
COLUMNS = [{"column": column, "key": key, "label": label, "source_header": column + "4", "unit": unit, "hint": hint, "source_required": None}
           for column, key, label, unit, hint in _DEFINITIONS]
CELL_KEYS = {column["key"] for column in COLUMNS}
MANUAL_SCHEMA = {"schema_id": SCHEMA_ID, "fact_key": FACT_KEY,
    "identity": {"key": "identity_text", "label": "Nome do produtor/empresa ou entidade autorizada:", "max_chars": 1000},
    "observations": {"key": "observations_text", "label": "Obs.", "max_chars": 8000},
    "columns": deepcopy(COLUMNS), "source": deepcopy(SOURCE),
    "limits": {"max_entries": 256, "cell_max_chars": 2000, "block_size": 16}, "notice": NOTICE}


def _invalid(message, field=None, code="pt_journal_invalid"):
    raise ApiError(422, code, message, {"field": field} if field else None)


def _text(value, maximum, field):
    if value is not None and (not isinstance(value, str) or len(value) > maximum):
        _invalid(f"Keep this value as literal text or null, at most {maximum} characters.", field)
    if isinstance(value, str):
        if any(ord(char) < 32 and char not in "\t\n\r" or 0xD800 <= ord(char) <= 0xDFFF or ord(char) in {0xFFFE, 0xFFFF} for char in value):
            _invalid("This text contains characters that cannot be retained safely in document exports.", field, "pt_journal_invalid_text")
    return value


def validate_value(value):
    """Validate without interpreting, trimming, filling or classifying raw cells."""
    expected = {"schema_id", "identity_text", "observations_text", "entries"}
    if not isinstance(value, dict) or set(value) != expected or value.get("schema_id") != SCHEMA_ID:
        _invalid("Use the exact Portuguese literal journal schema.")
    result = deepcopy(value)
    _text(result["identity_text"], 1000, "identity_text")
    _text(result["observations_text"], 8000, "observations_text")
    if not isinstance(result["entries"], list) or len(result["entries"]) > 256:
        _invalid("Keep at most 256 nonempty source rows in one journal fact.", "entries")
    seen = set()
    for index, entry in enumerate(result["entries"]):
        path = f"entries.{index}"
        if not isinstance(entry, dict) or set(entry) != {"entry_id", "cells", "actual_date", "date_confirmed"}:
            _invalid("Each row needs its stable app ID, exact cells and separate actual-date confirmation.", path)
        try:
            entry["entry_id"] = str(UUID(str(entry["entry_id"])))
        except (ValueError, TypeError):
            _invalid("Use a stable app-generated UUID for this row.", path + ".entry_id")
        if entry["entry_id"] in seen:
            _invalid("Each row must keep its own distinct app ID.", path + ".entry_id")
        seen.add(entry["entry_id"])
        cells = entry["cells"]
        if not isinstance(cells, dict) or set(cells) != CELL_KEYS:
            _invalid("Keep exactly the thirteen source columns; no other event fields are implied.", path + ".cells")
        for key, text in cells.items():
            _text(text, 2000, path + ".cells." + key)
        if not any(isinstance(text, str) and text.strip() for text in cells.values()):
            _invalid("Omit untouched blank placeholder rows. A saved row needs at least one supplied nonblank cell.", path, "pt_journal_empty_row")
        if type(entry["date_confirmed"]) is not bool:
            _invalid("Confirm the separately entered actual date explicitly, not through a text flag.", path + ".date_confirmed")
        actual = entry["actual_date"]
        if actual is not None:
            if not isinstance(actual, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", actual):
                _invalid("Enter an actual ISO date separately; raw column A is never parsed automatically.", path + ".actual_date")
            try:
                date.fromisoformat(actual)
            except ValueError:
                _invalid("Enter a real calendar date separately from the literal column A.", path + ".actual_date")
        if entry["date_confirmed"] and actual is None:
            _invalid("An explicit date confirmation needs its separately supplied actual date.", path + ".actual_date")
    return result


def _reason(entry, year):
    if entry["actual_date"] is None:
        return "date_missing"
    if not entry["date_confirmed"]:
        return "date_unconfirmed"
    actual = date.fromisoformat(entry["actual_date"])
    if actual > date.today():
        return "future_date"
    if actual.year != year:
        return "different_year"
    return "not_selected"


def build_journal(farm, source_fact, entry_ids, year, *, source_fact_revision, acknowledged_unresolved):
    data = source_fact["data"]
    if farm["data"].get("country") != "PT" or data.get("farm_id") != farm["id"] or data.get("key") != FACT_KEY or data.get("temporal_basis") != "static" or data.get("period") is not None or data.get("unit") is not None:
        _invalid("Select this Portuguese farm's static literal journal fact, without a unit or observation period.", code="pt_journal_scope")
    if source_fact["revision"] != source_fact_revision:
        raise ApiError(409, "pt_journal_source_changed", "The source journal changed. Review its exact current revision before selecting rows.")
    if data.get("review_status") != "confirmed" or data.get("superseded_by"):
        _invalid("Confirm the current source journal separately before selecting its rows.", code="pt_journal_source_unreviewed")
    if acknowledged_unresolved is not True:
        _invalid("Explicitly acknowledge the unresolved literal fields and source limitations.", code="pt_journal_acknowledgement_required")
    value = validate_value(data["value"])
    identifiers = [str(identifier) for identifier in entry_ids]
    if not 1 <= len(identifiers) <= 256 or len(set(identifiers)) != len(identifiers):
        _invalid("Select one to 256 distinct row IDs in the exact order you reviewed.", code="pt_journal_selection")
    by_id = {entry["entry_id"]: entry for entry in value["entries"]}
    if any(identifier not in by_id for identifier in identifiers):
        _invalid("Select rows belonging to this exact source journal revision.", code="pt_journal_selection")
    entries = []
    for identifier in identifiers:
        entry = by_id[identifier]
        reason = _reason(entry, year)
        if reason != "not_selected":
            _invalid("This selected row has no confirmed past/current actual date in the report year. Keep its literal text as a draft and review the separate date.", field=identifier, code="pt_journal_" + reason)
        unresolved = [column["key"] for column in COLUMNS if entry["cells"][column["key"]] is None or not entry["cells"][column["key"]].strip()]
        issues = [{"code": "pt_journal_unresolved_cells", "severity": "warning", "message": "Some literal cells remain unknown or blank. This app has not established national mandatoryness.", "fields": unresolved}] if unresolved else []
        entries.append({"entry_id": identifier, "source_fact_id": source_fact["id"], "source_fact_revision": source_fact["revision"],
            "actual_date": entry["actual_date"], "values": deepcopy(entry["cells"]), "issues": issues})
    issues = [{"code": "pt_journal_source_limits", "severity": "warning", "message": "Literal values, codes, units and quantity-versus-dose meaning require human/domain review. No arithmetic, official validation or filing is performed."}]
    if value["identity_text"] is None or not value["identity_text"].strip():
        issues.append({"code": "pt_journal_identity_required", "severity": "error", "message": "Review the producer/company identity before approving this manual preparation."})
    checksum = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    return {"schema_id": SCHEMA_ID, "pack_id": PACK_ID, "title": "Portuguese crop-protection record", "country": "PT", "reporting_year": year,
        "source": deepcopy(SOURCE), "columns": deepcopy(COLUMNS), "holder": {"fact_id": source_fact["id"], "fact_revision": source_fact["revision"], "value": value["identity_text"]},
        "observations_text": value["observations_text"], "entries": entries,
        "excluded_entries": [{"entry_id": entry["entry_id"], "reason": _reason(entry, year), "actual_date": entry["actual_date"]} for entry in value["entries"] if entry["entry_id"] not in set(identifiers)],
        "selection": {"source_fact_id": source_fact["id"], "source_fact_revision": source_fact["revision"], "entry_ids": identifiers, "acknowledged_unresolved": True},
        "source_fact_hash": checksum, "capability_notice": NOTICE, "issues": issues}


def mapped_fields(journal):
    """Scalar paged review items; source context never hides only in an envelope."""
    base = {"journal_schema": SCHEMA_ID, "fact_key": FACT_KEY, "fact_id": journal["holder"]["fact_id"],
        "fact_revision": journal["holder"]["fact_revision"], "unit": None, "period": None, "temporal_basis": "static", "required": False, "sources": []}
    fields = [{**base, "field": "manual.pt.ppp.surface.identity", "label": MANUAL_SCHEMA["identity"]["label"], "value": journal["holder"]["value"], "manual_journal_role": "identity", "required": True},
        {**base, "field": "manual.pt.ppp.surface.observations", "label": MANUAL_SCHEMA["observations"]["label"], "value": journal["observations_text"], "manual_journal_role": "observations"}]
    # Keep the bounded review transport self-contained without adding rows or
    # copying the source's unselected literal cells into recipient metadata.
    fields[0]["journal_context"] = {
        "schema_id": journal["schema_id"],
        "source": {key: deepcopy(journal["source"][key]) for key in ("title", "url", "page_url", "edition", "sha256")},
        "reporting_year": journal["reporting_year"],
        "source_fact_id": journal["holder"]["fact_id"],
        "source_fact_revision": journal["holder"]["fact_revision"],
        "source_fact_hash": journal["source_fact_hash"],
        "selection": {key: deepcopy(journal["selection"][key]) for key in ("entry_ids", "acknowledged_unresolved")},
        "excluded_entries": deepcopy(journal["excluded_entries"]),
        "capability_notice": journal["capability_notice"],
    }
    for position, entry in enumerate(journal["entries"], start=1):
        for column in journal["columns"]:
            fields.append({**base, "field": f"manual.pt.ppp.surface.{entry['entry_id']}.{column['key']}", "label": column["label"],
                "value": entry["values"][column["key"]], "manual_journal_role": "cell", "entry_id": entry["entry_id"], "column": column["column"],
                "actual_date": entry["actual_date"], "group_label": f"Entry {position} — {entry['actual_date']}"})
    return fields
