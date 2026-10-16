"""Bounded GEOS topology operations on supplied field outlines."""

import json

from .models import ApiError


def engine():
    try:
        from shapely.geometry import shape, mapping, LineString
        from shapely.ops import split, unary_union
        from shapely.validation import explain_validity
    except ImportError as exc:
        raise ApiError(503, "boundary_tools_unavailable", "The local boundary tools are not installed. Existing field records are still available.") from exc
    return shape, mapping, LineString, split, unary_union, explain_validity


def checked_shape(geometry):
    from .fields import validate_geometry
    shape, _, _, _, _, explain = engine()
    value = shape(validate_geometry(geometry))
    if value.is_empty or not value.is_valid:
        raise ApiError(422, "invalid_geometry", "Review the outline before continuing: " + explain(value))
    return value


def outline(value):
    from .fields import validate_geometry
    _, mapping, _, _, _, _ = engine()
    if value.geom_type not in {"Polygon", "MultiPolygon"} or value.is_empty:
        raise ApiError(422, "invalid_geometry_result", "The selected change did not produce a usable field outline.")
    return validate_geometry(json.loads(json.dumps(mapping(value))))


def split_outline(geometry, line):
    from .fields import coordinate
    _, _, LineString, split, _, _ = engine()
    if not isinstance(line, dict) or line.get("type") != "LineString" or set(line) - {"type", "coordinates"}:
        raise ApiError(422, "invalid_split_line", "Draw a dividing line across the field.")
    positions = line.get("coordinates")
    if not isinstance(positions, list) or not 2 <= len(positions) <= 100:
        raise ApiError(422, "invalid_split_line", "Use between 2 and 100 points for the dividing line.")
    positions = [coordinate(p) for p in positions]
    cutter = LineString(positions)
    if not cutter.is_simple or cutter.length == 0:
        raise ApiError(422, "invalid_split_line", "The dividing line must not cross itself or repeat a point.")
    source = checked_shape(geometry)
    if source.contains(LineString(positions).boundary):
        raise ApiError(422, "split_line_too_short", "Extend the dividing line beyond both edges of the field.")
    try:
        pieces = [part for part in split(source, cutter).geoms if part.geom_type == "Polygon" and part.area > 0]
    except (ValueError, TypeError) as exc:
        raise ApiError(422, "invalid_split_line", "The dividing line follows an edge. Move it across the field instead.") from exc
    if not 2 <= len(pieces) <= 20:
        raise ApiError(422, "split_did_not_divide", "Draw a line that divides the field into 2 to 20 parts.")
    # The union must preserve exactly the parent's supplied footprint.
    _, _, _, _, union, _ = engine()
    if source.symmetric_difference(union(pieces)).area > max(1e-14, source.area * 1e-8):
        raise ApiError(422, "split_area_changed", "The split changed the field footprint. Review the line and try again.")
    return [outline(part) for part in sorted(pieces, key=lambda p: (p.centroid.x, p.centroid.y))]


def merge_outlines(geometries):
    if not 2 <= len(geometries) <= 20:
        raise ApiError(422, "merge_selection", "Choose between 2 and 20 fields to join.")
    _, _, _, _, union, _ = engine()
    sources = [checked_shape(geometry) for geometry in geometries]
    combined = union(sources)
    if combined.geom_type != "Polygon":
        raise ApiError(422, "fields_not_neighbours", "Choose fields that share an edge. Separated fields keep their own names and outlines.")
    return outline(combined)


def exact_overlap(geometry, other):
    a, b = checked_shape(geometry), checked_shape(other)
    return a.intersection(b).area > max(1e-14, min(a.area, b.area) * 1e-9)
