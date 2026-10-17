"""Supplied field outlines and reviewed changes; never an official LPIS filing."""

from copy import deepcopy
from datetime import datetime, timezone
import json
import math
from typing import Literal
from uuid import UUID, uuid4
from xml.etree import ElementTree

from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import Response
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, list_records, transaction, update_record
from .models import ApiError, StrictModel
from .security import Session, require_roles, require_session

router = APIRouter(tags=["fields"])
EPS = 1e-12
KML_NAMESPACE = "http://www.opengis.net/kml/2.2"
ElementTree.register_namespace("", KML_NAMESPACE)


def invalid(message):
    raise ApiError(422, "invalid_geometry", message)


def coordinate(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        invalid("Each GeoJSON position needs exactly [longitude, latitude].")
    if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in value):
        invalid("Coordinates must be finite numbers.")
    lon, lat = value
    if not -180 <= lon <= 180 or not -90 <= lat <= 90:
        invalid("Longitude must be between -180 and 180, and latitude between -90 and 90.")
    return [float(lon), float(lat)]


def cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def on_segment(a, b, p):
    return abs(cross(a, b, p)) < EPS and min(a[0], b[0]) - EPS <= p[0] <= max(a[0], b[0]) + EPS and min(a[1], b[1]) - EPS <= p[1] <= max(a[1], b[1]) + EPS


def intersects(a, b, c, d, strict=False):
    x, y, z, w = cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)
    if ((x > EPS and y < -EPS) or (y > EPS and x < -EPS)) and ((z > EPS and w < -EPS) or (w > EPS and z < -EPS)):
        return True
    return False if strict else any((on_segment(a, b, c), on_segment(a, b, d), on_segment(c, d, a), on_segment(c, d, b)))


def inside(point, ring, boundary=True):
    result = False
    for a, b in zip(ring, ring[1:]):
        if on_segment(a, b, point):
            return boundary
        if (a[1] > point[1]) != (b[1] > point[1]) and point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]:
            result = not result
    return result


def rings_touch(a, b, strict=False):
    return any(intersects(p, q, r, s, strict) for p, q in zip(a, a[1:]) for r, s in zip(b, b[1:]))


def in_polygon(point, polygon, boundary=True):
    return inside(point, polygon[0], boundary) and not any(inside(point, hole, not boundary) for hole in polygon[1:])


def polygon_overlap(a, b):
    if any(rings_touch(x, y, strict=True) for x in a for y in b):
        return True
    for source, other in ((a, b), (b, a)):
        for ring in source[:1]:
            for p, q in zip(ring, ring[1:]):
                if in_polygon(p, other, False) or in_polygon([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], other, False):
                    return True
        # Identical boundaries have no strictly interior vertices or edge midpoints.
        if source[0] == other[0] or list(reversed(source[0])) == other[0]:
            return True
    return False


def polygons(geometry):
    return [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]


def validate_geometry(value):
    if not isinstance(value, dict) or value.get("type") not in {"Polygon", "MultiPolygon"} or set(value) - {"type", "coordinates"}:
        invalid("Supply a GeoJSON Polygon or MultiPolygon in longitude/latitude (WGS84), without a custom CRS.")
    raw = value.get("coordinates")
    raw_polygons = [raw] if value["type"] == "Polygon" else raw
    if not isinstance(raw_polygons, list) or not 1 <= len(raw_polygons) <= 20:
        invalid("Supply between 1 and 20 polygon parts.")
    normalized, count = [], 0
    for polygon in raw_polygons:
        if not isinstance(polygon, list) or not 1 <= len(polygon) <= 20:
            invalid("Each polygon needs an outer ring and at most 19 holes.")
        rings = []
        for raw_ring in polygon:
            if not isinstance(raw_ring, list) or not 4 <= len(raw_ring) <= 500:
                invalid("A closed ring needs 4 to 500 positions, including its repeated first position.")
            count += len(raw_ring)
            if count > 1000:
                invalid("An outline may contain at most 1,000 positions.")
            ring = [coordinate(point) for point in raw_ring]
            if ring[0] != ring[-1] or len({tuple(p) for p in ring[:-1]}) != len(ring) - 1:
                invalid("Close each ring exactly once and remove repeated internal vertices.")
            if any(a == b for a, b in zip(ring, ring[1:])):
                invalid("A ring cannot contain zero-length edges.")
            edges = list(zip(ring, ring[1:]))
            for i, (a, b) in enumerate(edges):
                for j in range(i + 1, len(edges)):
                    if j == i + 1 or (i == 0 and j == len(edges) - 1):
                        continue
                    if intersects(a, b, *edges[j]):
                        invalid("An outline cannot cross or touch itself. Review its vertex order.")
            planar = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges))
            if planar < EPS:
                invalid("An outline must enclose a nonzero area.")
            rings.append(ring)
        for index, hole in enumerate(rings[1:], start=1):
            if not inside(hole[0], rings[0], False) or rings_touch(hole, rings[0]):
                invalid("Each hole must lie strictly inside its outer ring.")
            for other in rings[1:index]:
                if rings_touch(hole, other) or inside(hole[0], other) or inside(other[0], hole):
                    invalid("Holes cannot overlap or contain one another.")
        normalized.append(rings)
    points = [p for poly in normalized for ring in poly for p in ring]
    if max(p[0] for p in points) - min(p[0] for p in points) > 5 or max(p[1] for p in points) - min(p[1] for p in points) > 5:
        invalid("Field outlines must fit within five degrees; split distant sites and antimeridian crossings.")
    for index, poly in enumerate(normalized):
        if any(polygon_overlap(poly, other) for other in normalized[:index]):
            invalid("The parts of a MultiPolygon cannot overlap.")
    return {"type": value["type"], "coordinates": normalized[0] if value["type"] == "Polygon" else normalized}


def geometry_summary(geometry):
    if not geometry:
        return {"bbox": None, "vertex_count": 0, "approximate_area_ha": None,
                "warnings": ["No field boundary supplied; a location point cannot establish area."]}
    geometry = validate_geometry(geometry)
    parts = polygons(geometry)
    points = [p for poly in parts for ring in poly for p in ring]
    bbox = [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
    lon0, lat0 = map(math.radians, [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2])
    # Spherical Lambert azimuthal equal-area projection; Earth's ellipsoid and survey errors remain unmodelled.
    def project(point):
        lon, lat = map(math.radians, point)
        k = math.sqrt(2 / (1 + math.sin(lat0) * math.sin(lat) + math.cos(lat0) * math.cos(lat) * math.cos(lon - lon0)))
        return [6371008.8 * k * math.cos(lat) * math.sin(lon - lon0),
                6371008.8 * k * (math.cos(lat0) * math.sin(lat) - math.sin(lat0) * math.cos(lat) * math.cos(lon - lon0))]
    def ring_area(ring):
        projected = [project(point) for point in ring]
        return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(projected, projected[1:]))) / 2
    area = sum(ring_area(poly[0]) - sum(ring_area(hole) for hole in poly[1:]) for poly in parts) / 10000
    warnings = ["Approximate area from your outline using a spherical equal-area projection; not a survey or CAP eligible area."]
    if area < 0.5:
        warnings.append("This small field may have too few unmixed satellite pixels for useful crop or activity estimates.")
    return {"bbox": bbox, "vertex_count": len(points), "approximate_area_ha": round(area, 5), "warnings": warnings,
            "area_method": "spherical_lambert_azimuthal_equal_area"}


def farm_parcels(farm):
    items = []
    for index, original in enumerate(farm["data"].get("parcels", [])):
        parcel = deepcopy(original)
        parcel["id"] = str(parcel.get("id") or f"legacy-{index}")
        items.append(parcel)
    return items


def find_parcel(farm, parcel_id):
    item = next((p for p in farm_parcels(farm) if p["id"] == parcel_id), None)
    if item is None:
        raise ApiError(404, "field_not_found", "This field was not found on this farm.")
    return item


def active_parcels(farm):
    return [p for p in farm_parcels(farm) if p.get("active") is not False]


def overlaps(parcel, others):
    from .geometry import exact_overlap
    if not parcel.get("geometry"):
        return []
    result = []
    own = validate_geometry(parcel["geometry"])
    for other in others:
        if other["id"] == parcel["id"] or not other.get("geometry"):
            continue
        try:
            their = validate_geometry(other["geometry"])
        except ApiError:
            continue
        if exact_overlap(own, their):
            result.append({"id": other["id"], "name": other.get("name", other["id"])})
    return result


class Point(StrictModel):
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False)


class Parcel(StrictModel):
    id: str | None = Field(default=None, min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=200)
    geometry: dict | None = None
    point: Point | None = None
    crop: str | None = Field(default=None, max_length=200)
    greenhouse: bool = False
    notes: str = Field(default="", max_length=4000)
    external_id: str | None = Field(default=None, max_length=200)


class Proposal(StrictModel):
    expected_revision: int = Field(ge=1)
    parcel: Parcel
    note: str = Field(default="", max_length=4000)
    reference: "FieldReference | None" = None


class FieldReference(StrictModel):
    geometry: dict | None = None
    external_id: str | None = Field(default=None, max_length=200)
    crop: str | None = Field(default=None, max_length=200)
    source: str = Field(default="Supplied for comparison", max_length=500)
    year: int | None = Field(default=None, ge=1900, le=2200)


Proposal.model_rebuild()


class Transformation(StrictModel):
    expected_revision: int = Field(ge=1)
    operation: Literal["split", "merge"]
    parcel_ids: list[str] = Field(min_length=1, max_length=20)
    split_line: dict | None = None
    names: list[str] = Field(default_factory=list, max_length=20)
    crop: str | None = Field(default=None, max_length=200)
    greenhouse: bool | None = None
    note: str = Field(default="", max_length=4000)
    reference: FieldReference | None = None


class ProposalEdit(StrictModel):
    expected_revision: int = Field(ge=1)
    expected_farm_revision: int = Field(ge=1)
    parcel: Parcel | None = None
    note: str | None = Field(default=None, max_length=4000)
    reference: FieldReference | None = None


class DiscardProposal(StrictModel):
    expected_revision: int = Field(ge=1)
    note: str = Field(default="Set aside by the user before applying.", max_length=4000)


class Approval(StrictModel):
    expected_revision: int = Field(ge=1)
    expected_farm_revision: int = Field(ge=1)
    note: str = Field(default="", max_length=4000)
    accept_overlap: bool = False


@router.get("/farms/{farm_id}/fields")
def fields(farm_id: str, include_retired: bool = False, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", farm_id)
        items = []
        for parcel in (farm_parcels(farm) if include_retired else active_parcels(farm)):
            try:
                summary = geometry_summary(parcel.get("geometry"))
            except ApiError as exc:
                summary = {"bbox": None, "approximate_area_ha": None, "warnings": ["Stored outline needs correction: " + exc.message]}
            items.append({**parcel, "geometry_summary": summary, "approximate_area_ha": summary["approximate_area_ha"]})
        return {"farm_id": farm["id"], "revision": farm["revision"], "items": items,
                "meaning": "Private farmer-supplied field records; no official LPIS registration or submission."}


@router.get("/farms/{farm_id}/field-proposals")
def proposals(farm_id: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        fetch_record(conn, "farms", farm_id)
        return list_records(conn, "field_change_proposals", limit, offset, farm_id)


@router.post("/farms/{farm_id}/field-proposals")
def propose(farm_id: str, body: Proposal, session: Session = Depends(require_session), retry_key: str | None = Header(None, alias="Idempotency-Key")):
    with transaction(session) as conn:
        return idempotent(conn, retry_key, "field-proposal", {"farm_id": farm_id, **body.model_dump(mode="json")},
            lambda: create_proposal_in_transaction(conn, farm_id, body, session))


def reference_data(reference):
    if reference is None:
        return None
    data = reference.model_dump(mode="json")
    if data.get("geometry") is not None:
        data["geometry"] = validate_geometry(data["geometry"])
    data["geometry_summary"] = geometry_summary(data.get("geometry"))
    data["meaning"] = "Supplied comparison reference; freshness, authority acceptance and ownership have not been established."
    return data


def comparison_data(previous, proposed, reference=None):
    def describe(parcel):
        try:
            summary = geometry_summary(parcel.get("geometry"))
        except ApiError as exc:
            summary = {"approximate_area_ha": None, "bbox": None, "warnings": ["The earlier stored outline needs correction: " + exc.message]}
        return {"id": parcel.get("id"), "name": parcel.get("name"), "crop": parcel.get("crop"),
                "external_id": parcel.get("external_id"), "revision": parcel.get("revision", 0),
                "geometry_summary": summary}
    before, after = [describe(p) for p in previous], [describe(p) for p in proposed]
    old_area = sum(p["geometry_summary"]["approximate_area_ha"] or 0 for p in before)
    new_area = sum(p["geometry_summary"]["approximate_area_ha"] or 0 for p in after)
    known = all(p["geometry_summary"]["approximate_area_ha"] is not None for p in before + after)
    return {"before": before, "after": after, "approximate_area_change_ha": round(new_area - old_area, 5) if known else None,
            "reference": reference, "meaning": "Approximate outline comparison only; not eligible area or an official correction decision."}


def proposal_data(farm, previous, parcels, operation, note, session, reference=None, split_line=None):
    reference = reference_data(reference)
    excluded = {p["id"] for p in previous}
    neighbours = [p for p in active_parcels(farm) if p["id"] not in excluded]
    overlapping = []
    for parcel in parcels:
        overlapping.extend(overlaps(parcel, neighbours))
    warnings = []
    for parcel in parcels:
        warnings.extend(geometry_summary(parcel.get("geometry"))["warnings"])
    if overlapping:
        warnings.append("The proposed outline overlaps another active field. Review the overlap before confirming.")
    return {"farm_id": farm["id"], "base_farm_revision": farm["revision"], "operation": operation,
        "parcel": parcels[0], "parcels": parcels, "previous_parcel": previous[0] if previous else None,
        "previous_parcels": previous, "geometry_summary": geometry_summary(parcels[0].get("geometry")),
        "reference": reference, "comparison": comparison_data(previous, parcels, reference),
        "lineage": {"operation": operation, "parents": [{"id": p["id"], "revision": p.get("revision", 0)} for p in previous],
                    "children": [p["id"] for p in parcels]}, "split_line": split_line,
        "overlapping_fields": overlapping, "warnings": list(dict.fromkeys(warnings)), "status": "proposed", "note": note,
        "proposed_by": str(session.user_id), "meaning": "Saved private field correction draft. It has not changed an official LPIS record or been submitted to an authority."}


def prepare_field_proposal(conn, farm_id, body: Proposal, session, *, generated_id=None):
    """Validate a single proposed field change without committing or applying it."""
    farm = fetch_record(conn, "farms", farm_id)
    if farm["revision"] != body.expected_revision:
        raise ApiError(409, "revision_conflict", "The farm changed. Reload its fields before proposing this change.")
    old = find_parcel(farm, body.parcel.id) if body.parcel.id else None
    if old and old.get("active") is False:
        raise ApiError(409, "field_retired", "This old field has been replaced. Select one of its current fields instead.")
    parcel = {**(old or {}), **body.parcel.model_dump(mode="json", exclude_unset=True)}
    if generated_id is not None:
        try:
            generated_id = str(UUID(str(generated_id)))
        except (ValueError, TypeError) as exc:
            raise ApiError(422, "invalid_proposal_identifier", "This retained field proposal identifier is invalid.") from exc
        if old is None and any(p["id"] == generated_id for p in farm_parcels(farm)):
            raise ApiError(409, "field_identifier_exists", "This proposed field already exists. Reload its current record.")
    parcel["id"] = parcel.get("id") or generated_id or str(uuid4())
    if not parcel["name"].strip():
        invalid("Give the field a familiar name.")
    if parcel.get("geometry") is not None:
        parcel["geometry"] = validate_geometry(parcel["geometry"])
        from .geometry import checked_shape
        checked_shape(parcel["geometry"])
    return proposal_data(farm, [old] if old else [], [parcel], "edit" if old else "create", body.note, session, body.reference)


def create_proposal_in_transaction(conn, farm_id, body: Proposal, session):
    return insert_record(conn, "field_change_proposals", prepare_field_proposal(conn, farm_id, body, session))


@router.post("/farms/{farm_id}/field-proposals/transform")
def transform(farm_id: str, body: Transformation, session: Session = Depends(require_session), retry_key: str | None = Header(None, alias="Idempotency-Key")):
    from .geometry import split_outline, merge_outlines
    with transaction(session) as conn:
        def create():
            farm = fetch_record(conn, "farms", farm_id)
            if farm["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "The farm changed. Reload its fields before preparing this change.")
            if len(set(body.parcel_ids)) != len(body.parcel_ids):
                raise ApiError(422, "duplicate_field", "Select each field only once.")
            previous = [find_parcel(farm, field_id) for field_id in body.parcel_ids]
            if any(p.get("active") is False or not p.get("geometry") for p in previous):
                raise ApiError(422, "field_outline_required", "Choose current fields with recorded boundaries.")
            if body.operation == "split":
                if len(previous) != 1:
                    raise ApiError(422, "split_selection", "Choose one field to divide.")
                geometries = split_outline(previous[0]["geometry"], body.split_line)
            else:
                geometries = [merge_outlines([p["geometry"] for p in previous])]
            if body.names and (len(body.names) != len(geometries) or any(not name.strip() or len(name) > 200 for name in body.names)):
                raise ApiError(422, "field_names_required", "Give each resulting field a short, familiar name.")
            if body.operation == "merge" and len({p.get("crop") for p in previous}) > 1 and "crop" not in body.model_fields_set:
                raise ApiError(422, "crop_review_required", "The selected fields have different crops. Choose the joined field's crop, or explicitly leave it unknown.")
            if body.operation == "merge" and len({p.get("greenhouse", False) for p in previous}) > 1 and body.greenhouse is None:
                raise ApiError(422, "cover_review_required", "Some fields are under cover. Choose whether the joined field is a greenhouse.")
            parcels = [{"id": str(uuid4()), "name": body.names[index] if body.names else f"{previous[0]['name']} — part {index + 1}" if body.operation == "split" else " + ".join(p["name"] for p in previous)[:200],
                        "geometry": geometry, "point": None, "crop": body.crop if "crop" in body.model_fields_set else previous[0].get("crop"),
                        "greenhouse": body.greenhouse if body.greenhouse is not None else previous[0].get("greenhouse", False),
                        "external_id": None, "notes": body.note} for index, geometry in enumerate(geometries)]
            data = proposal_data(farm, previous, parcels, body.operation, body.note, session, body.reference, body.split_line)
            if body.operation == "merge":
                from .geometry import exact_overlap
                source_overlaps = [p for index, p in enumerate(previous) if any(exact_overlap(p["geometry"], other["geometry"]) for other in previous[:index])]
                if source_overlaps:
                    data["overlapping_fields"].extend({"id": p["id"], "name": p["name"]} for p in source_overlaps)
                    data["warnings"].append("Some selected fields already overlap. The joined area counts their shared ground once; review that reduction explicitly.")
            data["warnings"].append("Parent fields and their past work remain in history. New fields have no official reference until you supply one.")
            return insert_record(conn, "field_change_proposals", data)
        return idempotent(conn, retry_key, "field-transform", {"farm_id": farm_id, **body.model_dump(mode="json")}, create)


@router.patch("/field-proposals/{proposal_id}")
def edit_proposal(proposal_id: str, body: ProposalEdit, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "field_change_proposals", proposal_id)
        data = record["data"]
        farm = fetch_record(conn, "farms", data["farm_id"])
        if data.get("status") != "proposed" or data.get("operation", "edit") not in {"edit", "create"}:
            raise ApiError(409, "proposal_not_editable", "Prepare a fresh split or join draft instead of changing an already reviewed proposal.")
        if farm["revision"] != body.expected_farm_revision or farm["revision"] != data["base_farm_revision"]:
            raise ApiError(409, "revision_conflict", "The farm changed. Reload and prepare a fresh field change.")
        parcel = {**data["parcel"], **body.parcel.model_dump(mode="json", exclude_unset=True)} if body.parcel else deepcopy(data["parcel"])
        if not parcel.get("name", "").strip():
            invalid("Give the field a familiar name.")
        parcel["id"] = data["parcel"]["id"]
        if parcel.get("geometry") is not None:
            parcel["geometry"] = validate_geometry(parcel["geometry"])
            from .geometry import checked_shape
            checked_shape(parcel["geometry"])
        reference = body.reference if "reference" in body.model_fields_set else FieldReference.model_validate({k: v for k, v in (data.get("reference") or {}).items() if k in FieldReference.model_fields}) if data.get("reference") else None
        updated = proposal_data(farm, data.get("previous_parcels", [data["previous_parcel"]] if data.get("previous_parcel") else []),
            [parcel], data.get("operation", "edit"), body.note if body.note is not None else data.get("note", ""), session, reference)
        return update_record(conn, "field_change_proposals", proposal_id, body.expected_revision, updated)


def kml_proposal(record, parcels):
    """Serialize a private polygon snapshot without altering saved outlines."""
    data = record["data"]
    normalized = []
    if not parcels:
        raise ApiError(422, "boundary_required", "Add a polygon boundary for every exported field before downloading KML.")
    for parcel in parcels:
        try:
            geometry = validate_geometry(parcel.get("geometry"))
        except ApiError as exc:
            raise ApiError(422, "boundary_required", "Every exported field needs a valid polygon boundary; a location point is not a boundary. " + exc.message,
                           {"parcel_id": parcel.get("id")}) from exc
        normalized.append((parcel, geometry))

    def element(parent, tag, text=None):
        node = ElementTree.SubElement(parent, f"{{{KML_NAMESPACE}}}{tag}")
        if text is not None:
            text = str(text)
            if any(not (ord(char) in (9, 10, 13) or 0x20 <= ord(char) <= 0xD7FF
                        or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF) for char in text):
                raise ApiError(422, "invalid_export_text", "A field name, crop or reference contains text that XML cannot represent. Correct that text before exporting KML.")
            node.text = text
        return node

    def polygon(parent, rings):
        shape = element(parent, "Polygon")
        element(shape, "altitudeMode", "clampToGround")
        for index, original in enumerate(rings):
            signed_area = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(original, original[1:]))
            # KML's exterior is counterclockwise and holes are clockwise.
            ring = original if (signed_area > 0) == (index == 0) else list(reversed(original))
            boundary = element(shape, "outerBoundaryIs" if index == 0 else "innerBoundaryIs")
            linear = element(boundary, "LinearRing")
            element(linear, "coordinates", " ".join(f"{lon},{lat}" for lon, lat in ring))

    root = ElementTree.Element(f"{{{KML_NAMESPACE}}}kml")
    document = element(root, "Document")
    element(document, "name", "Private field boundary snapshot")
    description = "Private farmer-supplied boundary snapshot for manual review. Not a filing, official LPIS update, ownership proof or eligible-area decision. No submission has been made."
    element(document, "description", description)
    reference = data.get("reference") or {}
    for parcel, geometry in normalized:
        placemark = element(document, "Placemark")
        element(placemark, "name", parcel.get("name") or parcel.get("id"))
        element(placemark, "description", description)
        extended = element(placemark, "ExtendedData")
        metadata = {"parcel_id": parcel.get("id"), "name": parcel.get("name"), "crop": parcel.get("crop"),
                    "external_id": parcel.get("external_id"), "proposal_id": record["id"],
                    "proposal_revision": record["revision"], "status": data.get("status"),
                    "reference_source": reference.get("source"), "reference_external_id": reference.get("external_id"),
                    "reference_crop": reference.get("crop"), "reference_year": reference.get("year")}
        for key, value in metadata.items():
            entry = element(extended, "Data")
            entry.set("name", key)
            element(entry, "value", "" if value is None else value)
        parent = element(placemark, "MultiGeometry") if geometry["type"] == "MultiPolygon" else placemark
        for part in polygons(geometry):
            polygon(parent, part)
    return ElementTree.tostring(root, encoding="utf-8", xml_declaration=True)


@router.get("/field-proposals/{proposal_id}/export")
def export_proposal(proposal_id: str, format: Literal["geojson", "correction", "kml"] = "geojson", session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "field_change_proposals", proposal_id)
        data = record["data"]
        parcels = data.get("parcels", [data["parcel"]])
        if format == "kml":
            return Response(kml_proposal(record, parcels), media_type="application/vnd.google-earth.kml+xml",
                headers={"Content-Disposition": 'attachment; filename="field-correction-draft.kml"', "Cache-Control": "private, no-store"})
        if format == "geojson":
            result = {"type": "FeatureCollection", "name": "Private field correction draft", "features": [
                {"type": "Feature", "id": p["id"], "geometry": p.get("geometry"), "properties": {"name": p.get("name"),
                    "crop": p.get("crop"), "external_id": p.get("external_id"), "proposal_id": record["id"], "status": data["status"],
                    "meaning": "Farmer-supplied private outline; not an official LPIS update."}} for p in parcels]}
            media, filename = "application/geo+json", "field-correction-draft.geojson"
        else:
            result = {"title": "Field correction draft for manual authority handoff", "proposal_id": record["id"],
                "proposal_revision": record["revision"], "base_farm_revision": data["base_farm_revision"],
                "status": data["status"], "operation": data.get("operation", "edit"), "previous_parcels": data.get("previous_parcels", []),
                "proposed_parcels": parcels, "comparison": data.get("comparison"), "lineage": data.get("lineage"),
                "note": data.get("note"), "warnings": data.get("warnings", []),
                "handoff": "Review this draft with your adviser or national authority using their accepted process. This file has not been submitted and does not alter LPIS or prove eligible area."}
            media, filename = "application/json", "field-correction-handoff.json"
        return Response(json.dumps(result, ensure_ascii=False, indent=2), media_type=media,
            headers={"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "private, no-store"})


@router.post("/field-proposals/{proposal_id}/discard")
def discard_proposal(proposal_id: str, body: DiscardProposal, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "field_change_proposals", proposal_id)
        data = record["data"]
        if data.get("proposed_by") != str(session.user_id):
            require_roles(session, "owner", "adviser")
        if data.get("status") != "proposed":
            raise ApiError(409, "proposal_reviewed", "Only an unapplied proposal can be set aside.")
        return update_record(conn, "field_change_proposals", proposal_id, body.expected_revision,
            {**data, "status": "discarded", "discard_note": body.note, "discarded_by": str(session.user_id),
             "discarded_at": datetime.now(timezone.utc).isoformat()})


@router.post("/field-proposals/{proposal_id}/approve")
def approve(proposal_id: str, body: Approval, session: Session = Depends(require_session), retry_key: str | None = Header(None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    with transaction(session) as conn:
        def apply():
            record = fetch_record(conn, "field_change_proposals", proposal_id)
            data = record["data"]
            if data.get("status") != "proposed":
                raise ApiError(409, "proposal_reviewed", "This field change has already been reviewed.")
            farm = fetch_record(conn, "farms", data["farm_id"])
            if farm["revision"] != body.expected_farm_revision or farm["revision"] != data["base_farm_revision"]:
                raise ApiError(409, "revision_conflict", "The farm changed after this proposal. Compare and create a fresh proposal.")
            parcels = deepcopy(data.get("parcels", [data["parcel"]]))
            items = farm_parcels(farm)
            operation = data.get("operation", "edit")
            parents = data.get("previous_parcels", [data["previous_parcel"]] if data.get("previous_parcel") else [])
            parent_ids = {p["id"] for p in parents}
            neighbours = [p for p in active_parcels(farm) if p["id"] not in parent_ids]
            overlap = [other for parcel in parcels for other in overlaps(parcel, neighbours)]
            if operation == "merge":
                from .geometry import exact_overlap
                overlap.extend({"id": p["id"], "name": p["name"]} for index, p in enumerate(parents)
                    if any(exact_overlap(p["geometry"], other["geometry"]) for other in parents[:index]))
            if overlap and not body.accept_overlap:
                raise ApiError(422, "overlap_review_required", "Review and explicitly acknowledge the overlapping field outlines.", {"overlapping_fields": overlap})
            reviewed_at = datetime.now(timezone.utc).isoformat()
            for parcel in parcels:
                geometry_summary(parcel.get("geometry"))
                previous = next((p for p in items if p["id"] == parcel["id"]), None)
                parcel.update(revision=(previous or {}).get("revision", 0) + 1, reviewed_at=reviewed_at,
                              reviewed_by=str(session.user_id), active=True,
                              lineage={"operation": operation, "proposal_id": record["id"],
                                       "parents": [{"id": p["id"], "revision": p.get("revision", 0)} for p in parents]})
            if operation in {"split", "merge"}:
                items = [{**p, "active": False, "retired_at": reviewed_at, "retired_by_proposal": record["id"],
                          "successor_ids": [parcel["id"] for parcel in parcels]} if p["id"] in parent_ids else p for p in items]
            replacing_ids = {p["id"] for p in parcels}
            items = [p for p in items if p["id"] not in replacing_ids] + parcels
            if len(items) > 2000:
                raise ApiError(422, "field_limit", "This farm reached its limit of 2,000 current and historical field entries.")
            saved_farm = update_record(conn, "farms", farm["id"], body.expected_farm_revision, {**farm["data"], "parcels": items})
            saved_proposal = update_record(conn, "field_change_proposals", record["id"], body.expected_revision,
                {**data, "status": "approved", "parcel": parcels[0], "parcels": parcels,
                 "review_note": body.note, "reviewed_by": str(session.user_id), "reviewed_at": reviewed_at,
                 "overlap_acknowledged": body.accept_overlap, "result_farm_revision": saved_farm["revision"]})
            return {"farm": saved_farm, "proposal": saved_proposal}
        return idempotent(conn, retry_key, "field-approval", {"id": proposal_id, **body.model_dump()}, apply)
