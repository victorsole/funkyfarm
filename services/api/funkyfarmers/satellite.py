"""Bounded public Copernicus catalogue retrieval; metadata is not a farm observation."""

from datetime import date as Date, datetime, timezone
import base64
from io import BytesIO
import json
import math
import re
import time
from typing import Literal
from urllib.parse import quote, urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, Query
from fastapi.responses import Response
from pydantic import Field

from .db import fetch_record, idempotent, insert_record, list_records, transaction, update_record
from .fields import find_parcel, geometry_summary
from .models import ApiError, StrictModel
from .security import Session, require_session

router = APIRouter(tags=["satellite context"])
CATALOGUE = "https://stac.dataspace.copernicus.eu/v1"
DOCS = "https://documentation.dataspace.copernicus.eu/APIs/STAC.html"
EARTH_SEARCH = "https://earth-search.aws.element84.com/v1"
EARTH_COLLECTION = "sentinel-2-c1-l2a"
COG_HOSTS = {"sentinel-cogs.s3.us-west-2.amazonaws.com": "/sentinel-s2-l2a-cogs/",
             "e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com": "/sentinel-2-c1-l2a/"}


class Search(StrictModel):
    farm_id: str
    parcel_id: str = Field(min_length=1, max_length=100)
    start_date: Date
    end_date: Date
    max_cloud_cover: float = Field(default=30, ge=0, le=100, allow_inf_nan=False)
    limit: int = Field(default=10, ge=1, le=20)
    provider: Literal["copernicus", "earthsearch"] = "copernicus"


def retrieve_scenes(payload):
    return retrieve_catalogue(CATALOGUE + "/search", payload)


def retrieve_earth_scenes(payload):
    return retrieve_catalogue(EARTH_SEARCH + "/search", payload)


def retrieve_catalogue(endpoint, payload):
    # Host/path are code-owned. Never follow provider redirects or returned URLs, or accept a caller URL.
    try:
        with httpx.Client(timeout=httpx.Timeout(15, connect=5), follow_redirects=False, trust_env=False) as client:
            with client.stream("POST", endpoint, json=payload,
                               headers={"Accept": "application/geo+json", "User-Agent": "FunkyFarmers/0.1"}) as response:
                if response.status_code != 200:
                    raise ApiError(502, "satellite_provider_unavailable", "Copernicus could not complete this search. Your field records are unchanged.")
                raw = bytearray()
                deadline = time.monotonic() + 20
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 4 * 1024 * 1024 or time.monotonic() > deadline:
                        raise ApiError(502, "satellite_response_limit", "The catalogue response was too large. Try a shorter period.")
                content = json.loads(raw)
        if not isinstance(content, dict) or not isinstance(content.get("features"), list):
            raise ValueError("Invalid catalogue feature collection")
        return content
    except (httpx.HTTPError, ValueError, UnicodeError) as exc:
        raise ApiError(502, "satellite_provider_unavailable", "Copernicus is unavailable or returned unreadable metadata. Try again later.") from exc


@router.post("/satellite/search")
def search(body: Search, session: Session = Depends(require_session), retry_key: str | None = Header(None, alias="Idempotency-Key")):
    if body.end_date < body.start_date or (body.end_date - body.start_date).days > 366 or body.end_date > Date.today():
        raise ApiError(422, "satellite_date_range", "Choose a past date range of at most one year.")
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", body.farm_id)
        parcel = find_parcel(farm, body.parcel_id)
        summary = geometry_summary(parcel.get("geometry"))
        bbox = summary.get("bbox")
        if not bbox:
            point = parcel.get("point")
            if not isinstance(point, dict) or not all(isinstance(point.get(key), (float, int)) for key in ("longitude", "latitude")):
                raise ApiError(422, "field_location_required", "Record a supplied field outline or location point before searching satellite images.")
            lon, lat = point["longitude"], point["latitude"]
            if not -180 <= lon <= 180 or not -90 <= lat <= 90:
                raise ApiError(422, "invalid_location", "Correct the field's location before searching.")
            bbox = [max(-180, lon - .0001), max(-90, lat - .0001), min(180, lon + .0001), min(90, lat + .0001)]
        payload = {"collections": ["sentinel-2-l2a"], "bbox": bbox,
            "datetime": f"{body.start_date.isoformat()}T00:00:00Z/{body.end_date.isoformat()}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lte": body.max_cloud_cover}}, "limit": body.limit,
            "sortby": [{"field": "properties.datetime", "direction": "desc"}],
            "fields": {"include": ["id", "collection", "geometry", "bbox", "properties.datetime", "properties.platform", "properties.eo:cloud_cover"], "exclude": ["assets", "links"]}}
    if body.provider == "earthsearch":
        payload["collections"] = [EARTH_COLLECTION]
        payload.pop("fields", None)
        content = retrieve_earth_scenes(payload)
    else:
        content = retrieve_scenes(payload)
    scenes = []
    for feature in content["features"][:body.limit]:
        props = feature.get("properties", {})
        scene_id, timestamp, cloud = feature.get("id"), props.get("datetime"), props.get("eo:cloud_cover")
        if not isinstance(scene_id, str) or len(scene_id) > 300 or not isinstance(timestamp, str):
            continue
        try:
            observed = datetime.fromisoformat(timestamp.replace("Z", "+00:00")).date()
        except ValueError:
            continue
        if not body.start_date <= observed <= body.end_date:
            continue
        if isinstance(cloud, (int, float)) and not isinstance(cloud, bool):
            if not 0 <= cloud <= body.max_cloud_cover:
                continue
        else:
            cloud = None
        assets = {}
        if body.provider == "earthsearch":
            for key in ("red", "nir", "scl", "visual"):
                asset = feature.get("assets", {}).get(key, {})
                if safe_cog_url(asset.get("href")):
                    bands = asset.get("raster:bands", [{}])
                    band = bands[0] if bands else {}
                    scale, offset = band.get("scale"), band.get("offset")
                    assets[key] = {"href": asset["href"], "scale": scale, "offset": offset, "nodata": band.get("nodata")}
        endpoint = EARTH_SEARCH if body.provider == "earthsearch" else CATALOGUE
        collection = EARTH_COLLECTION if body.provider == "earthsearch" else "sentinel-2-l2a"
        scenes.append({"id": scene_id, "datetime": timestamp, "platform": props.get("platform"),
                       "collection": collection, "cloud_cover": cloud,
                       "geometry": feature.get("geometry"), "provider_url": endpoint + "/collections/" + collection + "/items/" + quote(scene_id, safe=""), "assets": assets,
                       "analysis_status": "not_analysed", "cloud_scope": "whole_scene_not_field"})
    warnings = ["Catalogue matches are scene metadata, not proof of crop type, mowing, input use or an operation.",
                "Scene cloud percentage does not establish whether this field is clear; no field pixels have been analysed.",
                "10 m optical pixels mix small fields, boundaries and neighbouring land. Clouds can leave long evidence gaps."]
    if parcel.get("greenhouse"):
        warnings.append("Greenhouse roofs alter or obscure the crop signal. Do not infer the crop or operations inside from these scenes.")
    if not parcel.get("geometry"):
        warnings.append("This search uses a small box around your location point, not a measured field boundary.")
    warnings.extend(summary.get("warnings", []))
    with transaction(session) as conn:
        # Reauthorize after the provider wait; cache lives in the same farm/workspace RLS scope.
        current_farm = fetch_record(conn, "farms", body.farm_id)
        current = find_parcel(current_farm, body.parcel_id)
        if current.get("geometry") != parcel.get("geometry") or current.get("point") != parcel.get("point"):
            raise ApiError(409, "field_changed", "The field location changed during the search. Search again for its current outline.")
        return idempotent(conn, retry_key, "satellite-search", body.model_dump(mode="json"), lambda: insert_record(conn, "satellite_searches", {
            **body.model_dump(mode="json"), "field_revision": parcel.get("revision"), "farm_revision": farm["revision"],
            "field_name": parcel.get("name"), "field_geometry": parcel.get("geometry"), "field_point": parcel.get("point"),
            "provider": "Earth Search / public Copernicus Sentinel-2 COGs" if body.provider == "earthsearch" else "Copernicus Data Space Ecosystem",
            "provider_endpoint": (EARTH_SEARCH if body.provider == "earthsearch" else CATALOGUE) + "/search", "documentation": DOCS,
            "retrieved_at": datetime.now(timezone.utc).isoformat(), "items": scenes, "warnings": warnings,
            "interpretation_status": "metadata_only", "has_more": any(link.get("rel") == "next" for link in content.get("links", []) if isinstance(link, dict)),
            "imagery_download": "Public COG field-window analysis available by explicit action." if body.provider == "earthsearch" else "Source imagery requires CDSE authentication or S3 credentials; no pixels downloaded or analysed."}))


def safe_cog_url(url):
    if not isinstance(url, str) or len(url) > 2048:
        return False
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and parsed.hostname in COG_HOSTS and parsed.port in (None, 443)
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
            and parsed.path.startswith(COG_HOSTS[parsed.hostname]) and parsed.path.endswith(".tif")
            and re.fullmatch(r"/[A-Za-z0-9_./-]+", parsed.path) is not None and ".." not in parsed.path)


class Analyse(StrictModel):
    scene_id: str = Field(min_length=1, max_length=300)
    expected_revision: int = Field(ge=1)


def analyse_window(scene, geometry, greenhouse=False):
    """Read native 10 m pixels only for a bounded supplied polygon, mask 20 m SCL quality."""
    try:
        import numpy as np
        import rasterio
        from rasterio.features import geometry_mask
        from rasterio.warp import transform_geom, transform_bounds, reproject, Resampling
        from rasterio.windows import from_bounds, Window
        from PIL import Image
    except ImportError as exc:
        raise ApiError(503, "satellite_analysis_unavailable", "The local raster processing runtime is not installed.") from exc
    assets = scene.get("assets", {})
    if scene.get("collection") != EARTH_COLLECTION:
        raise ApiError(422, "radiometry_collection_required", "Start a fresh Earth Search Collection-1 search before measuring NDVI. Legacy collection radiometry metadata is inconsistent.")
    if not all(key in assets and safe_cog_url(assets[key].get("href")) for key in ("red", "nir", "scl", "visual")):
        raise ApiError(422, "public_bands_unavailable", "This scene has no verified public COG band set. Choose an Earth Search scene.")
    for key in ("red", "nir"):
        if not all(isinstance(assets[key].get(value), (float, int)) and math.isfinite(assets[key][value]) for value in ("scale", "offset")):
            raise ApiError(422, "reflectance_metadata_missing", "Band scale and offset metadata are required before calculating NDVI.")
    summary = geometry_summary(geometry)
    if summary["approximate_area_ha"] > 2000:
        raise ApiError(422, "analysis_area_limit", "Choose a field under 2,000 ha for this bounded local analysis.")
    options = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
        "GDAL_HTTP_CONNECTTIMEOUT": "5", "GDAL_HTTP_TIMEOUT": "15", "GDAL_HTTP_MAX_RETRY": "0",
        "GDAL_CACHEMAX": 32, "VSI_CACHE": False, "GDAL_PAM_ENABLED": "NO", "GDAL_NUM_THREADS": "1",
        "GDAL_HTTP_PROXY": "", "GDAL_HTTP_UNSAFESSL": "NO"}
    try:
        with rasterio.Env(**options):
            with rasterio.open(assets["red"]["href"], driver="GTiff") as red_source:
                if not red_source.crs or red_source.count != 1:
                    raise ApiError(422, "invalid_raster", "This scene has unsupported band geometry.")
                if abs(abs(red_source.transform.a) - 10) > .01 or abs(abs(red_source.transform.e) - 10) > .01:
                    raise ApiError(422, "unsupported_resolution", "This analysis requires the provider's native 10 metre bands.")
                projected = transform_geom("EPSG:4326", red_source.crs, geometry)
                bounds = transform_bounds("EPSG:4326", red_source.crs, *summary["bbox"], densify_pts=21)
                window = from_bounds(*bounds, red_source.transform).round_offsets().round_lengths()
                window = window.intersection(Window(0, 0, red_source.width, red_source.height))
                if window.width < 1 or window.height < 1 or window.width > 1024 or window.height > 1024:
                    raise ApiError(422, "analysis_window_limit", "This outline exceeds the native-pixel analysis window or is too small. Split the field or review its location.")
                transform, crs = red_source.window_transform(window), red_source.crs
                red_raw = red_source.read(1, window=window, masked=True)
                shape = red_raw.shape
                field_mask = geometry_mask([projected], out_shape=shape, transform=transform, invert=True, all_touched=False)
                if not field_mask.any():
                    raise ApiError(422, "insufficient_field_pixels", "No native pixel centres fall within this outline. Use ground evidence for this field.")
            def aligned(key, bands=1):
                with rasterio.open(assets[key]["href"], driver="GTiff") as src:
                    if src.crs != crs:
                        raise ApiError(422, "raster_alignment", "The scene bands do not use the same coordinate system.")
                    source_bounds = rasterio.transform.array_bounds(*shape, transform)
                    source_window = from_bounds(*source_bounds, src.transform).round_offsets().round_lengths()
                    source_window = source_window.intersection(Window(0, 0, src.width, src.height))
                    if source_window.width > 1024 or source_window.height > 1024:
                        raise ApiError(422, "analysis_window_limit", "A source band exceeds the bounded pixel window.")
                    source = src.read(list(range(1, bands + 1)), window=source_window)
                    output = np.zeros((bands, *shape), dtype=source.dtype)
                    for index in range(bands):
                        reproject(source[index], output[index], src_transform=src.window_transform(source_window), src_crs=src.crs,
                                  dst_transform=transform, dst_crs=crs, resampling=Resampling.nearest, src_nodata=src.nodata, dst_nodata=0, num_threads=1)
                    return output
            nir_raw, scl, visual = aligned("nir")[0], aligned("scl")[0], aligned("visual", 3)
            red = red_raw.filled(0).astype("float32") * assets["red"]["scale"] + assets["red"]["offset"]
            nir = nir_raw.astype("float32") * assets["nir"]["scale"] + assets["nir"]["offset"]
            denominator = nir + red
            clear = field_mask & np.isin(scl, [4, 5]) & ~np.ma.getmaskarray(red_raw) & (nir_raw != 0) & (red >= 0) & (nir >= 0) & (denominator > 0)
            indices = np.divide(nir - red, denominator, out=np.zeros(shape, dtype="float32"), where=denominator > 0)
            clear &= np.isfinite(indices) & (indices >= -1) & (indices <= 1)
            total, valid = int(field_mask.sum()), int(clear.sum())
            # Real pixels are retained in a PNG, with no interpolation or synthetic enhancement.
            rgb = np.moveaxis(visual, 0, -1).astype("uint8")
            rgba = np.dstack((rgb, np.where(field_mask, 255, 0).astype("uint8")))
            image = Image.fromarray(rgba)
            image.thumbnail((256, 256), resample=Image.Resampling.NEAREST)
            buffer = BytesIO()
            image.save(buffer, format="PNG")
            values = indices[clear]
            enough = valid >= 9 and valid / total >= .5 and not greenhouse
            return {"scene_id": scene["id"], "acquired_at": scene["datetime"], "source_url": scene["provider_url"],
                "source_assets": {key: assets[key]["href"] for key in ("red", "nir", "scl", "visual")},
                "method": "NDVI=(scaled NIR-scaled red)/(scaled NIR+scaled red); native pixel centres within supplied polygon; SCL classes 4/5 only",
                "native_resolution_m": 10, "quality_mask_resolution_m": 20, "total_field_pixels": total, "valid_land_pixels": valid,
                "valid_fraction": round(valid / total, 4), "ndvi_mean": round(float(values.mean()), 4) if enough else None,
                "ndvi_median": round(float(np.median(values)), 4) if enough else None,
                "status": "greenhouse_not_assessed" if greenhouse else "measured_context" if enough else "insufficient_clear_pixels",
                "preview_png_base64": base64.b64encode(buffer.getvalue()).decode(), "preview_width": image.width, "preview_height": image.height,
                "warnings": ["Measured spectral index, not a confirmed crop, operation, yield, input dose or compliance decision.",
                    "Cloud masks are estimates at 20 m; missed clouds, shadows and mixed boundary pixels remain possible.",
                    "NDVI is withheld for greenhouses or fewer than 9 clear land pixels or below 50% clear land coverage.",
                    "True-colour preview uses acquired pixels and may visibly contain cloud; its display is not a quality approval."],
                "analysed_at": datetime.now(timezone.utc).isoformat()}
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(502, "satellite_pixels_unavailable", "The public image window could not be read. Your records and prior measurements remain saved.") from exc


@router.post("/satellite/searches/{search_id}/analyse")
def analyse(search_id: str, body: Analyse, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "satellite_searches", search_id)
        if record["revision"] != body.expected_revision:
            raise ApiError(409, "revision_conflict", "Reload this satellite search before analysing another scene.")
        data = record["data"]
        farm = fetch_record(conn, "farms", data["farm_id"])
        parcel = find_parcel(farm, data["parcel_id"])
        if parcel.get("geometry") != data.get("field_geometry") or not parcel.get("geometry"):
            raise ApiError(422, "current_outline_required", "Search again with a current field polygon before analysing pixels.")
        scene = next((item for item in data.get("items", []) if item["id"] == body.scene_id), None)
        if scene is None:
            raise ApiError(422, "scene_not_selected", "Select a retained scene for this field.")
        previous = next((a for a in data.get("analyses", []) if a["scene_id"] == body.scene_id), None)
        if previous:
            return record
    measurement = analyse_window(scene, parcel["geometry"], parcel.get("greenhouse", False))
    with transaction(session) as conn:
        current = fetch_record(conn, "satellite_searches", search_id)
        current_parcel = find_parcel(fetch_record(conn, "farms", data["farm_id"]), data["parcel_id"])
        if current_parcel.get("geometry") != parcel.get("geometry"):
            raise ApiError(409, "field_changed", "The field outline changed during processing. Search again.")
        analyses = current["data"].get("analyses", [])
        if any(item["scene_id"] == body.scene_id for item in analyses):
            return current
        if len(analyses) >= 10:
            raise ApiError(422, "analysis_limit", "This search already retains ten analysed scenes. Start a new field search.")
        return update_record(conn, "satellite_searches", search_id, current["revision"], {**current["data"],
            "analyses": [*analyses, measurement], "interpretation_status": "measured_context_not_confirmed_operations"})


@router.get("/satellite/searches")
def searches(farm_id: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0), session: Session = Depends(require_session)):
    with transaction(session) as conn:
        fetch_record(conn, "farms", farm_id)
        return list_records(conn, "satellite_searches", limit, offset, farm_id)


@router.get("/satellite/searches/{search_id}/metadata")
def metadata(search_id: str, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "satellite_searches", search_id)
        return Response(json.dumps(record, ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="copernicus-scene-metadata.json"', "Cache-Control": "private, no-store"})


class OperationProposal(StrictModel):
    scene_id: str = Field(min_length=1, max_length=300)
    title: str = Field(min_length=1, max_length=300)
    type: str = Field(min_length=1, max_length=100)
    date: Date | None = None
    note: str = Field(min_length=5, max_length=4000)


@router.post("/satellite/searches/{search_id}/operations")
def propose_operation(search_id: str, body: OperationProposal, session: Session = Depends(require_session), retry_key: str | None = Header(None, alias="Idempotency-Key")):
    with transaction(session) as conn:
        def create():
            search_record = fetch_record(conn, "satellite_searches", search_id)
            data = search_record["data"]
            scene = next((item for item in data.get("items", []) if item["id"] == body.scene_id), None)
            if not scene:
                raise ApiError(422, "scene_not_selected", "Choose a scene from this retained field search.")
            farm = fetch_record(conn, "farms", data["farm_id"])
            parcel = find_parcel(farm, data["parcel_id"])
            operation = {"farm_id": farm["id"], "parcel_id": parcel["id"], "parcel": parcel.get("name"),
                "title": body.title, "type": body.type, "notes": body.note,
                "review_status": "proposed", "origin": "farmer_entered_with_satellite_context",
                "sources": [{"source_kind": "satellite_catalogue_metadata", "source_id": search_record["id"],
                             "scene_id": scene["id"], "acquired_at": scene["datetime"], "url": scene["provider_url"],
                             "meaning": "Context only; operation and date entered by the farmer, not detected from imagery."}]}
            if body.date is not None:
                operation.update(date=body.date.isoformat(), period=body.date.isoformat(), temporal_basis="calendar_date")
            return insert_record(conn, "operations", operation)
        return idempotent(conn, retry_key, "satellite-operation", {"id": search_id, **body.model_dump(mode="json")}, create)
