"""Optional sourced funding links; no eligibility engine or application action."""

import json
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends

from .catalogue import country_profiles
from .db import fetch_record, transaction
from .models import ApiError
from .security import Session, require_session

router = APIRouter(tags=["funding-guidance"])
FUNDING_PATH = Path(__file__).resolve().parents[3] / "shared" / "funding.json"


def funding_catalogue():
    """Read the installed source edition, never a user-selected path or live URL."""
    with FUNDING_PATH.open(encoding="utf-8") as handle:
        catalogue = json.load(handle)
    programmes = catalogue.get("programmes")
    if not isinstance(programmes, list) or not catalogue.get("checked_date"):
        raise RuntimeError("The installed funding guidance needs programmes and a checked date")
    return catalogue


@router.get("/farms/{farm_id}/funding-guide")
def funding_guide(farm_id: UUID, session: Session = Depends(require_session)):
    # The existing transaction applies the authenticated workspace's RLS scope.
    # Only minimal farm context is returned; it is not an eligibility input.
    with transaction(session) as conn:
        farm = fetch_record(conn, "farms", str(farm_id))
    country = farm["data"].get("country")
    _, profiles = country_profiles()
    profile = next((item for item in profiles if item["country"] == country), None)
    if profile is None:
        raise ApiError(422, "funding_country", "This installed guide covers general organisation funding information in the 27 EU countries.")
    catalogue = funding_catalogue()
    return {
        "farm": {"id": str(farm["id"]), "name": farm["data"].get("name", ""),
                 "country": country, "country_name": profile["name"]},
        "version": catalogue["version"],
        "checked_date": catalogue["checked_date"],
        "scope_notice": catalogue["scope_notice"],
        "items": catalogue["programmes"],
        "personalised_eligibility": False,
        "application_enabled": False,
    }
