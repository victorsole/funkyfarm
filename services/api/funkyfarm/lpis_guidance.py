"""Source-specific manual steps, not a government connection or legal verdict."""

from copy import deepcopy
import json
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

from fastapi import APIRouter, Depends

from .catalogue import country_profiles
from .db import fetch_record, transaction
from .models import ApiError
from .reporting import digest
from .security import Session, require_session

router = APIRouter(tags=["field register guidance"])
GUIDES = Path(__file__).resolve().parents[3] / "shared" / "lpis.json"


def _safe_url(value):
    parsed = urlsplit(value or "")
    return value if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password else None


def guide_for_farm(farm):
    if GUIDES.stat().st_size > 128_000:
        raise ApiError(503, "lpis_guidance_unavailable", "The field-register instructions need an operator check.")
    registry = json.loads(GUIDES.read_text(encoding="utf-8"))
    _, countries = country_profiles()
    data = farm["data"]
    country = next((item for item in countries if item["country"] == data.get("country")), {})
    profiles = []
    for value in registry["profiles"]:
        if value["country"] != data.get("country"):
            continue
        profile = deepcopy(value)
        profile["official_url"] = _safe_url(profile["official_url"])
        profile.update(app_export_formats=["geojson", "kml", "correction"], import_acceptance_verified=False)
        if profile.get("campaign_year") not in (None, data.get("reporting_year")):
            profile["limits"].append("These instructions name a different campaign year. Check the official current process before using them.")
        profiles.append(profile)
    result = {"farm_id": farm["id"], "farm_revision": farm["revision"], "country": data.get("country"),
        "region": data.get("region"), "reporting_year": data.get("reporting_year"),
        "coverage": "documented_steps" if profiles else "general_guidance_only", "profiles": profiles,
        "official_url": _safe_url(country.get("portal", {}).get("url")), "checked_date": registry["checked_date"],
        "notice": "Manual instructions only. No official register or claim is changed here. Confirm the exact task, campaign and current instructions; a file upload is not a submission or acceptance."}
    if not profiles:
        result["notice"] += " Only a general official starting page is known for this country; detailed LPIS steps and accepted file formats are not established."
    result["definition_hash"] = digest(result)
    return result


@router.get("/farms/{farm_id}/lpis-guide")
def field_register_guide(farm_id: UUID, session: Session = Depends(require_session)):
    if session.credential_scope != "interactive":
        raise ApiError(403, "interactive_session_required", "Open the application or use the selected-farm assistant guidance tool.")
    with transaction(session) as conn:
        return guide_for_farm(fetch_record(conn, "farms", str(farm_id)))
