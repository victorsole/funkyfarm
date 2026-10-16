"""Bounded, user-supplied historical IACS subsets for the field reference review.

No country archive, GeoParquet engine, identity linkage or authority write is used.
"""

import csv
import hashlib
import io
import json
import math
import re
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, transaction
from .fields import validate_geometry
from .models import ApiError, StrictModel
from .security import Session, require_roles, require_session

router = APIRouter(prefix="/reference-data/iacs", tags=["historical field references"])
DATASET_ID = "europe-land-iacs-v1.3"
RECORD_URL = "https://zenodo.org/records/18670815"
DOCUMENTATION_URL = RECORD_URL + "/files/_Documentation_v1.3.zip?download=1"
DOC_MD5 = "7c04b61c22f4d602006a6107b446a08e"
DOC_SHA256 = "19d5c8f1d105cc154c79aa1a4b06c345ec55328a6daa0e70f8d87673acbf99f7"
MANDATORY = ("field_id", "crop_code", "crop_name", "EC_trans_n", "EC_hcat_n", "EC_hcat_c", "field_size")
OPTIONAL = ("farm_id", "organic", "crop_area")
MAX_BYTES, MAX_ROWS = 512_000, 50
REGION_NAMES = {
    "BE_FLA": {"BE_FLA", "Vlaanderen", "Flanders"}, "BE_WAL": {"BE_WAL", "Wallonie", "Wallonia"},
    "DE_BWB": {"DE_BWB", "DE-BW", "Baden-Württemberg", "Baden-Wuerttemberg"},
    "DE_BRB": {"DE_BRB", "DE-BB", "Brandenburg"}, "DE_LSA": {"DE_LSA", "DE-NI", "Niedersachsen", "Lower Saxony"},
    "DE_NRW": {"DE_NRW", "DE-NW", "NRW", "Nordrhein-Westfalen", "North Rhine-Westphalia"},
    "IT_TOS": {"IT_TOS", "Toscana", "Tuscany"}, "ES_CAT": {"ES_CAT", "Catalunya", "Catalonia", "Cataluña"},
}
WARNINGS = [
    "Historical reference only: not ownership, current land use, eligible area, an official LPIS correction or a submitted claim.",
    "Upstream crop translations/mappings are LLM-assisted and require review. They are not verified legal crop classifications.",
    "A reference parcel may contain several crops. The vector can retain only its largest crop; supplementary crop tables may be required. Field size is not necessarily crop area.",
    "Upstream field IDs may have been generated or modified. Applicant IDs are jurisdiction-specific subsidy identifiers, not private ownership or a cross-year farm identity.",
    "The inventory covers 20 EU states with partial regional/year coverage, not all 27. No archive was downloaded by this preview.",
]

# Documentation v1.3 country fact sheets, not a guarantee that every intervening
# year or all territory occurs in the public release. The supplied subset still
# requires its exact country/region/year and rights basis to be checked by a user.
COVERAGE = [
    {"country": "AT", "region": None, "name": "Austria", "first_year": 2015, "last_year": 2025, "rights": "CC BY AT 4.0; source attribution required"},
    {"country": "BE", "region": "BE_FLA", "name": "Flanders", "first_year": 2008, "last_year": 2025, "rights": "Flemish free-reuse model licence; attribution required"},
    {"country": "BE", "region": "BE_WAL", "name": "Wallonia", "first_year": 2015, "last_year": 2024, "rights": "CC BY 4.0; verify actual release file because documentation contains differing coverage summaries"},
    {"country": "BG", "region": None, "name": "Bulgaria", "first_year": 2014, "last_year": 2025, "rights": "CC BY 4.0"},
    {"country": "HR", "region": None, "name": "Croatia", "first_year": 2011, "last_year": 2023, "rights": "ARKOD public spatial-data terms; verify intended reuse", "limits": "LPIS reference parcels, not GSA crop declaration boundaries"},
    {"country": "CZ", "region": None, "name": "Czechia", "first_year": 2019, "last_year": 2025, "rights": "MZe accessibility/reuse terms require review", "limits": "Multiple crops can share a block; some source joins were incomplete. Organic coding is preliminary AI-assisted and explicitly unverified upstream."},
    {"country": "DK", "region": None, "name": "Denmark", "first_year": 2010, "last_year": 2025, "rights": "CC0 1.0", "limits": "Some organic/conversion distinctions were unavailable, especially 2024."},
    {"country": "EE", "region": None, "name": "Estonia", "first_year": 2008, "last_year": 2024, "rights": "CC BY-SA 3.0 EE; verify share-alike obligations"},
    {"country": "FI", "region": None, "name": "Finland", "first_year": 2020, "last_year": 2025, "rights": "CC BY 4.0"},
    {"country": "FR", "region": None, "name": "France (excludes overseas regions)", "first_year": 2007, "last_year": 2024, "region_required_before": 2015, "rights": "Etalab Open Licence; attribution required", "limits": "2007–2014 block data can have several crops; some supplementary tables are missing."},
    {"country": "DE", "region": "DE_BWB", "name": "Baden-Württemberg", "first_year": 2022, "last_year": 2022, "rights": "Data licence Germany attribution 2.0"},
    {"country": "DE", "region": "DE_BRB", "name": "Brandenburg", "first_year": 2010, "last_year": 2025, "rights": "Data licence Germany attribution 2.0"},
    {"country": "DE", "region": "DE_LSA", "name": "Lower Saxony", "first_year": 2023, "last_year": 2025, "rights": "Data licence Germany attribution 2.0"},
    {"country": "DE", "region": "DE_NRW", "name": "North Rhine-Westphalia", "first_year": 2019, "last_year": 2025, "rights": "Data licence Germany attribution 2.0"},
    {"country": "IE", "region": None, "name": "Ireland", "first_year": 2017, "last_year": 2024, "rights": "CC BY 4.0", "limits": "Claimed areas only; excluded areas and some subfeatures are not represented."},
    {"country": "IT", "region": "IT_TOS", "name": "Tuscany only", "first_year": 2016, "last_year": 2023, "rights": "CC BY 4.0", "limits": "Duplicate blocks with differing crop information were separated; specific crop areas can be unavailable."},
    {"country": "LV", "region": None, "name": "Latvia", "first_year": 2022, "last_year": 2024, "rights": "No licence supplied in documentation; shared redistribution blocked", "redistribution": "blocked_unresolved"},
    {"country": "LT", "region": None, "name": "Lithuania", "first_year": 2024, "last_year": 2025, "rights": "Non-commercial use only; additional copyright/access restrictions", "redistribution": "blocked_noncommercial_only", "limits": "LPIS reference boundaries, not declared GSA fields."},
    {"country": "NL", "region": None, "name": "Netherlands", "first_year": 2009, "last_year": 2025, "rights": "CC0 1.0; preserve publisher and dataset attribution"},
    {"country": "PT", "region": None, "name": "Portugal", "first_year": 2011, "last_year": 2025, "region_required_before": 2020, "rights": "CC BY 4.0", "limits": "Earlier years use blocks, with crop areas missing in some companion tables."},
    {"country": "SK", "region": None, "name": "Slovakia", "first_year": 2018, "last_year": 2025, "rights": "No licence supplied in documentation; shared redistribution blocked", "redistribution": "blocked_unresolved"},
    {"country": "SI", "region": None, "name": "Slovenia", "first_year": 2018, "last_year": 2025, "rights": "Public data; source citation required"},
    {"country": "ES", "region": None, "name": "Spain (province must be specified)", "first_year": 2022, "last_year": 2024, "region_required": True, "rights": "FEGA attribution required", "limits": "2022 omits Balearic Islands, Ciudad Real and Granada; Catalonia overlaps its separate release."},
    {"country": "ES", "region": "ES_CAT", "name": "Catalonia separate release", "first_year": 2015, "last_year": 2025, "rights": "Verify Catalonia source terms and FEGA attribution where relevant", "limits": "Overlaps the Spain-wide provincial data; do not double-count."},
    {"country": "SE", "region": None, "name": "Sweden", "first_year": 2015, "last_year": 2024, "rights": "CC BY 4.0", "limits": "Some earlier crop codes were inferred from later reference lists; unmatched codes and non-supported areas remain."},
]


class SubsetInput(StrictModel):
    farm_id: UUID
    country: str = Field(pattern=r"^[A-Z]{2}$")
    region: str | None = Field(default=None, max_length=120)
    year: int = Field(ge=2007, le=2025, strict=True)
    format: Literal["geojson", "csv"]
    content: str = Field(min_length=1, max_length=MAX_BYTES)
    upstream_file_name: str = Field(min_length=1, max_length=200)
    upstream_file_checksum: str | None = Field(default=None, pattern=r"^(md5:[0-9a-fA-F]{32}|sha256:[0-9a-fA-F]{64})$")
    source_crs: Literal["EPSG:4326"]
    source_area_unit: Literal["ha"]
    rights_basis: str = Field(min_length=10, max_length=1000)
    source_context_confirmed: bool = Field(strict=True)
    use_purpose: Literal["private_reference", "noncommercial_research"] = "private_reference"


def _fail(message, code="invalid_iacs_subset"):
    raise ApiError(422, code, message)


def catalog():
    return {"id": DATASET_ID, "version": "1.3", "published_at": "2026-02-18", "url": RECORD_URL, "doi": "10.5281/zenodo.18670815",
        "authors": ["Clemens Jänicke", "Kristoffer Ansbak Petersen", "Phillip Schmidts", "Daniel Müller", "Martin Rudbeck Jepsen"],
        "citation": "Jänicke et al., Europe-LAND harmonised IACS inventory v1.3. Related article: Scientific Data 12, 1050; DOI 10.1038/s41597-025-05210-6.",
        "license": "No blanket licence was established from the record. Original-source attribution and per-jurisdiction terms must be checked.",
        "documentation": {"url": DOCUMENTATION_URL, "md5": DOC_MD5, "sha256": DOC_SHA256, "checksum_verified": True},
        "native_format": "GeoParquet", "native_crs": "EPSG:3035", "accepted_subset_crs": "EPSG:4326", "field_size_unit": "ha",
        "mandatory_columns": list(MANDATORY), "optional_columns": list(OPTIONAL), "coverage": COVERAGE,
        "coverage_meaning": "Documented ranges, not a verified matrix of every public file/year. The exact subset origin, year and region require user confirmation.",
        "max_rows": MAX_ROWS, "max_bytes": MAX_BYTES, "warnings": WARNINGS, "automatic_download": False, "shared_redistribution": False}


def _coverage(body):
    entries = [entry for entry in COVERAGE if entry["country"] == body.country and entry["first_year"] <= body.year <= entry["last_year"]]
    explicit = next((entry for entry in entries if entry["region"] is not None and entry["region"] == body.region), None)
    entry = explicit or next((entry for entry in entries if entry["region"] is None), None)
    if entry is None:
        _fail("This country, year or region is not in the documented public coverage. Do not substitute another place or campaign.", "iacs_coverage_unavailable")
    if (entry.get("region_required") or body.year < entry.get("region_required_before", 0)) and not body.region:
        _fail("Identify the original province or region for this historical subset.")
    if body.country == "LT" and body.use_purpose != "noncommercial_research":
        _fail("Lithuania's source terms are non-commercial only. Farm-administration reuse is not enabled by this adapter.", "iacs_rights_restricted")
    return entry


def _number(value, label, optional=False):
    if optional and value in (None, ""):
        return None
    if isinstance(value, bool):
        _fail(f"{label} must preserve a non-negative numeric hectare value, not a boolean.")
    try:
        result = float(value)
    except (ValueError, TypeError):
        _fail(f"{label} must preserve the source hectare value.")
    if not math.isfinite(result) or result < 0:
        _fail(f"{label} must be finite and non-negative.")
    return result


def _nonfinite_json(value):
    raise ValueError("Non-finite JSON number")


def adapt_subset(body: SubsetInput):
    if not body.source_context_confirmed:
        _fail("Explicitly confirm the subset's original country, region, year, rights and reprojection before previewing it.")
    entry = _coverage(body)
    try:
        encoded = body.content.encode("utf-8")
    except UnicodeError:
        _fail("Use a valid UTF-8 subset without isolated Unicode surrogate characters.")
    if len(encoded) > MAX_BYTES or any(char in body.upstream_file_name for char in "/\\\x00"):
        _fail("Use a bounded subset and the original file's base name, not a local path.")
    try:
        if body.format == "geojson":
            document = json.loads(body.content, parse_constant=_nonfinite_json)
            if not isinstance(document, dict) or document.get("type") != "FeatureCollection" or "crs" in document:
                _fail("Export a GeoJSON FeatureCollection reprojected to EPSG:4326, without a custom CRS.")
            features = document.get("features")
            if not isinstance(features, list) or not 1 <= len(features) <= MAX_ROWS:
                _fail(f"Select between 1 and {MAX_ROWS} reference features.")
            rows = []
            for feature in features:
                if not isinstance(feature, dict) or feature.get("type") != "Feature" or not isinstance(feature.get("properties"), dict):
                    _fail("Each GeoJSON feature needs an original property object.")
                rows.append((feature["properties"], feature.get("geometry")))
        else:
            reader = csv.DictReader(io.StringIO(body.content.lstrip("\ufeff")), strict=True)
            if not reader.fieldnames or len(set(reader.fieldnames)) != len(reader.fieldnames) or any(name not in reader.fieldnames for name in MANDATORY):
                _fail("CSV headers must include each mandatory IACS column exactly once.")
            rows = []
            for row in reader:
                if len(rows) >= MAX_ROWS or None in row:
                    _fail(f"Select at most {MAX_ROWS} complete CSV rows.")
                geometry = json.loads(row["geometry_geojson"], parse_constant=_nonfinite_json) if row.get("geometry_geojson") else None
                rows.append((row, geometry))
            if not rows:
                _fail("The CSV subset is empty.")
    except (ValueError, TypeError, RecursionError, csv.Error):
        _fail("The subset could not be read safely. Use UTF-8 GeoJSON or CSV with an optional geometry_geojson column.")
    upload_hash = hashlib.sha256(encoded).hexdigest()
    candidates, ids, total_vertices = [], set(), 0
    for index, (properties, geometry) in enumerate(rows):
        if any(key not in properties for key in MANDATORY):
            _fail(f"Row {index + 1} is missing a mandatory harmonised column.")
        field_id = properties["field_id"]
        if isinstance(field_id, bool) or not isinstance(field_id, (str, int)) or not str(field_id).strip() or len(str(field_id)) > 200:
            _fail("Preserve a non-empty original field identifier.")
        if str(field_id) in ids:
            _fail("Field IDs repeat in this subset. Resolve its crop/block records instead of silently deduplicating.")
        ids.add(str(field_id))
        for key in ("crop_code", "crop_name", "EC_trans_n", "EC_hcat_n", "EC_hcat_c"):
            if not isinstance(properties[key], str) or len(properties[key]) > 1000:
                _fail(f"Preserve {key} as bounded text. Numeric coercion can destroy crop-code meaning.")
        if not re.fullmatch(r"[0-9]{10}", properties["EC_hcat_c"]):
            _fail("Preserve the ten-digit HCAT code as a string, including any leading zeros.")
        if properties.get("year") not in (None, "", body.year, str(body.year)):
            _fail("A row's year differs from the selected source year.")
        if properties.get("country") not in (None, "", body.country, body.region):
            _fail("A row's country differs from the selected source context.")
        if properties.get("region") not in (None, "", body.region):
            _fail("A row's region differs from the selected source context.")
        size, crop_area = _number(properties["field_size"], "field_size"), _number(properties.get("crop_area"), "crop_area", True)
        normalized = validate_geometry(geometry) if geometry is not None else None
        if normalized:
            parts = [normalized["coordinates"]] if normalized["type"] == "Polygon" else normalized["coordinates"]
            total_vertices += sum(len(ring) for part in parts for ring in part)
            if total_vertices > 5000:
                _fail("Select a smaller outline subset with at most 5,000 total positions.")
        original = {key: properties[key] for key in (*MANDATORY, *OPTIONAL) if key in properties}
        if any(isinstance(value, (dict, list)) for value in original.values()) or len(json.dumps(original, allow_nan=False)) > 12000:
            _fail("Preserve ordinary bounded source scalar values, not embedded documents.")
        source_label = f"Europe-LAND IACS v1.3; {body.country}/{body.region or 'national'}/{body.year}; subset SHA256 {upload_hash}; field {field_id}"
        candidates.append({"external_id": str(field_id), "source_year": body.year, "source_region": body.region,
            "crop_code": properties["crop_code"], "crop_name": properties["crop_name"], "translated_crop_name": properties["EC_trans_n"],
            "hcat_name": properties["EC_hcat_n"], "hcat_code": properties["EC_hcat_c"], "source_area_ha": size, "source_crop_area_ha": crop_area,
            "geometry": normalized, "original_properties": original, "upstream_applicant_id": properties.get("farm_id"),
            "organic_raw": properties.get("organic"), "organic_verified": False, "review_status": "historical_reference_unreviewed",
            "may_use_for_farm_administration": body.country != "LT",
            "field_reference": {"geometry": normalized, "external_id": str(field_id), "crop": properties["crop_name"][:200], "source": source_label[:500], "year": body.year} if body.country != "LT" else None})
    warnings = [*WARNINGS, entry["rights"]]
    if entry.get("limits"):
        warnings.append(entry["limits"])
    if body.country == "LT":
        warnings.append("Research-only preview: selecting these data into the farm-administration field reference is disabled because of the source's non-commercial restriction.")
    if any(candidate["geometry"] is None for candidate in candidates):
        warnings.append("Some CSV records have no geometry; they can supply metadata only, not a field outline.")
    return {"dataset_id": DATASET_ID, "version": "1.3", "country": body.country, "region": body.region, "year": body.year,
        "candidates": candidates, "warnings": warnings, "status": "historical_reference_preview", "shared_redistribution": False,
        "provenance": {"record_url": RECORD_URL, "documentation_md5": DOC_MD5, "documentation_sha256": DOC_SHA256,
            "subset_sha256": upload_hash, "upstream_file_name": body.upstream_file_name, "upstream_file_checksum": body.upstream_file_checksum,
            "upstream_file_checksum_verified": False, "rights_basis_supplied_by_user": body.rights_basis, "source_crs_original": "EPSG:3035",
            "subset_crs_confirmed_by_user": body.source_crs, "source_area_unit": "ha", "translation_mapping_review": "LLM-assisted upstream, not verified", "use_purpose": body.use_purpose},
        "next_action": "Select a candidate as the supplied comparison reference in the existing field-change review. Confirm present-day boundaries and crops yourself; no field or fact was changed."}


@router.get("/catalog")
def get_catalog(session: Session = Depends(require_session)):
    return catalog()


@router.post("/preview", status_code=201)
def preview(body: SubsetInput, session: Session = Depends(require_session), retry_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", str(body.farm_id))
        if farm["data"].get("country") != body.country:
            _fail("Choose reference data for this farm's country.")
        coverage = _coverage(body)
        farm_region = farm["data"].get("region")
        scope = coverage.get("region")
        if scope in REGION_NAMES and farm_region and str(farm_region).casefold() not in {name.casefold() for name in REGION_NAMES[scope]}:
            _fail("The dataset region differs from the farm's saved region. Check the real location and source scope instead of substituting another region.", "iacs_region_mismatch")
        prepared = adapt_subset(body)
        if scope and not farm_region:
            prepared["warnings"].append("The farm has no saved region. Verify that this regional reference really covers its fields before using it for comparison.")
        return idempotent(conn, retry_key, "iacs-reference-preview", body.model_dump(mode="json"), lambda: insert_record(conn, "field_reference_previews", {"farm_id": str(body.farm_id), "farm_revision": farm["revision"], **prepared}))


@router.get("/{preview_id}")
def preview_detail(preview_id: UUID, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "field_reference_previews", str(preview_id))
        farm = fetch_record(conn, "farms", record["data"]["farm_id"])
        return {**record, "farm_context_changed": farm["revision"] != record["data"]["farm_revision"]}
