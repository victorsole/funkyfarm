"""Application-only browser acceptance; no desktop capture or live authorities."""

import json
import os
import subprocess
from uuid import uuid4

from conftest import PROJECT, confirm, fact_data, farm_data


def test_browser_farmer_adviser_and_report_workflows(farmers, browser_app, authored_oidc):
    onboarding = farmers("Browser new farmer")
    owner = farmers("Browser report owner")
    adviser = farmers("Browser adviser")
    seller = farmers("Browser fictional crop seller")
    authored_oidc["state"].update(mode="valid", subject="authored-browser-" + uuid4().hex, email=seller.email)
    sales_farm = seller.create("farms", farm_data("Browser authored sales holding"))
    farm = owner.create("farms", farm_data("Browser reviewed meadow"))
    private = owner.create("farms", farm_data("Browser private unshared holding"))
    fact = confirm(owner, owner.create("facts", {**fact_data(farm["id"], value="3.75", basis="static", period=None), "label": "Browser reviewed holding area"}))
    request = owner.create("requests", {"farm_id": farm["id"], "title": "Browser annual evidence response", "recipient": "Fictional review office", "country": "DE", "reporting_year": 2026, "deadline": None, "pack_id": "farm-evidence", "requirements": [], "status": "draft"})
    invitation = owner.post("/invitations", json={"email": adviser.email, "role": "adviser", "farm_ids": [farm["id"]], "permissions": ["read", "review"], "expires_in_days": 1}, expected=201).json()
    accounts = {name: {"email": farmer.email, "password": farmer.password, "workspace_id": farmer.workspace_id, "user_id": farmer.user_id}
                for name, farmer in (("onboarding", onboarding), ("owner", owner), ("adviser", adviser), ("seller", seller))}
    settings = {"accounts": accounts, "farm": farm, "private": private, "fact": fact, "request": request, "invitation": invitation, "sales_farm": sales_farm}
    directory = browser_app["directory"]
    environment = {**os.environ, "FUNKYFARM_BROWSER_URL": browser_app["url"],
                   "FUNKYFARM_BROWSER_FIXTURES": json.dumps(settings),
                   "FUNKYFARM_BROWSER_OUTPUT": str(directory / "results"),
                   "FUNKYFARM_BROWSER_JUNIT": str(directory / "junit.xml")}
    with (directory / "playwright.log").open("w+", encoding="utf-8") as log:
        result = subprocess.run([browser_app["node"], str(PROJECT / "tests/browser/node_modules/@playwright/test/cli.js"),
                                 "test", "--config", "playwright.config.mjs"],
                                cwd=PROJECT / "tests/browser", env=environment, stdout=log,
                                stderr=subprocess.STDOUT, timeout=630,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        log.seek(0)
        assert result.returncode == 0, f"Application browser acceptance failed. Artifacts: {directory}\n{log.read()[-14000:]}"
