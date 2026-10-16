"""Bounded, public read-only OGC API access to official PDOK crop parcels."""

import json
import math
import os

import httpx

from ..models import ApiError

BASES = frozenset({
    "https://api.pdok.nl/rvo/gewaspercelen/ogc/v1",
    "https://api.pdok.nl/rvo/gewaspercelen-geharmoniseerd/ogc/v1",
})
DEFAULT_BASE = "https://api.pdok.nl/rvo/gewaspercelen/ogc/v1"


def configured_base():
    # Configuration selects a reviewed service, never an arbitrary URL or proxy.
    value = os.environ.get("FUNKYFARMERS_PDOK_BASE_URL", DEFAULT_BASE)
    if value not in BASES:
        raise ApiError(503, "connector_configuration", "The PDOK endpoint is not on the reviewed official allowlist.")
    return value


def read_parcels(bbox: list[float], limit: int = 50):
    if len(bbox) != 4 or not all(math.isfinite(n) for n in bbox):
        raise ApiError(422, "invalid_bbox", "Use four finite longitude/latitude coordinates.")
    west, south, east, north = bbox
    if not (3 <= west < east <= 8 and 50 <= south < north <= 54 and (east - west) * (north - south) <= .25):
        raise ApiError(422, "invalid_bbox", "Select a small Dutch map extent, at most 0.25 square degrees.")
    if not 1 <= limit <= 100:
        raise ApiError(422, "invalid_limit", "Read between 1 and 100 parcel candidates.")
    base = configured_base()
    # The harmonised schema has different collection names: do not guess them.
    if base != DEFAULT_BASE:
        raise ApiError(409, "schema_not_implemented", "This reviewed PDOK service has no implemented parcel schema yet. Select the BRP service.")
    url = base + "/collections/brpgewas/items"
    try:
        with httpx.Client(timeout=httpx.Timeout(15, connect=5), follow_redirects=False, trust_env=False) as client:
            with client.stream("GET", url, params={"f": "json", "bbox": ",".join(str(n) for n in bbox), "limit": limit},
                               headers={"Accept": "application/geo+json, application/json", "User-Agent": "FunkyFarmers/0.1 public-parcel-reader"}) as response:
                if response.status_code != 200:
                    raise ApiError(502, "official_read_failed", "PDOK did not return a successful parcel response. No farm data was changed.", {"status": response.status_code})
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > 4_000_000:
                        raise ApiError(502, "official_response_large", "The official response was too large. Select a smaller map extent.")
        result = json.loads(content)
    except (httpx.HTTPError, ValueError):
        raise ApiError(502, "official_read_failed", "PDOK could not be read safely. No farm data was changed.") from None
    if not isinstance(result, dict) or result.get("type") != "FeatureCollection" or not isinstance(result.get("features"), list):
        raise ApiError(502, "official_schema_changed", "The official parcel response no longer matches the implemented GeoJSON schema.")
    features = result["features"]
    if len(features) > limit or any(not isinstance(feature, dict) or feature.get("type") != "Feature" for feature in features):
        raise ApiError(502, "official_schema_changed", "The official response exceeded its bounded parcel schema.")
    return {"type": "FeatureCollection", "features": features, "number_returned": len(features), "source_url": url,
            "truncated": bool(result.get("numberMatched", len(features)) != len(features)) or any(link.get("rel") == "next" for link in result.get("links", []) if isinstance(link, dict)),
            "notice": "Public historical/reference parcel candidates only. Not proof of ownership, current use, eligible area, or a submitted declaration. Review before importing into farm evidence."}
