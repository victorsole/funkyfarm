"""Bounded private boundary-file previews, followed by an explicit proposal.

Files are data, never URLs or instructions. Importing does not match, retire,
approve or change a field, and establishes no official LPIS identity.
"""

from copy import deepcopy
import hashlib
import json
import math
import re
from typing import Literal
from uuid import UUID, uuid4
from xml.etree import ElementTree

from fastapi import APIRouter, Depends, Header
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, transaction, update_record
from .fields import KML_NAMESPACE, geometry_summary, validate_geometry
from .geometry import checked_shape
from .models import ApiError, StrictModel
from .security import Session, require_roles, require_session

router = APIRouter(tags=["private field imports"])
MAX_BYTES = 512_000
MAX_ROWS = 100
MAX_POSITIONS = 20_000
MAX_NODES = 100_000
MAX_DEPTH = 32
NOTICE = "Private file preview only. Source identifiers, approximate areas and public references do not establish official LPIS registration, ownership or eligible area. Nothing is applied or submitted."


class ImportFile(StrictModel):
    expected_farm_revision: int = Field(ge=1, strict=True)
    filename: str = Field(min_length=1, max_length=180)
    format: Literal["geojson", "kml"]
    contents: str = Field(min_length=1, max_length=MAX_BYTES)
    source_year: int | None = Field(default=None, ge=1900, le=2200, strict=True)
    source_origin: Literal["my_file", "public_reference"] = "my_file"


class ProposeImport(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    expected_farm_revision: int = Field(ge=1, strict=True)
    selected_ids: list[UUID] = Field(min_length=1, max_length=20)
    note: str = Field(min_length=1, max_length=4000)
    acknowledged: bool = Field(strict=True)


def _invalid(message, code="field_import_invalid", **details):
    raise ApiError(422, code, message, details)


def _interactive(session):
    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Open the signed-in application to import private field boundaries.")


def _write(conn, session, farm):
    _interactive(session)
    require_roles(session, "owner", "adviser")
    if not conn.execute("SELECT record_access(%s,'farms',%s::jsonb,true) AS allowed",
        (farm["id"], json.dumps(farm["data"]))).fetchone()["allowed"]:
        raise ApiError(403, "review_permission_required", "Your current farm grant does not allow field proposals.")


def _farm_lock(conn, session, farm_id, expected_revision):
    farm = fetch_record(conn, "farms", str(farm_id))
    _write(conn, session, farm)
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm['id']}",))
    conn.execute("SELECT id FROM records WHERE id=%s AND kind='farms' AND deleted_at IS NULL FOR SHARE", (UUID(farm["id"]),)).fetchone()
    farm = fetch_record(conn, "farms", farm["id"])
    if farm["revision"] != expected_revision:
        raise ApiError(409, "revision_conflict", "The farm changed. Reload it before preparing this import.", {"current_revision": farm["revision"]})
    return farm


def _compact(record):
    return {**record, "data": {key: deepcopy(value) for key, value in record["data"].items() if key != "contents"}}


def _text(value, field, maximum=200):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum or any(ord(char) < 32 and char not in "\t\n\r" for char in value):
        _invalid(f"Keep {field} as text of at most {maximum} characters.", field=field)
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        _invalid(f"Keep {field} as valid Unicode text, without unpaired surrogate characters.", field=field)
    return value


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _invalid("Duplicate JSON keys are ambiguous. Keep each property only once.", "field_import_duplicate_key")
        result[key] = value
    return result


def _json_constant(value):
    _invalid("JSON values must be finite; NaN and Infinity cannot describe a boundary.")


def _finite_number(value):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # JSON integers need not fit a double, including a supplied altitude.
        return False


def _json_tree(root):
    pending, nodes = [(root, 0)], 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if depth > MAX_DEPTH or nodes > MAX_NODES:
            _invalid("This file's nested data exceeds the bounded import parser.", "field_import_structure_limit")
        if isinstance(value, float) and not math.isfinite(value):
            _invalid("All JSON numbers, including source properties, must be finite.")
        if isinstance(value, str):
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                _invalid("JSON text must contain valid Unicode characters, not unpaired surrogate escapes.")
        if isinstance(value, dict):
            if "crs" in value:
                _invalid("A declared CRS is not supported. Supply WGS84 longitude/latitude without inferring or converting coordinates.", "field_import_crs")
            pending.extend((child, depth + 1) for child in (*value.keys(), *value.values()))
        elif isinstance(value, list):
            pending.extend((child, depth + 1) for child in value)


def _geometry(value, counter, warnings):
    if not isinstance(value, dict) or value.get("type") not in {"Polygon", "MultiPolygon"} or set(value) - {"type", "coordinates"}:
        _invalid("Every imported feature must contain a Polygon or MultiPolygon in WGS84 longitude/latitude.")
    source = value.get("coordinates")
    parts = [source] if value["type"] == "Polygon" else source
    if not isinstance(parts, list):
        _invalid("Supply polygon parts as coordinate arrays.")
    normalized, altitude = [], False
    for part in parts:
        if not isinstance(part, list):
            _invalid("Supply polygon rings as coordinate arrays.")
        rings = []
        for ring in part:
            if not isinstance(ring, list):
                _invalid("Supply each closed ring as a coordinate array.")
            positions = []
            for position in ring:
                counter[0] += 1
                if counter[0] > MAX_POSITIONS:
                    _invalid("An import may contain at most 20,000 positions in total.", "field_import_position_limit")
                if not isinstance(position, (list, tuple)) or len(position) not in {2, 3} or any(not _finite_number(number) for number in position):
                    _invalid("Each position needs finite longitude, latitude and, optionally, a finite supplied altitude.")
                altitude |= len(position) == 3
                positions.append(list(position[:2]))
            rings.append(positions)
        normalized.append(rings)
    if altitude:
        warnings.append("Supplied altitude values remain in the retained original file. This preview uses longitude/latitude only and makes no height or vertical-datum claim.")
    geometry = validate_geometry({"type": value["type"], "coordinates": normalized[0] if value["type"] == "Polygon" else normalized})
    checked_shape(geometry)
    return geometry


def _row(index, geometry, properties, source_id, counter, warnings=None):
    warnings = list(warnings or [])
    name = _text(properties.get("name"), "name")
    if name is None or not name.strip():
        name = f"Imported field {index}"
        warnings.append("The source has no field name. This is an app-generated preview label; check the identity before proposing it.")
    crop = _text(properties.get("crop"), "crop")
    external_id = _text(properties.get("external_id"), "external_id")
    if source_id is not None:
        if isinstance(source_id, bool) or not isinstance(source_id, (str, int, float)):
            _invalid("A source feature identifier must be supplied text or a finite number, not an embedded object.")
        source_id = _text(str(source_id), "source feature identifier", 4000)
    geometry = _geometry(geometry, counter, warnings)
    return {"id": str(uuid4()), "name": name, "crop": crop, "external_id": external_id,
        "geometry": geometry, "geometry_summary": geometry_summary(geometry), "source_feature_id": source_id, "warnings": warnings}


def _geojson(contents):
    try:
        root = json.loads(contents.lstrip("\ufeff"), object_pairs_hook=_json_pairs, parse_constant=_json_constant)
    except (json.JSONDecodeError, RecursionError, ValueError):
        _invalid("Supply a valid bounded UTF-8 GeoJSON file.")
    _json_tree(root)
    if not isinstance(root, dict):
        _invalid("Supply a GeoJSON geometry, Feature or FeatureCollection.")
    if root.get("type") == "FeatureCollection":
        features = root.get("features")
        if not isinstance(features, list):
            _invalid("A FeatureCollection needs its complete feature list.")
    elif root.get("type") in {"Feature", "Polygon", "MultiPolygon"}:
        features = [root]
    else:
        _invalid("Only polygon GeoJSON geometries, Features and FeatureCollections are supported.")
    if not 1 <= len(features) <= MAX_ROWS:
        _invalid("Import between 1 and 100 polygon features in one file.", "field_import_row_limit")
    rows, counter = [], [0]
    for index, feature in enumerate(features, start=1):
        if not isinstance(feature, dict):
            _invalid("Every feature must be a complete object; no invalid features are skipped.")
        if feature.get("type") == "Feature":
            properties = feature.get("properties")
            if properties is None:
                properties = {}
            if not isinstance(properties, dict):
                _invalid("Feature properties must be an object or null.")
            rows.append(_row(index, feature.get("geometry"), properties, feature.get("id"), counter))
        elif root.get("type") != "FeatureCollection" and feature.get("type") in {"Polygon", "MultiPolygon"}:
            rows.append(_row(index, feature, {}, None, counter))
        else:
            _invalid("Every FeatureCollection entry must be a polygon Feature. No point, line or bad feature is skipped.")
    return rows


class _KmlBuilder(ElementTree.TreeBuilder):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.nodes = 0

    def start(self, tag, attrs):
        self.depth += 1
        self.nodes += 1
        if self.depth > MAX_DEPTH or self.nodes > MAX_NODES:
            _invalid("This KML exceeds the bounded XML node or nesting limit.", "field_import_structure_limit")
        return super().start(tag, attrs)

    def end(self, tag):
        value = super().end(tag)
        self.depth -= 1
        return value

    def doctype(self, name, public_id, system_id):
        _invalid("KML document types and entities are not permitted.", "field_import_unsafe_xml")


def _tag(name):
    return f"{{{KML_NAMESPACE}}}{name}"


def _kml_ring(boundary):
    rings = list(boundary)
    if len(rings) != 1 or rings[0].tag != _tag("LinearRing"):
        _invalid("Each KML boundary needs exactly one LinearRing.")
    if any(child.tag not in {_tag("coordinates"), _tag("extrude"), _tag("tessellate"), _tag("altitudeMode")} for child in rings[0]):
        _invalid("A KML LinearRing may contain only its coordinates and ordinary boundary display settings.")
    coordinates = rings[0].findall(_tag("coordinates"))
    if len(coordinates) != 1 or list(coordinates[0]):
        _invalid("Each KML ring needs exactly one plain coordinates value.")
    result = []
    for token in (coordinates[0].text or "").split():
        numbers = token.split(",")
        if len(numbers) not in {2, 3} or any(not part for part in numbers):
            _invalid("Use KML longitude,latitude with optional altitude; coordinates are not reprojected.")
        try:
            result.append([float(part) for part in numbers])
        except ValueError:
            _invalid("KML coordinates must contain finite numeric longitude and latitude.")
    return result


def _kml_parts(element):
    if element.tag == _tag("MultiGeometry"):
        children = list(element)
        if not children:
            _invalid("A KML MultiGeometry must contain polygon parts.")
        result = []
        for child in children:
            result.extend(_kml_parts(child))
        return result
    if element.tag != _tag("Polygon"):
        _invalid("Every KML Placemark must contain polygons only; points, lines and other geometry are not skipped.")
    if any(child.tag not in {_tag("outerBoundaryIs"), _tag("innerBoundaryIs"), _tag("extrude"), _tag("tessellate"), _tag("altitudeMode")} for child in element):
        _invalid("A KML polygon may contain only its boundaries and ordinary display settings.")
    outer = element.findall(_tag("outerBoundaryIs"))
    inner = element.findall(_tag("innerBoundaryIs"))
    if len(outer) != 1:
        _invalid("Every KML polygon needs exactly one outer boundary.")
    return [[_kml_ring(outer[0]), *[_kml_ring(boundary) for boundary in inner]]]


def _kml_properties(placemark):
    values = {}
    extended = placemark.findall(_tag("ExtendedData"))
    if len(extended) > 1:
        _invalid("Keep one ExtendedData block per KML Placemark.")
    if extended:
        for element in extended[0].iter():
            if element.tag not in {_tag("Data"), _tag("SimpleData")}:
                continue
            name = element.get("name")
            if name in values:
                _invalid("Duplicate KML data names are ambiguous. Keep each property only once.")
            if name is not None:
                if element.tag == _tag("Data"):
                    supplied = element.findall(_tag("value"))
                    if len(supplied) != 1 or list(supplied[0]):
                        _invalid("KML Data properties need one plain value.")
                    values[name] = supplied[0].text or ""
                else:
                    if list(element):
                        _invalid("KML SimpleData properties must be plain text.")
                    values[name] = element.text or ""
    names = placemark.findall(_tag("name"))
    if len(names) > 1 or any(list(name) for name in names):
        _invalid("Keep one plain field name per KML Placemark.")
    fallback = names[0].text if names else None
    warnings = []
    if "name" in values and fallback and values["name"] != fallback:
        warnings.append("The Placemark name and its name metadata differ. This preview retains the explicit name metadata; review the original file.")
    return {"name": values.get("name", fallback), "crop": values.get("crop"), "external_id": values.get("external_id")}, warnings


def _kml(contents):
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", contents, re.IGNORECASE):
        _invalid("KML document types and entities are not permitted.", "field_import_unsafe_xml")
    encoding = re.match(r"\s*<\?xml[^?]*\bencoding\s*=\s*['\"]([^'\"]+)", contents.lstrip("\ufeff"), re.IGNORECASE)
    if encoding and encoding[1].lower().replace("-", "") != "utf8":
        _invalid("Supply UTF-8 KML text; another declared encoding is not inferred or converted.")
    try:
        root = ElementTree.fromstring(contents, parser=ElementTree.XMLParser(target=_KmlBuilder()))
    except (ElementTree.ParseError, ValueError, RecursionError):
        _invalid("Supply a valid bounded KML 2.2 XML file.")
    if root.tag != _tag("kml"):
        _invalid("Use the KML 2.2 namespace http://www.opengis.net/kml/2.2.")
    forbidden = {"NetworkLink", "NetworkLinkControl", "Point", "LineString", "Model", "Track", "MultiTrack", "GroundOverlay", "PhotoOverlay", "ScreenOverlay"}
    parents = {child: parent for parent in root.iter() for child in parent}
    geometry_names = {"kml", "Placemark", "Polygon", "MultiGeometry", "outerBoundaryIs", "innerBoundaryIs", "LinearRing", "coordinates"}
    for element in root.iter():
        local_name = element.tag.rsplit("}", 1)[-1]
        if local_name in forbidden:
            _invalid("Network links, points, lines, overlays and other non-polygon KML are not supported. No remote resources are fetched.", "field_import_unsupported_kml")
        if local_name in geometry_names and element.tag != _tag(local_name):
            _invalid("Use only KML 2.2 namespace geometry; foreign geometry is not silently omitted.")
        parent = parents.get(element)
        if element.tag == _tag("LinearRing") and (parent is None or parent.tag not in {_tag("outerBoundaryIs"), _tag("innerBoundaryIs")}):
            _invalid("LinearRing is supported only as a polygon boundary, not as a standalone geometry.")
        if element.tag == _tag("coordinates") and (parent is None or parent.tag != _tag("LinearRing")):
            _invalid("Coordinates must belong to an imported polygon ring.")
        if element.tag == _tag("Placemark") and (parent is None or parent.tag not in {_tag("kml"), _tag("Document"), _tag("Folder")}):
            _invalid("Keep each polygon Placemark directly inside the document or a folder.")
    placemarks = list(root.iter(_tag("Placemark")))
    if not 1 <= len(placemarks) <= MAX_ROWS:
        _invalid("Import between 1 and 100 polygon Placemarks in one file.", "field_import_row_limit")
    rows, counter, used_polygons = [], [0], set()
    for index, placemark in enumerate(placemarks, start=1):
        geometry = [child for child in placemark if child.tag in {_tag("Polygon"), _tag("MultiGeometry")}]
        if len(geometry) != 1:
            _invalid("Every Placemark needs one Polygon or polygon-only MultiGeometry. No Placemark is skipped.")
        used_polygons.update(geometry[0].iter(_tag("Polygon")))
        parts = _kml_parts(geometry[0])
        properties, warnings = _kml_properties(placemark)
        shape = {"type": "Polygon" if len(parts) == 1 else "MultiPolygon", "coordinates": parts[0] if len(parts) == 1 else parts}
        rows.append(_row(index, shape, properties, placemark.get("id"), counter, warnings))
    if set(root.iter(_tag("Polygon"))) != used_polygons:
        _invalid("Every polygon must belong to an imported Placemark; detached polygons are not silently omitted.")
    return rows


@router.post("/farms/{farm_id}/field-imports", status_code=201)
def import_file(farm_id: UUID, body: ImportFile, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _interactive(session)
    _text(body.filename, "filename", 180)
    try:
        raw = body.contents.encode("utf-8")
    except UnicodeEncodeError:
        _invalid("Supply valid UTF-8 text without unpaired surrogate characters.")
    if len(raw) > MAX_BYTES:
        _invalid("A field import may contain at most 512,000 UTF-8 bytes.", "field_import_size_limit")
    if not body.filename.strip() or any(char in body.filename for char in ("/", "\\", "\x00", "\r", "\n")):
        _invalid("Supply the plain original filename, not a path or URL.", "field_import_filename")
    with transaction(session) as conn:
        _write(conn, session, fetch_record(conn, "farms", str(farm_id)))
        def perform():
            farm = _farm_lock(conn, session, farm_id, body.expected_farm_revision)
            rows = _geojson(body.contents) if body.format == "geojson" else _kml(body.contents)
            data = {"farm_id": farm["id"], "farm_revision": farm["revision"], "filename": body.filename,
                "format": body.format, "sha256": hashlib.sha256(raw).hexdigest(), "contents": body.contents,
                "source_year": body.source_year, "source_origin": body.source_origin, "status": "preview", "rows": rows, "notice": NOTICE}
            return _compact(insert_record(conn, "field_imports", data))
        return idempotent(conn, idempotency_key, f"field-import:{farm_id}:{session.user_id}", body.model_dump(mode="json"), perform)


@router.get("/field-imports/{import_id}")
def import_detail(import_id: UUID, session: Session = Depends(require_session)):
    _interactive(session)
    with transaction(session) as conn:
        record = fetch_record(conn, "field_imports", str(import_id))
        fetch_record(conn, "farms", record["data"]["farm_id"])
        return _compact(record)


@router.post("/field-imports/{import_id}/propose", status_code=201)
def propose_import(import_id: UUID, body: ProposeImport, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    _interactive(session)
    _text(body.note, "proposal note", 4000)
    if not body.acknowledged or not body.note.strip():
        _invalid("Review the selected rows and explain the proposal before acknowledging it.", "field_import_acknowledgement_required")
    selected_ids = [str(value) for value in body.selected_ids]
    if len(set(selected_ids)) != len(selected_ids):
        _invalid("Select each preview row only once.", "field_import_selection")
    with transaction(session) as conn:
        initial = fetch_record(conn, "field_imports", str(import_id))
        _write(conn, session, fetch_record(conn, "farms", initial["data"]["farm_id"]))
        def perform():
            record = fetch_record(conn, "field_imports", str(import_id))
            farm = _farm_lock(conn, session, record["data"]["farm_id"], body.expected_farm_revision)
            conn.execute("SELECT id FROM records WHERE id=%s AND kind='field_imports' AND deleted_at IS NULL FOR UPDATE", (import_id,)).fetchone()
            record = fetch_record(conn, "field_imports", str(import_id))
            if record["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "This import changed. Reload its preview before proposing fields.")
            if record["data"].get("status") != "preview":
                raise ApiError(409, "field_import_already_proposed", "This preview already created a proposal. Review that proposal instead of creating another batch.")
            if record["data"]["farm_revision"] != farm["revision"]:
                raise ApiError(409, "revision_conflict", "The farm changed since this file was previewed. Create a new import preview against the current farm.")
            by_id = {row["id"]: row for row in record["data"]["rows"]}
            if any(value not in by_id for value in selected_ids):
                _invalid("Select rows from this exact import preview.", "field_import_selection")
            source = {"id": record["id"], "revision": record["revision"], "sha256": record["data"]["sha256"],
                **{key: record["data"][key] for key in ("filename", "format", "source_year", "source_origin")}, "selected_ids": selected_ids}
            from .fields import prepare_import_proposal
            data = prepare_import_proposal(farm, [deepcopy(by_id[value]) for value in selected_ids], body.note, session, source)
            proposal = insert_record(conn, "field_change_proposals", data)
            updated = update_record(conn, "field_imports", record["id"], record["revision"], {**record["data"], "status": "proposed", "proposal_id": proposal["id"]})
            return {"import": _compact(updated), "proposal": proposal}
        return idempotent(conn, idempotency_key, f"field-import-propose:{import_id}:{session.user_id}", body.model_dump(mode="json"), perform)
