"""The same sourced country catalogue for every client; never a filing claim."""

import json
from pathlib import Path

from fastapi import APIRouter, Depends

from .models import ApiError
from .security import Session, require_session

router = APIRouter(tags=["countries"])
CATALOGUE = Path(__file__).resolve().parents[3] / "shared" / "countries.json"


def country_profiles():
    with CATALOGUE.open(encoding="utf-8") as handle:
        catalogue = json.load(handle)
    profiles = catalogue.get("countries", [])
    if not isinstance(profiles, list) or len(profiles) != 27:
        raise RuntimeError("The country catalogue must contain exactly 27 reviewed entries")
    codes = [profile.get("country") for profile in profiles]
    if len(set(codes)) != 27:
        raise RuntimeError("The country catalogue contains duplicate entries")
    return catalogue, profiles


@router.get("/countries")
def countries(session: Session = Depends(require_session)):
    from .reporting import load_packs

    catalogue, profiles = country_profiles()
    packs = load_packs()
    items = [{**profile, "code": profile["country"],
              "pack_count": sum(pack.get("country") == profile["country"] for pack in packs),
              "capabilities": sorted({pack["capability"] for pack in packs
                                      if pack.get("country") == profile["country"]})}
             for profile in profiles]
    return {"items": items, "total": len(items), "limit": 27, "offset": 0,
            "checked_date": catalogue["checked_date"], "capability_contract": catalogue["capability_contract"]}


@router.get("/countries/{country}")
def country_profile(country: str, session: Session = Depends(require_session)):
    _, profiles = country_profiles()
    code = country.upper()
    profile = next((entry for entry in profiles if entry["country"] == code), None)
    if profile is None:
        raise ApiError(404, "country_unavailable", "Choose one of the 27 EU countries.")
    return profile
