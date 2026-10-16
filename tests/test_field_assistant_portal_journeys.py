"""Supplied locations, provider context and automation never replace consent."""

from conftest import confirm, fact_data, farm_data, human_browser
from concurrent.futures import ThreadPoolExecutor
import httpx


def test_field_satellite_context_and_assistant_proposals_need_fresh_human_permission(farmers, service_url, authored_stac):
    owner = farmers("Field owner")
    adviser = farmers("Field adviser")
    farm = owner.create("farms", farm_data())
    outline = {"type": "Polygon", "coordinates": [[[11.0, 48.0], [11.001, 48.0], [11.001, 48.001], [11.0, 48.001], [11.0, 48.0]]]}
    bow_tie = {"type": "Polygon", "coordinates": [[[11.0, 48.0], [11.001, 48.001], [11.001, 48.0], [11.0, 48.001], [11.0, 48.0]]]}
    owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"], "parcel": {"name": "Crossed outline", "geometry": bow_tie}}, expected=422)
    proposal = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"], "parcel": {"name": "Authored greenhouse outline", "geometry": outline, "greenhouse": True}}).json()
    assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
    approved = owner.post(f"/field-proposals/{proposal['id']}/approve", json={"expected_revision": proposal["revision"], "expected_farm_revision": farm["revision"], "note": "Farmer checked this authored private outline."}).json()
    farm = approved["farm"]
    field = owner.get(f"/farms/{farm['id']}/fields").json()["items"][0]
    # Independent geographic bound: this 0.001-degree rectangle at 48N is about 0.83 ha.
    assert 0.75 < field["approximate_area_ha"] < 0.90
    assert field["geometry"] == outline
    assert "not" in " ".join(field["geometry_summary"]["warnings"]).lower()
    owner.post(f"/field-proposals/{proposal['id']}/approve", json={"expected_revision": proposal["revision"], "expected_farm_revision": proposal["data"]["base_farm_revision"]}, expected=409)
    scene_query = {"farm_id": farm["id"], "parcel_id": field["id"], "start_date": "2025-05-01", "end_date": "2025-05-31", "max_cloud_cover": 30, "limit": 10}
    searched = owner.post("/satellite/search", json=scene_query).json()
    scenes = {item["id"]: item for item in searched["data"]["items"]}
    assert "AUTHORED-CLOUDY" not in scenes
    assert scenes["AUTHORED-UNKNOWN"]["cloud_cover"] is None
    assert scenes["AUTHORED-CLEAR"]["cloud_cover"] == 0
    assert searched["data"]["interpretation_status"] == "metadata_only"
    assert any("greenhouse" in warning.lower() for warning in searched["data"]["warnings"])
    assert owner.get("/operations").json()["total"] == 0
    assert authored_stac["calls"][-1]["bbox"] == [11.0, 48.0, 11.001, 48.001]
    work = owner.post(f"/satellite/searches/{searched['id']}/operations", json={"scene_id": "AUTHORED-UNKNOWN", "title": "Farmer's own recorded visit", "type": "work", "note": "A catalogue match does not detect this visit or its date."}).json()
    assert work["data"]["review_status"] == "proposed" and not work["data"].get("date")
    owner.post(f"/operations/{work['id']}/review", json={"expected_revision": work["revision"], "decision": "confirmed", "note": "Unknown dates must remain unresolved."}, expected=422)
    fixed = owner.patch(f"/operations/{work['id']}", json={"expected_revision": work["revision"], "data": {"date": "2025-05-10", "period": "2025-05-10", "temporal_basis": "calendar_date"}}).json()
    checked = owner.post(f"/operations/{work['id']}/review", json={"expected_revision": fixed["revision"], "decision": "confirmed", "note": "Farmer independently checked the actual visit date in their notebook."}).json()
    assert checked["data"]["review_status"] == "confirmed"

    def stage(actor, farm_revision, **kwargs):
        return actor.post("/assistant/execute/propose_capture", json={"arguments": {
            "farm_id": farm["id"], "expected_farm_revision": farm_revision, "kind": "tasks",
            "data": {"title": "Check source evidence before preparing paperwork", "status": "open"},
        }}, **kwargs).json()

    pending = stage(owner, farm["revision"])
    decision = {"expected_revision": pending["expected_revision"], "checksum": pending["checksum"]}
    assert pending["status"] == "requires_human_review"
    assert owner.get("/tasks").json()["total"] == 0
    owner.post(f"/assistant/approvals/{pending['approval_id']}/approve", json=decision, expected=403)
    unavailable = owner.client.post("/assistant/execute/approve_report", json={"arguments": {}})
    assert unavailable.status_code in (404, 422)
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {"notes": "A later farm edit invalidates the earlier AI preview."}}).json()
    with human_browser(owner, service_url) as browser:
        assert browser.post(f"/assistant/approvals/{pending['approval_id']}/approve", json=decision).status_code == 409
        fresh = stage(owner, farm["revision"])
        fresh_decision = {"expected_revision": fresh["expected_revision"], "checksum": fresh["checksum"]}
        consumed = browser.post(f"/assistant/approvals/{fresh['approval_id']}/approve", json=fresh_decision)
        assert consumed.status_code == 200, consumed.text
        assert consumed.json()["status"] == "consumed"
        assert browser.post(f"/assistant/approvals/{fresh['approval_id']}/approve", json=fresh_decision).status_code == 409
    assert owner.get("/tasks").json()["total"] == 1

    other_farm = owner.create("farms", farm_data("Outside the assistant credential grant"))
    private_original = owner.post("/documents", files={"file": ("assistant-private-original.txt", b"Authored private original, unavailable to assistant credentials.\n", "text/plain")}, data={"farm_id": farm["id"]}, expected=201).json()
    with human_browser(owner, service_url) as browser:
        source_bound = owner.post("/assistant/execute/propose_capture", json={"arguments": {
            "farm_id": farm["id"], "expected_farm_revision": farm["revision"], "kind": "facts",
            "data": {"key": "source_bound_declaration", "label": "Declaration from reviewed source", "value": "checked",
                     "temporal_basis": "static", "period": None, "unit": None,
                     "sources": [{"document_id": private_original["id"], "revision": private_original["revision"], "page": 1}]},
        }}).json()
        changed_document = owner.post(f"/documents/{private_original['id']}/extract", json={"expected_revision": private_original["revision"], "document_type": "letter"}).json()
        assert changed_document["revision"] > private_original["revision"]
        stale_source = browser.post(f"/assistant/approvals/{source_bound['approval_id']}/approve", json={"expected_revision": source_bound["expected_revision"], "checksum": source_bound["checksum"]})
        assert stale_source.status_code == 409, stale_source.text
        assert owner.get("/facts").json()["total"] == 0
        readonly = browser.post("/assistant/credentials", json={"name": "Authored read-only agent", "farm_ids": [farm["id"]], "permissions": ["read"], "expires_in_days": 1})
        assert readonly.status_code == 201, readonly.text
        read_key = readonly.json()
        assert read_key["token"].startswith("ffa_")
        with httpx.Client(base_url=service_url + "/", headers={"Authorization": "Bearer " + read_key["token"]}, timeout=30) as agent:
            assert agent.get("/assistant/tools").status_code == 200
            assert agent.post("/assistant/execute/find_records", json={"arguments": {"farm_id": farm["id"], "kind": "tasks"}}).status_code == 200
            cross_farm = agent.post("/assistant/execute/find_records", json={"arguments": {"farm_id": other_farm["id"], "kind": "tasks"}})
            assert cross_farm.status_code in (403, 404)
            assert agent.post("/assistant/execute/propose_capture", json={"arguments": {"farm_id": farm["id"], "expected_farm_revision": farm["revision"], "kind": "tasks", "data": {"title": "Read-only keys cannot propose writes"}}}).status_code == 403
            for path in ("/auth/session", "/farms", f"/farms/{farm['id']}", f"/documents/{private_original['id']}/file"):
                assert agent.get(path).status_code in (401, 403)
            revoked = browser.post(f"/assistant/credentials/{read_key['credential']['id']}/revoke", json={"expected_revision": read_key["credential"]["revision"]})
            assert revoked.status_code == 200, revoked.text
            assert agent.get("/assistant/tools").status_code == 401

        writable = browser.post("/assistant/credentials", json={"name": "Authored proposal agent", "farm_ids": [farm["id"]], "permissions": ["read", "propose"], "expires_in_days": 1})
        assert writable.status_code == 201, writable.text
        write_key = writable.json()
        with httpx.Client(base_url=service_url + "/", headers={"Authorization": "Bearer " + write_key["token"]}, timeout=30) as agent:
            staged = agent.post("/assistant/execute/propose_capture", json={"arguments": {"farm_id": farm["id"], "expected_farm_revision": farm["revision"], "kind": "tasks", "data": {"title": "Revoking the proposing key invalidates pending human actions"}}})
            assert staged.status_code == 200, staged.text
            pending_key = staged.json()
            key_decision = {"expected_revision": pending_key["expected_revision"], "checksum": pending_key["checksum"]}
            assert agent.post(f"/assistant/approvals/{pending_key['approval_id']}/approve", json=key_decision).status_code in (401, 403)
            # Hold the proposal row so approval has begun but cannot consume it.
            # Observe the actual PostgreSQL waiter, commit key revocation first,
            # then release approval. Its post-lock authorization must deny it.
            with ThreadPoolExecutor(max_workers=1) as workers:
                with farmers.lock_generated_record(owner, "ai_approvals", pending_key["approval_id"]) as wait_for_approval:
                    concurrent = workers.submit(browser.post, f"/assistant/approvals/{pending_key['approval_id']}/approve", json=key_decision)
                    wait_for_approval()
                    assert browser.post(f"/assistant/credentials/{write_key['credential']['id']}/revoke", json={"expected_revision": write_key["credential"]["revision"]}).status_code == 200
                concurrent_result = concurrent.result(timeout=15)
                assert concurrent_result.status_code == 403, concurrent_result.text

        grant_key = browser.post("/assistant/credentials", json={"name": "Authored grant-change agent", "farm_ids": [farm["id"]], "permissions": ["read"], "expires_in_days": 1}).json()
        # Simulate an operator changing only the generated account's membership.
        # This uses the real database and resolver, never an authentication mock.
        farmers.change_generated_membership(owner, ["read"])
        with httpx.Client(base_url=service_url + "/", headers={"Authorization": "Bearer " + grant_key["token"]}, timeout=30) as agent:
            assert agent.get("/assistant/tools").status_code == 401
    assert owner.get("/tasks").json()["total"] == 1
    assert owner.get("/reports").json()["total"] == 0
    invitation = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser", "farm_ids": [farm["id"]], "permissions": ["read", "review"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": invitation["token"]})
    selected = {"X-Workspace-ID": owner.workspace_id}
    delegated = stage(adviser, farm["revision"], headers=selected)
    owner.post(f"/invitations/{invitation['invitation']['id']}/revoke")
    with human_browser(adviser, service_url) as browser:
        revoked = browser.post(f"/assistant/approvals/{delegated['approval_id']}/approve", headers=selected, json={"expected_revision": delegated["expected_revision"], "checksum": delegated["checksum"]})
        assert revoked.status_code in (401, 403, 404)
    assert owner.get("/tasks").json()["total"] == 1


def test_connections_reject_arbitrary_network_targets_and_prepare_only_manual_handoff(farmers, service_url, authored_stac):
    owner = farmers("Connection owner")
    outsider = farmers("Unrelated connection user")
    farm = owner.create("farms", {**farm_data(), "country": "NL", "region": None})
    before = len(authored_stac["calls"])
    for target in ("http://127.0.0.1/private", "http://169.254.169.254/latest/meta-data/", "https://api.pdok.nl@127.0.0.1/"):
        owner.post("/connections", json={"farm_id": farm["id"], "capability_id": "nl-pdok-brp-public", "url": target}, expected=422)
    connection = owner.post("/connections", json={"farm_id": farm["id"], "capability_id": "nl-pdok-brp-public"}, expected=201).json()
    assert connection["data"]["status"] == "not_connected"
    outsider.get(f"/connections/{connection['id']}", expected=404)
    ready = owner.post(f"/connections/{connection['id']}/activate", json={"expected_revision": connection["revision"]}).json()
    # The isolated service's configured PDOK URL is deliberately loopback. The
    # real connector must reject it before making any request to the spy server.
    denied = owner.post(f"/connections/{connection['id']}/read", json={"bbox": [5.0, 52.0, 5.01, 52.01], "limit": 5}, expected=503).json()
    assert denied["error"]["code"] == "connector_configuration"
    assert len(authored_stac["calls"]) == before
    assert owner.get("/facts").json()["total"] == 0
    assert owner.get(f"/connections/{ready['id']}").json()["data"]["automatic_filing"] is False
    handoff_connection = owner.post("/connections", json={"farm_id": farm["id"], "capability_id": "country-NL-inspection-handoff"}, expected=201).json()
    fact = confirm(owner, owner.create("facts", fact_data(farm["id"], value="3.75", basis="static", period=None)))
    draft = owner.post("/reports", json={"farm_id": farm["id"], "pack_id": "inspection-evidence", "reporting_year": 2026, "fact_ids": [fact["id"]]}, expected=201).json()
    issued = owner.post(f"/reports/{draft['id']}/approve", json={"expected_revision": draft["revision"]}).json()
    preview = owner.post(f"/connections/{handoff_connection['id']}/preview", json={"report_id": issued["id"], "expected_report_revision": issued["revision"]}, expected=201).json()
    approval_body = {"preview_id": preview["id"], "expected_checksum": preview["data"]["checksum"]}
    owner.post(f"/connections/{handoff_connection['id']}/approve", json=approval_body, expected=403)
    with human_browser(owner, service_url) as browser:
        approval = browser.post(f"/connections/{handoff_connection['id']}/approve", json=approval_body)
        assert approval.status_code == 201, approval.text
        handoff = browser.post(f"/connections/{handoff_connection['id']}/handoff", json={"approval_id": approval.json()["id"], "expected_checksum": preview["data"]["checksum"]})
        assert handoff.status_code == 201, handoff.text
        assert handoff.json()["data"]["status"] == "prepared_for_manual_handoff"
        assert handoff.json()["data"]["automatic_filing"] is False
        assert handoff.json()["data"]["authority_acceptance_verified"] is False
    assert len(authored_stac["calls"]) == before
    assert owner.get(f"/reports/{issued['id']}").json()["data"]["filing_status"] == "not_filed"
