"""Application-only browser acceptance; no desktop capture or live authorities."""

import json
import os
import subprocess
from uuid import uuid4

from conftest import PROJECT, confirm, fact_data, farm_data


def test_browser_farmer_adviser_and_report_workflows(farmers, browser_app, authored_model):
    onboarding = farmers("Browser new farmer")
    owner = farmers("Browser report owner")
    adviser = farmers("Browser adviser")
    seller = farmers("Browser fictional crop seller")
    intake = farmers("Browser Dutch dairy bookkeeper")
    specialist = farmers("Browser Slovak protected-crop grower")
    peer = farmers("Browser Czech mixed farmer")
    land = farmers("Browser Dutch arable boundary reviewer")
    intake_farm = intake.create("farms", {**farm_data("Fictional Dutch dairy holding"), "country": "NL", "region": None, "farm_type": "livestock", "area_ha": 12.5})
    specialist_farm = specialist.create("farms", {**farm_data("Fictional Slovak greenhouse"), "country": "SK", "region": None, "farm_type": "horticulture", "area_ha": 0.4})
    peer_farm = peer.create("farms", {**farm_data("Fictional Czech mixed holding"), "country": "CZ", "region": None, "farm_type": "mixed", "area_ha": 23})
    field_id = str(uuid4())
    outline = {"type": "Polygon", "coordinates": [[[5, 52], [5.002, 52], [5.002, 52.001], [5, 52.001], [5, 52]]]}
    land_farm = land.create("farms", {**farm_data("Fictional Dutch arable comparison"), "country": "NL", "region": None, "farm_type": "arable", "area_ha": 9,
        "parcels": [{"id": field_id, "name": "Farmer's current wheat field", "crop": "Current wheat", "geometry": outline}]})
    inspection = specialist.create("requests", {"farm_id": specialist_farm["id"], "title": "Authored inspection evidence request", "recipient": "Fictional inspection adviser", "country": "SK", "region": None,
        "reporting_year": 2026, "deadline": "2026-11-17", "pack_id": "inspection-evidence", "requirements": [], "status": "draft"})
    peer_invitation = peer.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser", "farm_ids": [peer_farm["id"]], "permissions": ["read", "review"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": peer_invitation["token"]})
    authored_model["state"].update(mode="workflow", hold=False)
    sales_farm = seller.create("farms", farm_data("Browser authored sales holding"))
    farm = owner.create("farms", farm_data("Browser reviewed meadow"))
    private = owner.create("farms", farm_data("Browser private unshared holding"))
    fact = confirm(owner, owner.create("facts", {**fact_data(farm["id"], value="3.75", basis="static", period=None), "label": "Browser reviewed holding area"}))
    request = owner.create("requests", {"farm_id": farm["id"], "title": "Browser annual evidence response", "recipient": "Fictional review office", "country": "DE", "reporting_year": 2026, "deadline": None, "pack_id": "farm-evidence", "requirements": [], "status": "draft"})
    invitation = owner.post("/invitations", json={"email": adviser.email, "role": "adviser", "farm_ids": [farm["id"]], "permissions": ["read", "review"], "expires_in_days": 1}, expected=201).json()
    accounts = {name: {"email": farmer.email, "password": farmer.password, "workspace_id": farmer.workspace_id}
                for name, farmer in (("onboarding", onboarding), ("owner", owner), ("adviser", adviser), ("seller", seller), ("intake", intake), ("specialist", specialist), ("peer", peer), ("land", land))}
    settings = {"accounts": accounts, "farm": farm, "private": private, "fact": fact, "request": request, "invitation": invitation, "sales_farm": sales_farm,
        "intake_farm": intake_farm, "specialist_farm": specialist_farm, "peer_farm": peer_farm, "land_farm": land_farm, "inspection": inspection, "adviser_id": adviser.user_id}
    directory = browser_app["directory"]
    environment = {**os.environ, "FUNKYFARM_BROWSER_URL": browser_app["url"],
                   "FUNKYFARM_BROWSER_FIXTURES": json.dumps(settings),
                   "FUNKYFARM_BROWSER_OUTPUT": str(directory / "results"),
                   "FUNKYFARM_BROWSER_JUNIT": str(directory / "junit.xml")}
    with (directory / "playwright.log").open("w+", encoding="utf-8") as log:
        result = subprocess.run([browser_app["node"], str(PROJECT / "tests/browser/node_modules/@playwright/test/cli.js"),
                                 "test", "--config", "playwright.config.mjs"],
                                cwd=PROJECT / "tests/browser", env=environment, stdout=log,
                                stderr=subprocess.STDOUT, timeout=900,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        log.seek(0)
        assert result.returncode == 0, f"Application browser acceptance failed. Artifacts: {directory}\n{log.read()[-14000:]}"
