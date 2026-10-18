"""Bounded public reads of official SIGPAC recintos (FEGA, Spain), for map context only.

Geometry comes from FEGA's documented vector-tile service and parcel facts from its
documented query service, both published as open data under CC BY 4.0. Only reviewed
attributes are kept. The declared-crop layer is never read: it carries the aid file
number that links a holding's parcels. Public references do not establish ownership,
current use, eligible area or any payment decision; the paying agency decides those.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import json
import math
import os
from pathlib import Path
import time

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import Response

from .models import ApiError
from .security import Session, require_session

router = APIRouter(tags=["sigpac reference"])
HUB = "https://sigpac-hubcloud.es"
TILE_ZOOM = 15  # The service offers whole-recinto GeoJSON tiles at this level only.
TILE_PATHS = {"current": "/mvt/recinto@3857@geojson", "previous": "/mvt/anterior/recinto@3857@geojson"}
DOCS = HUB + "/html/mvt/descServicio.html"
QUERY_DOCS = HUB + "/html/csp/descServicio.html"
CATALOG = "https://datos.gob.es/es/catalogo/e0dat0002-recintos-del-sistema-de-informacion-geografica-de-parcelas-agricolas-sigpac-espana"
LICENSE = "https://creativecommons.org/licenses/by/4.0/"
ATTRIBUTION = "Recintos SIGPAC © Fondo Español de Garantía Agraria (FEGA), CC BY 4.0"
REFERENCE_KEYS = ("provincia", "municipio", "agregado", "zona", "poligono", "parcela", "recinto")
TILE_KEYS = REFERENCE_KEYS + ("uso_sigpac", "pendiente_media", "altitud", "coef_regadio", "incidencias", "region")
FACT_KEYS = REFERENCE_KEYS + ("superficie", "admisibilidad", "uso_sigpac", "incidencias", "coef_regadio", "pendiente_media", "altitud", "region")
SPAIN = (-19.0, 27.0, 5.0, 44.0)  # Extent published for the recinto collection.
MAX_TILES = 64
MAX_TILE_BYTES = 6_000_000
CACHE_SECONDS = 24 * 3600
EARTH = 6378137.0
HEADERS = {"Accept": "application/geo+json, application/json", "User-Agent": "FunkyFarm/0.1 public-parcel-reader"}


def cache_root():
    root = Path(os.environ.get("FUNKYFARM_STORAGE_ROOT", "runtime/documents")) / "public-cache" / "sigpac"
    root.mkdir(parents=True, exist_ok=True)
    return root


def tiles_for(bbox):
    west, south, east, north = bbox
    n = 2 ** TILE_ZOOM

    def tile(lon, lat):
        x = int((lon + 180) / 360 * n)
        y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
        return min(max(x, 0), n - 1), min(max(y, 0), n - 1)

    (x0, y0), (x1, y1) = tile(west, north), tile(east, south)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def read_tile(client, campaign, x, y):
    path = cache_root() / campaign / f"{TILE_ZOOM}-{x}-{y}.geojson"
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_SECONDS:
        return json.loads(path.read_bytes())
    url = f"{HUB}{TILE_PATHS[campaign]}/{TILE_ZOOM}/{x}/{y}.geojson"
    try:
        with client.stream("GET", url, headers=HEADERS) as response:
            if response.status_code == 404:
                return {"type": "FeatureCollection", "features": []}
            if response.status_code != 200:
                raise ApiError(502, "official_read_failed", "FEGA did not return the SIGPAC parcels for this area. Try again later.", {"status": response.status_code})
            content = bytearray()
            for chunk in response.iter_bytes():
                content.extend(chunk)
                if len(content) > MAX_TILE_BYTES:
                    raise ApiError(502, "official_response_large", "The official SIGPAC response was larger than expected.")
        result = json.loads(content)
    except (httpx.HTTPError, ValueError):
        raise ApiError(502, "official_read_failed", "FEGA's SIGPAC service could not be read safely. Try again later.") from None
    if not isinstance(result, dict) or not isinstance(result.get("features"), list):
        raise ApiError(502, "official_schema_changed", "The SIGPAC tile no longer matches the implemented schema.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".part")
    temporary.write_bytes(json.dumps(result).encode())
    temporary.replace(path)
    return result


def to_lonlat(point):
    x, y = point[0], point[1]
    return [round(math.degrees(x / EARTH), 7), round(math.degrees(2 * math.atan(math.exp(y / EARTH)) - math.pi / 2), 7)]


def converted(geometry):
    kind = geometry.get("type") if isinstance(geometry, dict) else None
    coordinates = geometry.get("coordinates") if kind else None
    if kind == "Polygon" and isinstance(coordinates, list):
        return {"type": "Polygon", "coordinates": [[to_lonlat(p) for p in ring] for ring in coordinates]}
    if kind == "MultiPolygon" and isinstance(coordinates, list):
        return {"type": "MultiPolygon", "coordinates": [[[to_lonlat(p) for p in ring] for ring in poly] for poly in coordinates]}
    return None


def reference_of(properties):
    values = [properties.get(key) for key in REFERENCE_KEYS]
    if any(value is None or not str(value).strip().lstrip("-").isdigit() for value in values):
        return None
    return ":".join(str(int(value)) for value in values)


def area_ha(geometry):
    # Same spherical Lambert equal-area method as fields.geometry_summary, without its editing
    # limits (official recintos can exceed the vertex limits set for hand-drawn outlines).
    parts = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    points = [p for poly in parts for ring in poly for p in ring]
    if len(points) < 4:
        return None
    lon0 = math.radians((min(p[0] for p in points) + max(p[0] for p in points)) / 2)
    lat0 = math.radians((min(p[1] for p in points) + max(p[1] for p in points)) / 2)

    def project(point):
        lon, lat = map(math.radians, point[:2])
        k = math.sqrt(2 / (1 + math.sin(lat0) * math.sin(lat) + math.cos(lat0) * math.cos(lat) * math.cos(lon - lon0)))
        return (6371008.8 * k * math.cos(lat) * math.sin(lon - lon0),
                6371008.8 * k * (math.cos(lat0) * math.sin(lat) - math.sin(lat0) * math.cos(lat) * math.cos(lon - lon0)))

    def ring_area(ring):
        projected = [project(point) for point in ring]
        return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(projected, projected[1:] + projected[:1]))) / 2
    total = sum(ring_area(poly[0]) - sum(ring_area(hole) for hole in poly[1:]) for poly in parts if poly)
    return round(total / 10000, 5)


def checked_bbox(bbox: str):
    try:
        values = [float(part) for part in bbox.split(",")]
    except ValueError:
        values = []
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        raise ApiError(422, "invalid_bbox", "Use four longitude/latitude numbers: west,south,east,north.")
    west, south, east, north = values
    if not (SPAIN[0] <= west < east <= SPAIN[2] and SPAIN[1] <= south < north <= SPAIN[3]):
        raise ApiError(422, "invalid_bbox", "SIGPAC covers Spain only. Move the map to a Spanish area.")
    tiles = tiles_for(values)
    if len(tiles) > MAX_TILES:
        raise ApiError(422, "area_too_large", "Zoom in to see SIGPAC parcels; this view covers too large an area.", {"tiles": len(tiles), "max_tiles": MAX_TILES})
    return values, tiles


def compressed(request: Request, payload):
    body = json.dumps(payload, separators=(",", ":")).encode()
    headers = {"Cache-Control": "private, max-age=600", "Vary": "Accept-Encoding"}
    if "gzip" in request.headers.get("accept-encoding", ""):
        return Response(gzip.compress(body, 6), media_type="application/geo+json", headers={**headers, "Content-Encoding": "gzip"})
    return Response(body, media_type="application/geo+json", headers=headers)


@router.get("/sigpac/recintos")
def recintos(request: Request, bbox: str = Query(..., max_length=120), campaign: str = Query("current", pattern="^(current|previous)$"),
             session: Session = Depends(require_session)):
    values, tiles = checked_bbox(bbox)
    with httpx.Client(timeout=httpx.Timeout(20, connect=5), follow_redirects=False, trust_env=False) as client:
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda tile: read_tile(client, campaign, *tile), tiles))
    west, south, east, north = values
    seen, features = set(), []
    for result in results:
        for feature in result["features"]:
            properties = feature.get("properties") if isinstance(feature, dict) else None
            if not isinstance(properties, dict):
                continue
            reference = reference_of(properties)
            geometry = converted(feature.get("geometry"))
            if not reference or reference in seen or not geometry:
                continue
            points = [p for ring in (geometry["coordinates"] if geometry["type"] == "Polygon" else [r for poly in geometry["coordinates"] for r in poly]) for p in ring]
            if max(p[0] for p in points) < west or min(p[0] for p in points) > east or max(p[1] for p in points) < south or min(p[1] for p in points) > north:
                continue
            seen.add(reference)
            kept = {key: properties.get(key) for key in TILE_KEYS}
            features.append({"type": "Feature", "id": reference, "geometry": geometry,
                             "properties": {**kept, "reference": reference, "approximate_area_ha": area_ha(geometry)}})
    # Largest first, so drawing in order keeps small recintos on top (Bo's map rule).
    features.sort(key=lambda feature: -(feature["properties"]["approximate_area_ha"] or 0))
    return compressed(request, {
        "type": "FeatureCollection", "features": features, "campaign": campaign,
        "source": {"service": HUB + TILE_PATHS[campaign] + "/{z}/{x}/{y}.geojson", "documentation": DOCS, "catalog": CATALOG,
                   "license": LICENSE, "attribution": ATTRIBUTION, "zoom": TILE_ZOOM, "tiles": len(tiles),
                   "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
        "notice": "Public SIGPAC references for map context. They do not show ownership, the crop actually grown, "
                  "eligible area or a payment decision; the paying agency decides those.",
    })


@router.get("/sigpac/parcelas/{provincia}/{municipio}/{agregado}/{zona}/{poligono}/{parcela}")
def parcela_facts(provincia: int, municipio: int, agregado: int, zona: int, poligono: int, parcela: int,
                  session: Session = Depends(require_session)):
    parts = [provincia, municipio, agregado, zona, poligono, parcela]
    if not all(0 <= part <= 99999 for part in parts):
        raise ApiError(422, "invalid_reference", "Use the numeric parts of a SIGPAC reference.")
    url = f"{HUB}/servicioconsultassigpac/query/recinfoparc/{'/'.join(str(part) for part in parts)}.json"
    path = cache_root() / "facts" / ("-".join(str(part) for part in parts) + ".json")
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_SECONDS:
        rows = json.loads(path.read_bytes())
    else:
        try:
            with httpx.Client(timeout=httpx.Timeout(15, connect=5), follow_redirects=False, trust_env=False) as client:
                response = client.get(url, headers=HEADERS)
            if response.status_code != 200 or len(response.content) > 2_000_000:
                raise ApiError(502, "official_read_failed", "FEGA did not return the parcel facts. Try again later.", {"status": response.status_code})
            rows = response.json()
        except (httpx.HTTPError, ValueError):
            raise ApiError(502, "official_read_failed", "FEGA's SIGPAC query service could not be read safely.") from None
        if not isinstance(rows, list):
            raise ApiError(502, "official_schema_changed", "The SIGPAC parcel facts no longer match the implemented schema.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(json.dumps(rows).encode())

    def value(row, key):
        raw = row.get(key)
        if raw in (None, "", "None"):
            return None
        if key in ("incidencias", "uso_sigpac"):
            return str(raw)
        try:  # FEGA publishes numbers as text; incidence codes stay text.
            number = float(raw)
        except (TypeError, ValueError):
            return None
        return int(number) if number.is_integer() and key not in ("superficie", "pendiente_media", "coef_regadio") else number

    items = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        kept = {key: value(row, key) for key in FACT_KEYS}
        kept["reference"] = reference_of(kept)
        items.append(kept)
    return {"items": items, "source": {"url": url, "documentation": QUERY_DOCS, "license": LICENSE, "attribution": ATTRIBUTION},
            "notice": "Published SIGPAC facts. The paying agency decides eligibility and payment; "
                      "incidence codes are shown as published and their meaning is not inferred here."}


# Landscape elements (hedges, walls, tree rows, ponds...) from FEGA's OGC API, for the easy form.
ELEMENT_COLLECTIONS = {"area": "elementos_paisaje_area", "line": "elementos_paisaje_linea", "point": "elementos_paisaje_punto"}
# Official code lists: codigossigpac/cod_tipo_e_paisaje{,_linea,_punto}.json (retrieved 18 October 2026).
ELEMENT_NAMES = {
    "area": {"AG": "Árboles en grupo", "AL": "Árboles en hilera", "AP": "Árboles aislados", "CH": "Charcas, lagunas y pequeños humedales",
             "CO": "Pequeñas construcciones de arquitectura tradicional", "IS": "Islas o enclaves de vegetación natural o roca"},
    "line": {"AL": "Árboles en hilera", "LD": "Lindes", "MU": "Muros de piedra", "ST": "Setos", "TR": "Terrazas"},
    "point": {"AP": "Árboles aislados"},
}
ELEMENT_DOCS = HUB + "/html/ogc-api/descServicio.html"


def _metres(a, b):
    lat = math.radians((a[1] + b[1]) / 2)
    return math.hypot(math.radians(b[0] - a[0]) * math.cos(lat), math.radians(b[1] - a[1])) * 6371008.8


@router.get("/sigpac/elementos")
def elementos(bbox: str = Query(..., max_length=120), session: Session = Depends(require_session)):
    values, _ = checked_bbox(bbox)
    west, south, east, north = values
    if (east - west) * (north - south) > 0.0025:
        raise ApiError(422, "area_too_large", "Choose a smaller area to read landscape elements.")
    key = "-".join(f"{value:.4f}" for value in values)
    path = cache_root() / "elements" / f"{key}.json"
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_SECONDS:
        return json.loads(path.read_bytes())
    features, truncated = [], False
    with httpx.Client(timeout=httpx.Timeout(20, connect=5), follow_redirects=False, trust_env=False) as client:
        for kind, collection in ELEMENT_COLLECTIONS.items():
            url = f"{HUB}/ogcapi/collections/{collection}/items"
            try:
                response = client.get(url, params={"f": "json", "limit": 200, "bbox": ",".join(f"{value:.6f}" for value in values)}, headers=HEADERS)
                if response.status_code != 200 or len(response.content) > MAX_TILE_BYTES:
                    raise ApiError(502, "official_read_failed", "FEGA did not return the landscape elements. Try again later.", {"status": response.status_code})
                result = response.json()
            except (httpx.HTTPError, ValueError):
                raise ApiError(502, "official_read_failed", "FEGA's landscape elements could not be read safely.") from None
            if not isinstance(result, dict) or not isinstance(result.get("features"), list):
                raise ApiError(502, "official_schema_changed", "The landscape elements no longer match the implemented schema.")
            truncated = truncated or any(link.get("rel") == "next" for link in result.get("links", []) if isinstance(link, dict))
            for feature in result["features"]:
                properties = feature.get("properties") if isinstance(feature, dict) else None
                geometry = feature.get("geometry") if isinstance(feature, dict) else None
                if not isinstance(properties, dict) or not isinstance(geometry, dict):
                    continue
                code = str(properties.get("tipo_elemento") or "").upper()
                kept = {"kind": kind, "code": code, "name": ELEMENT_NAMES[kind].get(code, "Elemento del paisaje"), "id": properties.get("dn_pk")}
                if geometry.get("type") == "LineString":
                    points = geometry.get("coordinates") or []
                    kept["length_m"] = round(sum(_metres(a, b) for a, b in zip(points, points[1:])), 1)
                elif geometry.get("type") == "MultiLineString":
                    kept["length_m"] = round(sum(_metres(a, b) for line in geometry.get("coordinates") or [] for a, b in zip(line, line[1:])), 1)
                features.append({"type": "Feature", "geometry": geometry, "properties": kept})
    payload = {"type": "FeatureCollection", "features": features, "truncated": truncated,
               "source": {"documentation": ELEMENT_DOCS, "license": LICENSE, "attribution": "Elementos del paisaje SIGPAC © FEGA, CC BY 4.0",
                          "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
               "notice": "Published landscape elements. Whether one counts towards a scheme is decided by the paying agency."}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(payload).encode())
    return payload
