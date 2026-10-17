"""Czech manual PPP record preparation from the retained ÚKZÚZ example.

Pure validation/projection only: no portal, CSV-import or JUDPOR XML contract.
Missing details remain recordable; callers decide when mapped errors block export.
"""

from copy import deepcopy
from datetime import date
from decimal import Decimal, InvalidOperation
import re

from .models import ApiError

SCHEMA_ID = "cz-ppp-journal-v1"
PACK_ID = "cz-ppp-journal-2026"
HOLDER_KEY = "cz.ppp.holder"
SOURCE = {
    "title": "ÚKZÚZ — Evidence přípravků na ochranu rostlin: Příklad formátu vedení záznamů",
    "url": "https://ukzuz.gov.cz/public/portal/ukzuz/pripravky-na-or/formulare-ke-stazeni/ostatni-formulare/evidence-pripravku-na-ochranu-rostlin",
    "attachment_url": "https://ukzuz.gov.cz/public/portal/ukzuz/-a92240---tQH9l1KM/priklad-formatu-vedeni-zaznamu?_linka=a715980",
    "edition": "Published 30 March 2026; internal revision 11; structural reading, pagination unverified",
    "published_at": "2026-03-30",
    "checked_at": "2026-10-17",
    "sha256": "bae53ed12a7b06029b77ceb9dc216d498933d79d6f0f511404bc04ca3a461403",
    "source_type": "official_manual_record_example",
}
NOTICE = "Czech manual record preparation from the named official example. Not JUDPOR XML transmission, authority acceptance or a complete legal certification. Pending follow-up is not complete."

# These labels map the example's headings and its accompanying location prose.
# Internal audit context is separate from source-defined record columns.
COLUMNS = [
    {"key": "cadastral_area", "label": "Katastrální území", "unit": None},
    {"key": "dpb_square", "label": "Čtverec dílu půdního bloku", "unit": None, "conditional": "lpis_land"},
    {"key": "dpb_code", "label": "Zkrácený kód dílu půdního bloku", "unit": None, "conditional": "lpis_land"},
    {"key": "cadastral_parcel_numbers", "label": "Parcelní číslo/a", "unit": None, "conditional": "other_land|object"},
    {"key": "lhc_code", "label": "Kód lesního hospodářského celku (LHC)", "unit": None, "conditional": "forest"},
    {"key": "jprl", "label": "JPRL — oddělení, dílec, porost, porostní skupina", "unit": None, "conditional": "forest"},
    {"key": "object_type", "label": "Druh využití objektu", "unit": None, "conditional": "object"},
    {"key": "object_description", "label": "Označení objektu umožňující přesnou identifikaci a umístění", "unit": None, "conditional": "object"},
    {"key": "crop", "label": "Ošetřovaný druh plodiny, rostlinného produktu nebo jiný předmět aplikace", "unit": None},
    {"key": "sown_area_ha", "label": "Výměra oseté/osázené plochy", "unit": "ha", "decimal_places": 2, "conditional": "land"},
    {"key": "sowing_date", "label": "Datum výsevu/výsadby (D.M.R)", "unit": None, "conditional": "land excluding trees/forest"},
    {"key": "treated_size", "label": "Rozsah ošetření", "unit": None, "unit_field": "treated_unit", "decimal_places": 2},
    {"key": "treated_unit", "label": "Jednotka rozsahu ošetření", "unit": None},
    {"key": "date", "label": "Datum aplikace (D.M.R)", "unit": None},
    {"key": "product", "label": "Úplný název přípravku nebo pomocného prostředku na ochranu rostlin", "unit": None},
    {"key": "dose", "label": "Dávka na jednotku", "unit": None, "unit_field": "dose_unit", "decimal_places": 3},
    {"key": "dose_unit", "label": "Jednotka dávky", "unit": None},
    {"key": "target_organism_or_purpose", "label": "Identifikace škodlivého organismu, účel použití", "unit": None},
    {"key": "mixture", "label": "Údaj o použití ve směsi (S/TM)", "unit": None},
    {"key": "quantity", "label": "Celkové množství aplikovaného přípravku — nepovinný údaj", "unit": None, "unit_field": "unit", "optional": True},
    {"key": "unit", "label": "Jednotka celkového množství", "unit": None, "optional": True},
    {"key": "efficacy", "label": "Výsledek účinnosti opatření (1: účinný, 0: neúčinný)", "unit": None},
    {"key": "crop_end", "label": "Datum ukončení pěstování plodiny (D.M.R)", "unit": None, "conditional": "land excluding trees/forest"},
]
DETAIL_FIELDS = {
    "location_kind", "cadastral_area", "dpb_square", "dpb_code", "cadastral_parcel_numbers",
    "lhc_code", "jprl", "object_type", "object_description", "subject_kind", "sown_area_ha",
    "sowing_date", "crop_end", "target_organism_or_purpose", "mixture", "efficacy", "original_numbers",
}
JPRL_FIELDS = {"oddeleni", "dilec", "porost", "porostni_skupina"}


def _invalid(message, field):
    raise ApiError(422, "cz_ppp_invalid", message, {"field": field})


def _object(value, allowed, field):
    if not isinstance(value, dict) or set(value) - allowed:
        _invalid("Use only the defined Czech journal fields.", field)


def _present(value):
    return value is not None and value != "" and value != [] and value != {}


def _text(value, field, maximum=2000):
    if value is not None and (not isinstance(value, str) or len(value) > maximum):
        _invalid("Keep this supplied identifier or text as text, without inventing a code.", field)


def _actual_date(value, field):
    if not _present(value):
        return
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        _invalid("Use an actual date in YYYY-MM-DD format.", field)
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        _invalid("Enter a real calendar date.", field)
    if parsed > date.today():
        _invalid("Do not supply a future date as an actual observation.", field)


def _decimal(value, field, places=None):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        _invalid("Supply a finite nonnegative number.", field)
    text = str(value).strip()
    if isinstance(value, str) and not re.fullmatch(r"[+\-]?\d+(?:[.,]\d+)?", text):
        _invalid("Use an unambiguous number without thousands separators.", field)
    try:
        number = Decimal(text.replace(",", "."))
        if not number.is_finite() or number < 0 or number > Decimal("1000000000000"):
            raise InvalidOperation
        if places is not None and number != number.quantize(Decimal(1).scaleb(-places)):
            _invalid(f"The source record requires {places} decimal-place precision. Review the original; do not silently round.", field)
    except (InvalidOperation, ValueError):
        _invalid("Supply a finite nonnegative number no larger than one trillion.", field)
    return number


def validate_details(data):
    """Return a deep copy of FULL operation data; missing details are not errors here."""
    if not isinstance(data, dict):
        _invalid("Supply an operation object.", "cz_ppp")
    result = deepcopy(data)
    if result.get("type") != "pesticide_application":
        _invalid("A Czech PPP journal entry must be an actual crop-protection application.", "type")
    for field in ("product", "crop", "dose_unit", "treated_unit", "unit"):
        _text(result.get(field), field)
    _actual_date(result.get("date"), "date")
    for field, places in (("dose", 3), ("treated_size", 2), ("quantity", None)):
        if _present(result.get(field)):
            _decimal(result[field], field, places)
    details = result.get("cz_ppp")
    if details is None:
        return result
    _object(details, DETAIL_FIELDS, "cz_ppp")
    for field in ("cadastral_area", "dpb_square", "dpb_code", "lhc_code", "object_type", "object_description", "target_organism_or_purpose"):
        _text(details.get(field), "cz_ppp." + field)
    for field, choices in (("location_kind", {"lpis_land", "other_land", "forest", "object"}), ("subject_kind", {"crop", "tree", "forest", "other"}), ("mixture", {"S", "TM"})):
        if details.get(field) not in (None, "") and (not isinstance(details[field], str) or details[field] not in choices):
            _invalid("Choose one of the supplied journal options.", "cz_ppp." + field)
    parcels = details.get("cadastral_parcel_numbers")
    if parcels is not None:
        if not isinstance(parcels, list) or len(parcels) > 100:
            _invalid("Supply a list of at most 100 original cadastral parcel identifiers.", "cz_ppp.cadastral_parcel_numbers")
        for value in parcels:
            _text(value, "cz_ppp.cadastral_parcel_numbers", 200)
            if not isinstance(value, str) or not value.strip():
                _invalid("Each supplied parcel identifier must be nonblank text.", "cz_ppp.cadastral_parcel_numbers")
    if details.get("jprl") is not None:
        _object(details["jprl"], JPRL_FIELDS, "cz_ppp.jprl")
        for field, value in details["jprl"].items():
            _text(value, "cz_ppp.jprl." + field, 200)
    location = details.get("location_kind")
    branches = {"lpis_land": {"dpb_square", "dpb_code"}, "other_land": {"cadastral_parcel_numbers"}, "forest": {"lhc_code", "jprl"}, "object": {"cadastral_parcel_numbers", "object_type", "object_description"}}
    if location in branches:
        other_fields = set().union(*branches.values()) - branches[location]
        for field in other_fields:
            if _present(details.get(field)):
                _invalid("This identifier belongs to a different location type. Check the location instead of reinterpreting it.", "cz_ppp." + field)
    _actual_date(details.get("sowing_date"), "cz_ppp.sowing_date")
    exempt = details.get("subject_kind") in {"tree", "forest"}
    if exempt and _present(details.get("sowing_date")):
        _invalid("Sowing/planting date is not recorded for trees or forest stands in this example.", "cz_ppp.sowing_date")
    end = details.get("crop_end")
    if end is not None:
        _object(end, {"status", "date"}, "cz_ppp.crop_end")
        if not isinstance(end.get("status"), str) or end["status"] not in {"pending", "recorded", "not_applicable"}:
            _invalid("Specify pending, recorded or an explicit tree/forest exemption.", "cz_ppp.crop_end.status")
        if end["status"] == "recorded":
            if not _present(end.get("date")):
                _invalid("A recorded crop end needs its actual date.", "cz_ppp.crop_end.date")
            _actual_date(end["date"], "cz_ppp.crop_end.date")
            if exempt:
                _invalid("Trees and forest stands use the explicit crop-end exemption.", "cz_ppp.crop_end.status")
            if details.get("sowing_date") and end["date"] < details["sowing_date"]:
                _invalid("Crop end cannot precede its recorded sowing/planting date.", "cz_ppp.crop_end.date")
        elif _present(end.get("date")):
            _invalid("Pending or not-applicable crop end cannot carry an actual date.", "cz_ppp.crop_end.date")
        if end["status"] == "not_applicable" and not exempt:
            _invalid("The date exemption requires an explicitly recorded tree or forest subject.", "cz_ppp.crop_end.status")
    efficacy = details.get("efficacy")
    if efficacy is not None:
        _object(efficacy, {"status", "value"}, "cz_ppp.efficacy")
        if not isinstance(efficacy.get("status"), str) or efficacy["status"] not in {"pending", "recorded"}:
            _invalid("Record whether efficacy is pending or observed.", "cz_ppp.efficacy.status")
        if efficacy["status"] == "recorded" and (type(efficacy.get("value")) is not int or efficacy["value"] not in (0, 1)):
            _invalid("Observed efficacy is integer 1 (effective) or 0 (ineffective), not a boolean.", "cz_ppp.efficacy.value")
        if efficacy["status"] == "pending" and efficacy.get("value") is not None:
            _invalid("Pending efficacy cannot be represented as zero or another observation.", "cz_ppp.efficacy.value")
    originals = details.get("original_numbers", {})
    _object(originals, {"dose", "treated_size", "sown_area_ha", "quantity"}, "cz_ppp.original_numbers")
    for field, places in (("dose", 3), ("treated_size", 2), ("sown_area_ha", 2), ("quantity", None)):
        value = details.get(field) if field == "sown_area_ha" else result.get(field)
        if _present(value):
            number = _decimal(value, field, places)
            if field in originals:
                if not isinstance(originals[field], str) or not originals[field].strip():
                    _invalid("Retain the original supplied number as nonblank text.", "cz_ppp.original_numbers." + field)
                if _decimal(originals[field], "cz_ppp.original_numbers." + field, places) != number:
                    _invalid("The original numeric text and saved number disagree. Check both without guessing.", "cz_ppp.original_numbers." + field)
        elif field in originals:
            _invalid("An original number needs its corresponding supplied value.", "cz_ppp.original_numbers." + field)
    return result


def validate_holder(value):
    """Validate supplied structured identity, without filling or approving missing data."""
    _object(value, {"kind", "name", "address", "identification_number", "birth_date"}, HOLDER_KEY)
    result = deepcopy(value)
    if result.get("kind") not in (None, "") and (not isinstance(result["kind"], str) or result["kind"] not in {"natural_person", "legal_person"}):
        _invalid("Choose natural person or legal person.", HOLDER_KEY + ".kind")
    for field in ("name", "address"):
        _text(result.get(field), HOLDER_KEY + "." + field)
    identification = result.get("identification_number")
    if identification is not None:
        _object(identification, {"status", "value"}, HOLDER_KEY + ".identification_number")
        if not isinstance(identification.get("status"), str) or identification["status"] not in {"provided", "not_assigned", "unknown"}:
            _invalid("State whether an identification number is supplied, not assigned or unknown.", HOLDER_KEY + ".identification_number.status")
        _text(identification.get("value"), HOLDER_KEY + ".identification_number.value", 200)
        if identification["status"] == "provided" and not (identification.get("value") or "").strip():
            _invalid("A provided identification number needs its original text.", HOLDER_KEY + ".identification_number.value")
        if identification["status"] != "provided" and _present(identification.get("value")):
            _invalid("An unknown or not-assigned identifier cannot carry an invented number.", HOLDER_KEY + ".identification_number.value")
    _actual_date(result.get("birth_date"), HOLDER_KEY + ".birth_date")
    if result.get("kind") == "legal_person" and _present(result.get("birth_date")):
        _invalid("A legal person has no birth-date field.", HOLDER_KEY + ".birth_date")
    return result


def _issue(code, field, message, severity="error"):
    return {"code": code, "severity": severity, "field": field, "message": message}


def _missing(value):
    return not _present(value) or isinstance(value, str) and not value.strip()


def journal_issues(data):
    """Mapped-record completeness, separate from whether a proposal may be saved."""
    checked = validate_details(data)
    details = checked.get("cz_ppp") or {}
    issues = []

    def require(value, field, label):
        if _missing(value):
            issues.append(_issue("cz_ppp_missing_" + field.replace(".", "_"), field, "Record " + label + " from the actual application or original record."))

    for field, label in (("date", "the actual application date"), ("product", "the full product trade name"), ("crop", "the crop, treated product, tree genus or other application subject"), ("dose", "the dose"), ("dose_unit", "the original dose unit"), ("treated_size", "the actual treated scope"), ("treated_unit", "the original treated-scope unit")):
        require(checked.get(field), field, label)
    for field, label in (("location_kind", "the location type"), ("cadastral_area", "the cadastral area"), ("subject_kind", "the subject type"), ("target_organism_or_purpose", "the target organism or other stated purpose"), ("mixture", "whether the application was solo (S) or in a mixture (TM)")):
        require(details.get(field), "cz_ppp." + field, label)
    location = details.get("location_kind")
    fields = {"lpis_land": ("dpb_square", "dpb_code"), "other_land": ("cadastral_parcel_numbers",), "forest": ("lhc_code",), "object": ("cadastral_parcel_numbers", "object_type", "object_description")}.get(location, ())
    for field in fields:
        require(details.get(field), "cz_ppp." + field, field.replace("_", " "))
    if location == "forest":
        for field in sorted(JPRL_FIELDS):
            require((details.get("jprl") or {}).get(field), "cz_ppp.jprl." + field, "the supplied forest " + field)
    land = location in {"lpis_land", "other_land", "forest"}
    exempt = details.get("subject_kind") in {"tree", "forest"}
    if land:
        if _present(checked.get("treated_unit")) and checked["treated_unit"] != "ha":
            issues.append(_issue("cz_ppp_land_treated_unit", "treated_unit", "The source requires land treatment extent in hectares. Check the original value and unit; no conversion has been inferred."))
        require(details.get("sown_area_ha"), "cz_ppp.sown_area_ha", "the sown/planted land area in hectares")
        if not exempt:
            require(details.get("sowing_date"), "cz_ppp.sowing_date", "the actual sowing/planting date")
        end = details.get("crop_end") or {}
        if not end:
            require(None, "cz_ppp.crop_end", "the crop-end status or explicit tree/forest exemption")
        elif exempt and end.get("status") != "not_applicable":
            issues.append(_issue("cz_ppp_crop_end_exemption", "cz_ppp.crop_end", "Record the explicit tree/forest crop-end exemption."))
    if (details.get("crop_end") or {}).get("status") == "pending":
        issues.append(_issue("cz_ppp_pending_crop_end", "cz_ppp.crop_end", "The supplied crop-end follow-up is still pending, not complete. This warning does not make crop-end reporting a requirement for objects.", "warning"))
    efficacy = details.get("efficacy") or {}
    if not efficacy:
        require(None, "cz_ppp.efficacy", "whether efficacy is pending or has been observed")
    elif efficacy.get("status") == "pending":
        issues.append(_issue("cz_ppp_pending_efficacy", "cz_ppp.efficacy", "Efficacy has not been observed yet; pending is not an ineffective result.", "warning"))
    if _present(checked.get("quantity")):
        require(checked.get("unit"), "unit", "the original total-quantity unit")
    originals = details.get("original_numbers") or {}
    for field in ("dose", "treated_size", "sown_area_ha", "quantity"):
        value = details.get(field) if field == "sown_area_ha" else checked.get(field)
        if _present(value):
            require(originals.get(field), "cz_ppp.original_numbers." + field, "the original numeric text for " + field.replace("_", " "))
    return issues


def active_entries(operations):
    """Only a confirmed, same-farm successor excludes its known predecessor.

    Authorization/loading belongs to the caller. An absent predecessor is not
    fetched or guessed. Reject confirmed branches/cycles instead of choosing one.
    """
    records = list(operations)
    by_id = {str(item["id"]): item for item in records}
    if len(by_id) != len(records):
        _invalid("Choose each application only once.", "operation_ids")
    successors = {}
    for item in records:
        data = item["data"]
        previous_id = data.get("supersedes_id")
        if data.get("review_status") != "confirmed" or not previous_id:
            continue
        previous_id = str(previous_id)
        if previous_id not in by_id:
            continue
        previous = by_id[previous_id]["data"]
        if previous.get("farm_id") != data.get("farm_id") or previous.get("type") != data.get("type"):
            _invalid("A correction must identify the same farm and kind of application.", "supersedes_id")
        if previous_id == str(item["id"]) or previous_id in successors:
            _invalid("Resolve this correction cycle or competing confirmed successors.", "supersedes_id")
        successors[previous_id] = str(item["id"])
    for start in successors:
        current, seen = start, set()
        while current in successors:
            if current in seen:
                _invalid("Correction links cannot form a cycle.", "supersedes_id")
            seen.add(current)
            current = successors[current]
    return [item for item in records if str(item["id"]) not in successors]


def holder_issues(value):
    """Return completeness issues for a valid, possibly incomplete holder value."""
    value = validate_holder(value)
    issues = []
    for field in ("kind", "name", "address"):
        if _missing(value.get(field)):
            issues.append(_issue("cz_ppp_holder_missing_" + field, HOLDER_KEY + "." + field, "Supply the holder's " + field + " from their actual legal/business identity."))
    identifier = value.get("identification_number") or {}
    if identifier.get("status") in (None, "unknown"):
        issues.append(_issue("cz_ppp_holder_identifier_unknown", HOLDER_KEY + ".identification_number", "Check whether the holder has an assigned identification number; unknown is not not-assigned."))
    if value.get("kind") == "natural_person" and identifier.get("status") == "not_assigned" and not value.get("birth_date"):
        issues.append(_issue("cz_ppp_holder_birth_date_required", HOLDER_KEY + ".birth_date", "Supply the natural person's actual birth date when no identification number is assigned."))
    return issues


def build_journal(farm, holder, operations, year):
    """Build a pure source-bound snapshot from authorized, explicit selections.

    None holder/zero entries produce draft issues. Supplied selections must be
    confirmed and in scope. Callers must check active membership against the
    whole authorized ledger, not merely against this selected subset.
    """
    if not isinstance(farm, dict) or farm.get("data", {}).get("country") != "CZ":
        _invalid("Choose a Czech farm for this national record example.", "farm_id")
    if type(year) is not int or year != 2026:
        _invalid("This source-backed preparation pack covers 2026 only.", "reporting_year")
    farm_id = str(farm["id"])
    selected = list(operations)
    active = active_entries(selected)
    if len(active) != len(selected):
        _invalid("Select the active reviewed successor, not both versions of an application.", "operation_ids")
    issues, retained_holder, entries = [], None, []
    if holder is None:
        issues.append(_issue("cz_ppp_holder_required", HOLDER_KEY, "Add and confirm the structured holder identity before approving this journal."))
    else:
        value = holder["data"]
        if value.get("farm_id") != farm_id or value.get("key") != HOLDER_KEY or value.get("review_status") != "confirmed" or value.get("temporal_basis") != "static" or value.get("period") not in (None, "") or value.get("unit") is not None:
            _invalid("Select this farm's confirmed static Czech journal holder fact, without a unit.", HOLDER_KEY)
        identity = validate_holder(value.get("value"))
        issues.extend(holder_issues(identity))
        retained_holder = {"fact_id": str(holder["id"]), "fact_revision": holder["revision"], "value": identity, "sources": deepcopy(value.get("sources", []))}
    for operation in selected:
        data = operation["data"]
        if data.get("farm_id") != farm_id or data.get("type") != "pesticide_application" or data.get("review_status") != "confirmed":
            _invalid("Select only this farm's confirmed crop-protection applications.", "operation_ids")
        if not isinstance(data.get("date"), str) or data["date"][:4] != str(year) or data.get("temporal_basis") != "calendar_date" or data.get("period") != data.get("date"):
            _invalid("Each journal application needs its actual date in the selected year, not an annual total.", "operation_ids")
        checked = validate_details(data)
        details = checked.get("cz_ppp") or {}
        values = {}
        for column in COLUMNS:
            key = column["key"]
            value = checked.get(key) if key in {"crop", "treated_size", "treated_unit", "date", "product", "dose", "dose_unit", "quantity", "unit"} else details.get(key)
            if value is not None and "decimal_places" in column:
                value = format(_decimal(value, key, column["decimal_places"]), f".{column['decimal_places']}f")
            values[key] = deepcopy(value)
        entry_issues = journal_issues(checked)
        entries.append({"operation_id": str(operation["id"]), "operation_revision": operation["revision"], "date": checked.get("date"), "values": values, "data": checked, "original_numbers": deepcopy(details.get("original_numbers", {})), "issues": entry_issues})
    entries.sort(key=lambda item: (item["date"], item["operation_id"]))
    if not entries:
        issues.append(_issue("cz_ppp_entry_required", "operation_ids", "Select at least one reviewed application for this preparation journal. This is not a government filing threshold."))
    return {"schema_id": SCHEMA_ID, "pack_id": PACK_ID, "title": "Evidence přípravků na ochranu rostlin — připravené záznamy", "country": "CZ", "reporting_year": year, "source": deepcopy(SOURCE), "columns": deepcopy(COLUMNS), "holder": retained_holder, "entries": entries, "issues": issues, "capability_notice": NOTICE}
