"""Bounded public reads of Dutch crop parcels (BRP Gewaspercelen, RVO via PDOK), for map context only.

Uses the same reviewed PDOK OGC API as the farm connection (connectors.pdok), published under the
Public Domain Mark 1.0. Only category, crop, crop code, year and status are kept. Public parcels do
not establish ownership, eligible area or any payment decision; RVO decides those.
"""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import math
import time

import httpx
from fastapi import APIRouter, Depends, Query, Request

from .connectors.pdok import DEFAULT_BASE, configured_base
from .models import ApiError
from .security import Session, require_session
from .sigpac import CACHE_SECONDS, area_ha, cache_root, compressed

router = APIRouter(tags=["brp reference"])
TILE_ZOOM = 14
MAX_TILES = 16
PAGE_LIMIT = 1000
MAX_PAGES = 4
NETHERLANDS = (3.2, 50.7, 7.3, 53.6)
KEYS = ("category", "gewas", "gewascode", "jaar", "status")
LICENSE = "https://creativecommons.org/publicdomain/mark/1.0/"
ATTRIBUTION = "BRP Gewaspercelen © RVO, via PDOK, public domain"
HEADERS = {"Accept": "application/geo+json, application/json", "User-Agent": "FunkyFarm/0.1 public-parcel-reader"}


def tile_bbox(x, y):
    n = 2 ** TILE_ZOOM
    west, east = x / n * 360 - 180, (x + 1) / n * 360 - 180
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return west, south, east, north


def tiles_for(bbox):
    west, south, east, north = bbox
    n = 2 ** TILE_ZOOM
    x = lambda lon: min(max(int((lon + 180) / 360 * n), 0), n - 1)
    y = lambda lat: min(max(int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n), 0), n - 1)
    return [(tx, ty) for tx in range(x(west), x(east) + 1) for ty in range(y(north), y(south) + 1)]


def read_tile(client, base, x, y):
    path = cache_root().parent / "brp" / f"{TILE_ZOOM}-{x}-{y}.json"
    if path.exists() and time.time() - path.stat().st_mtime < CACHE_SECONDS:
        return json.loads(path.read_bytes())
    url = base + "/collections/brpgewas/items"
    params = {"f": "json", "limit": PAGE_LIMIT, "bbox": ",".join(f"{value:.6f}" for value in tile_bbox(x, y))}
    features, truncated = [], False
    for page in range(MAX_PAGES):
        try:
            response = client.get(url, params=params, headers=HEADERS)
            if response.status_code != 200 or len(response.content) > 8_000_000:
                raise ApiError(502, "official_read_failed", "PDOK did not return the Dutch parcels for this area. Try again later.", {"status": response.status_code})
            result = response.json()
        except (httpx.HTTPError, ValueError):
            raise ApiError(502, "official_read_failed", "PDOK could not be read safely. Try again later.") from None
        if not isinstance(result, dict) or not isinstance(result.get("features"), list):
            raise ApiError(502, "official_schema_changed", "The BRP response no longer matches the implemented schema.")
        features.extend(result["features"])
        following = next((link.get("href") for link in result.get("links", []) if isinstance(link, dict) and link.get("rel") == "next"), None)
        if not following:
            break
        if page == MAX_PAGES - 1:
            truncated = True
            break
        # Follow only PDOK's own pagination on the same reviewed endpoint.
        next_url = httpx.URL(following)
        if f"{next_url.scheme}://{next_url.host}{next_url.path}" != url:
            raise ApiError(502, "official_schema_changed", "PDOK pagination pointed outside the reviewed endpoint.")
        params = dict(next_url.params)
    payload = {"features": features, "truncated": truncated}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(json.dumps(payload).encode())
    return payload


@router.get("/brp/percelen")
def percelen(request: Request, bbox: str = Query(..., max_length=120), session: Session = Depends(require_session)):
    try:
        values = [float(part) for part in bbox.split(",")]
    except ValueError:
        values = []
    if len(values) != 4 or not all(math.isfinite(v) for v in values):
        raise ApiError(422, "invalid_bbox", "Use four longitude/latitude numbers: west,south,east,north.")
    west, south, east, north = values
    if not (NETHERLANDS[0] <= west < east <= NETHERLANDS[2] and NETHERLANDS[1] <= south < north <= NETHERLANDS[3]):
        raise ApiError(422, "invalid_bbox", "BRP covers the Netherlands only. Move the map to a Dutch area.")
    tiles = tiles_for(values)
    if len(tiles) > MAX_TILES:
        raise ApiError(422, "area_too_large", "Zoom in to see Dutch parcels; this view covers too large an area.", {"tiles": len(tiles), "max_tiles": MAX_TILES})
    base = configured_base()
    if base != DEFAULT_BASE:
        raise ApiError(409, "schema_not_implemented", "This reviewed PDOK service has no implemented parcel schema yet.")
    with httpx.Client(timeout=httpx.Timeout(20, connect=5), follow_redirects=False, trust_env=False) as client:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda tile: read_tile(client, base, *tile), tiles))
    seen, features, truncated = set(), [], False
    for result in results:
        truncated = truncated or result["truncated"]
        for feature in result["features"]:
            if not isinstance(feature, dict):
                continue
            geometry, properties = feature.get("geometry"), feature.get("properties")
            reference = str(feature.get("id") or "")
            if not reference or reference in seen or not isinstance(properties, dict) or not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
                continue
            seen.add(reference)
            kept = {key: properties.get(key) for key in KEYS}
            features.append({"type": "Feature", "id": reference, "geometry": geometry,
                             "properties": {**kept, "reference": reference, "approximate_area_ha": area_ha(geometry)}})
    features.sort(key=lambda feature: -(feature["properties"]["approximate_area_ha"] or 0))
    return compressed(request, {
        "type": "FeatureCollection", "features": features, "truncated": truncated,
        "source": {"service": DEFAULT_BASE + "/collections/brpgewas", "license": LICENSE, "attribution": ATTRIBUTION,
                   "retrieved_at": datetime.now(timezone.utc).isoformat(timespec="seconds")},
        "notice": "Public BRP crop parcels for map context. They do not show ownership, eligible area or a payment decision; RVO decides those.",
    })
