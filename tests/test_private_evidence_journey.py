"""Scope cases 2, 7, 12, 13, 16, 17: private capture and explicit review."""

from uuid import uuid4

import httpx

from conftest import fact_data, farm_data


def test_private_upload_review_conflict_and_retry(farmers, service_url):
    owner = farmers("Meadow owner")
    outsider = farmers("Independent farmer")
    assert owner.workspace_id != outsider.workspace_id
    farm = owner.create("farms", farm_data())
    other_farm = outsider.create("farms", farm_data("Other private farm"))

    # Cookies require CSRF even when an authenticated native bearer works.
    with httpx.Client(base_url=service_url + "/", timeout=30) as browser:
        login = browser.post("auth/login", json={"email": owner.email, "password": owner.password})
        assert login.status_code == 200
        assert "httponly" in login.headers["set-cookie"].lower()
        assert "samesite=lax" in login.headers["set-cookie"].lower()
        body = {"data": {"farm_id": farm["id"], "title": "Review captured receipt"}}
        assert browser.post("tasks", json=body).status_code == 403
        saved = browser.post("tasks", json=body, headers={"X-CSRF-Token": login.json()["csrf_token"]})
        assert saved.status_code == 201, saved.text

    key = "receipt-" + uuid4().hex
    # Separately authored local notice, not a real receipt or authority artifact.
    content = b"TEST FIXTURE ONLY\nMeadow farm area for campaign 2026: 3.75 ha\n"
    upload = {"files": {"file": ("authored-notice.txt", content, "text/plain")}, "data": {"farm_id": farm["id"]}, "headers": {"Idempotency-Key": key}, "expected": 201}
    document = owner.post("/documents", **upload).json()
    replay = owner.post("/documents", **upload).json()
    assert replay["id"] == document["id"]
    assert owner.get("/documents").json()["total"] == 1
    original = owner.get(f"/documents/{document['id']}/file")
    assert original.content == content
    assert "no-store" in original.headers.get("cache-control", "").lower()
    changed = {**upload, "files": {"file": ("authored-notice.txt", b"different", "text/plain")}, "expected": 409}
    owner.post("/documents", **changed)

    for path in (f"/farms/{farm['id']}", f"/documents/{document['id']}", f"/documents/{document['id']}/file"):
        outsider.get(path, expected=404)
        with httpx.Client(base_url=service_url + "/", timeout=30) as anonymous:
            assert anonymous.get(path.lstrip("/")).status_code == 401
    denied = outsider.client.get("/farms", headers={"X-Workspace-ID": owner.workspace_id})
    assert denied.status_code in (401, 403)
    assert {item["id"] for item in outsider.get("/farms").json()["items"]} == {other_farm["id"]}
    assert outsider.get("/documents").json()["items"] == []

    extracted = owner.post(f"/documents/{document['id']}/extract", json={"expected_revision": document["revision"], "document_type": "letter"}).json()
    proposals = extracted["data"]["extraction"]
    assert proposals["review_status"] == "proposed"
    assert all(field["review_status"] == "proposed" for field in proposals["fields"])
    assert all(source["document_id"] == document["id"] for field in proposals["fields"] for source in field["sources"])
    assert owner.get("/facts").json()["total"] == 0
    assert owner.get("/requests").json()["total"] == 0
    request_key = "request-" + uuid4().hex
    reviewed_request = {"expected_revision": extracted["revision"], "data": {
        "farm_id": farm["id"], "title": "Manually reviewed authored request", "recipient": "Fictional officer",
        "country": "DE", "region": None, "reporting_year": 2026, "deadline": None,
        "pack_id": "farm-evidence", "requirements": [{"key": "area_ha", "label": "Holding area"}], "status": "draft",
    }}
    requested = owner.post(f"/documents/{document['id']}/request", json=reviewed_request, headers={"Idempotency-Key": request_key}, expected=201).json()
    retry = owner.post(f"/documents/{document['id']}/request", json=reviewed_request, headers={"Idempotency-Key": request_key}, expected=201).json()
    assert retry["id"] == requested["id"]
    assert requested["data"]["deadline"] is None
    assert requested["data"]["status"] == "draft"
    assert owner.get("/requests").json()["total"] == 1
    outsider.get(f"/requests/{requested['id']}", expected=404)

    fact = owner.create("facts", fact_data(farm["id"], sources=[{"document_id": document["id"], "page": 1}]))
    assert fact["data"]["review_status"] == "proposed"
    edit_body = {"expected_revision": fact["revision"], "data": {"value": 4.25}}
    edited = owner.patch(f"/facts/{fact['id']}", json=edit_body).json()
    assert edited["data"]["value"] == 4.25
    stale = owner.patch(f"/facts/{fact['id']}", json={**edit_body, "data": {"value": 8}}, expected=409).json()
    assert stale["error"]["code"] == "revision_conflict"
    assert owner.get(f"/facts/{fact['id']}").json()["data"]["value"] == 4.25
    review_key = "review-" + uuid4().hex
    review = {"expected_revision": edited["revision"], "decision": "confirmed", "note": "Manually measured area checked."}
    confirmed = owner.post(f"/facts/{fact['id']}/review", json=review, headers={"Idempotency-Key": review_key}).json()
    replay = owner.post(f"/facts/{fact['id']}/review", json=review, headers={"Idempotency-Key": review_key}).json()
    assert replay == confirmed
    owner.patch(f"/facts/{fact['id']}", json={"expected_revision": confirmed["revision"], "data": {"value": 99}}, expected=409)
    history = owner.get(f"/facts/{fact['id']}/history").json()["items"]
    assert any(item["data"]["value"] == 3.75 and item["data"]["review_status"] == "proposed" for item in history)
    assert any(item["data"]["value"] == 4.25 and item["data"]["review_status"] == "confirmed" for item in history)

    # Imported literals and temporal grains must not become plausible defaults.
    literals = [("unknown", None), ("zero", 0), ("blank", ""), ("false", False), ("credit", -12.5)]
    for label, value in literals:
        saved = owner.create("facts", fact_data(farm["id"], key=label, value=value, unit=None, period=None, basis="static"))
        persisted = owner.get(f"/facts/{saved['id']}").json()["data"]
        assert persisted["value"] == value and type(persisted["value"]) is type(value)
        assert persisted["temporal_basis"] == "static" and persisted["period"] is None
    dated = owner.create("facts", fact_data(farm["id"], key="inspection_date", value="checked", unit=None, period="2026-10-12", basis="calendar_date"))
    assert dated["data"]["period"] == "2026-10-12"
    assert dated["data"]["temporal_basis"] == "calendar_date"
    outsider.create("facts", fact_data(other_farm["id"], sources=[{"document_id": document["id"]}]), expected=404)
