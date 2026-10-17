"""Supplied locations, provider context and automation never replace consent."""

from conftest import confirm, fact_data, farm_data, human_browser
from concurrent.futures import ThreadPoolExecutor
import httpx
import pytest
from urllib.parse import parse_qs, urlsplit


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


def test_connections_reject_arbitrary_network_targets_and_prepare_only_manual_handoff(farmers, service_url, authored_stac, monkeypatch):
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
    from funkyfarm.connectors.pdok import configured_base
    from funkyfarm.models import ApiError
    with monkeypatch.context() as invalid_configuration:
        invalid_configuration.setenv("FUNKYFARM_PDOK_BASE_URL", authored_stac["url"])
        with pytest.raises(ApiError) as rejected:
            configured_base()
        assert rejected.value.status == 503 and rejected.value.code == "connector_configuration"
    original_farm = owner.get(f"/farms/{farm['id']}").json()
    public_before = len(authored_stac["public_calls"])
    read_body = {"bbox": [5.0, 52.0, 5.01, 52.01], "limit": 5}
    outsider.post(f"/connections/{connection['id']}/read", json=read_body, expected=404)
    assert len(authored_stac["public_calls"]) == public_before
    candidates = owner.post(f"/connections/{connection['id']}/read", json=read_body).json()
    assert candidates["data"]["status"] == "unreviewed_candidates"
    result = candidates["data"]["result"]
    assert result["source_url"] == "https://api.pdok.nl/rvo/gewaspercelen/ogc/v1/collections/brpgewas/items"
    assert [feature["id"] for feature in result["features"]] == ["authored-crop-007", "authored-ditch-008"]
    assert result["features"][0]["properties"] == {"category": "Gewasperceel", "gewas": "Wintertarwe", "gewascode": "011", "jaar": 2025, "status": "Actueel", "bron": "Authored PDOK transport fixture"}
    assert result["features"][1]["properties"]["category"] == "Sloot"
    sent = authored_stac["public_calls"][-1]
    assert parse_qs(urlsplit(sent["path"]).query) == {"f": ["json"], "bbox": ["5.0,52.0,5.01,52.01"], "limit": ["5"]}
    assert sent["headers"]["Host"] == "api.pdok.nl" and "Authorization" not in sent["headers"] and "Cookie" not in sent["headers"]
    assert farm["id"] not in str(sent) and owner.email not in str(sent)
    assert owner.get(f"/farms/{farm['id']}").json() == original_farm
    assert len(authored_stac["calls"]) == before
    assert owner.get("/facts").json()["total"] == 0
    assert owner.get("/operations").json()["total"] == 0
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


def test_hungarian_diary_reads_keep_tokens_private_pages_explicit_and_sources_unconfirmed(farmers, service_url, authored_nebih, monkeypatch):
    import json
    from uuid import UUID
    from xml.etree import ElementTree as ET
    import psycopg
    from cryptography.fernet import Fernet
    from conftest import checked_database
    from funkyfarm.connectors import nebih

    owner, outsider = farmers("Fictional Hungarian diary owner"), farmers("Unrelated diary account")
    farm = owner.create("farms", {**farm_data("Authored Hungarian crop holding"), "country": "HU", "region": None})
    other_farm = owner.create("farms", {**farm_data("Separate Hungarian diary holding"), "country": "HU", "region": None})
    untouched = owner.get(f"/farms/{farm['id']}").json()
    before_records = {kind: owner.get(f"/{kind}").json()["items"] for kind in ("facts", "operations", "reports")}
    state, config = authored_nebih["state"], authored_nebih["config"]
    token, rotated_token = "AUTHORED-DIARY-TOKEN-ONE", "AUTHORED-DIARY-TOKEN-TWO"
    secrets = [token, rotated_token, config["FUNKYFARM_NEBIH_PASSWORD"], config["FUNKYFARM_CONNECTIONS_KEY"]]

    def private(response):
        assert all(secret not in response.text for secret in secrets), "Authority secrets must not appear in a public response."
        return response.json()

    def request(browser, path, body, expected=200):
        response = browser.post(path, json=body)
        assert response.status_code == expected, f"{path}: {response.status_code} {response.text[:800]}"
        return private(response)

    def leaves(tree):
        if tree is None:
            return []
        return [(tree["name"], tree["text"]), *(pair for child in tree["children"] for pair in leaves(child))]

    def nodes(tree):
        return [tree, *(node for child in tree["children"] for node in nodes(child))]

    # The adapter remains opt-in even when an operator has installed the code.
    with monkeypatch.context() as disabled:
        disabled.setenv("FUNKYFARM_NEBIH_ENABLED", "0")
        assert nebih.configured() is False
    capability = next(item for item in owner.get("/connections/capabilities", params={"country": "HU", "workflow_id": "inputs"}).json()["items"] if item["id"] == "hu-nebih-egn-read")
    assert capability["mode"] == "private_read" and capability["configuration_ready"] is True
    assert capability["live_write"] is False and capability["automatic_filing"] is False
    connection = owner.post("/connections", expected=201, json={"farm_id": farm["id"], "capability_id": capability["id"]}).json()
    path = f"/connections/{connection['id']}"
    credential_body = {"expected_revision": connection["revision"], "api_key": token}
    owner.post(path + "/credentials", expected=403, json=credential_body)
    with httpx.Client(base_url=service_url + "/", timeout=10, trust_env=False) as anonymous:
        assert anonymous.post(path + "/read-diary", json={"expected_revision": 1, "consent": True}).status_code == 401
    with human_browser(owner, service_url) as browser, human_browser(outsider, service_url) as unrelated:
        assert unrelated.get(path).status_code == 404 and unrelated.get(path + "/reads").status_code == 404
        request(browser, path + "/activate", {"expected_revision": connection["revision"]}, 409)
        for invalid in ({"api_key": "x" * 51}, {"username": "not-a-diary-token", "api_key": token}, {"api_key": "token with space"}):
            request(browser, path + "/credentials", {"expected_revision": connection["revision"], **invalid}, 422)
        connection = request(browser, path + "/credentials", credential_body)
        assert connection["data"]["credentials_present"] is True and connection["data"]["status"] == "not_connected"
        assert "credential_ciphertext" not in connection["data"]
        admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
        with psycopg.connect(admin_url, connect_timeout=5) as db:
            stored = db.execute("SELECT data FROM funkyfarm.records WHERE id=%s AND workspace_id=%s AND kind='connections'", (connection["id"], owner.workspace_id)).fetchone()[0]
        ciphertext = stored["credential_ciphertext"]
        assert token not in json.dumps(stored)
        clear = json.loads(Fernet(config["FUNKYFARM_CONNECTIONS_KEY"].encode()).decrypt(ciphertext.encode()))
        assert clear == {"workspace_id": owner.workspace_id, "connection_id": connection["id"], "credentials": {"api_key": token}}
        connection = request(browser, path + "/activate", {"expected_revision": connection["revision"]})
        assert connection["data"]["status"] == "private_read_enabled"
        read_body = {"expected_revision": connection["revision"], "consent": True, "page": 1, "page_size": 1}
        before = len(state["calls"])
        for invalid in ({"consent": False}, {"consent": None}, {"page": 0}, {"page": True}, {"page_size": 51}, {"url": "http://127.0.0.1/private"}):
            request(browser, path + "/read-diary", {**read_body, **invalid}, 422)
        request(browser, path + "/read-diary", {"expected_revision": connection["revision"]}, 422)
        owner.post(path + "/read-diary", expected=403, json=read_body)
        request(unrelated, path + "/read-diary", read_body, 404)
        assistant = request(browser, "/assistant/credentials", {"name": "Authored no-raw-diary credential", "farm_ids": [farm["id"]], "permissions": ["read"], "expires_in_days": 1}, 201)
        with httpx.Client(base_url=service_url + "/", headers={"Authorization": "Bearer " + assistant["token"]}, timeout=10, trust_env=False) as automated:
            assert automated.post(path + "/read-diary", json=read_body).status_code in {401, 403}
        assert len(state["calls"]) == before
        first = request(browser, path + "/read-diary", read_body)
        assert len(state["calls"]) == before + 1, "One explicit read must make exactly one provider call."
        result = first["data"]["result"]
        assert first["data"]["status"] == "unreviewed_candidates" and first["data"]["connection_revision"] == connection["revision"]
        assert result["sites"] == [{"id": "00071", "uses": [{"id": "00091"}]}]
        assert result["page"] == 1 and result["page_size"] == 1 and result["total_sites"] == 101 and result["partial"] is True
        assert result["scope"] == "paged_sites_only" and result["environment"] == "test" and result["blocked"] is False
        assert result["source_url"] == "https://intesztfelirapi.nebih.gov.hu/peif/aap/services/GazdanaploService"
        assert ("allapot-kod", "0007") in leaves(result["payload"])
        nil = next(node for node in nodes(result["payload"]) if node["name"] == "kultura-list")
        assert nil["text"] == "" and nil["attributes"] == {"{http://www.w3.org/2001/XMLSchema-instance}nil": "true"}
        empty = next(node for node in nodes(result["payload"]) if node["name"] == "allapot")
        assert empty["text"] == "" and empty["attributes"] == {}
        assert ("allapot-kod", "0") in leaves(result["payload"]), "Nil, empty and literal zero must remain different source values."
        assert result["representation"] == "sanitized_business_tree" and result["redactions_applied"] is True
        assert "[redacted]" in json.dumps(result["messages"])
        second = request(browser, path + "/read-diary", {**read_body, "page": 2})
        assert len(state["calls"]) == before + 2 and second["data"]["result"]["sites"][0]["id"] == "00072"
        operation_body = {"expected_revision": connection["revision"], "consent": True, "field_read_id": first["id"], "site_id": "00071", "use_id": "00091"}
        owner.post(path + "/read-diary-operations", expected=403, json=operation_body)
        request(browser, path + "/read-diary-operations", {**operation_body, "consent": False}, 422)
        request(browser, path + "/read-diary-operations", {**operation_body, "site_id": "00072", "use_id": "00092"}, 409)
        operations = request(browser, path + "/read-diary-operations", operation_body)
        assert len(state["calls"]) == before + 3 and operations["data"]["field_read_id"] == first["id"]
        assert operations["data"]["result"]["selection_verified"] is True
        assert operations["data"]["result"]["requested_site_id"] == "00071" and operations["data"]["result"]["requested_use_id"] == "00091"
        values = leaves(operations["data"]["result"]["payload"])
        assert ("idopont-kezdet", "2026-06-11") in values and ("teruletmeret", "1.2500") in values
        assert ("fajlagos-menny", "0.500") in values and ("fajlagos-menny-me-kod", "0042") in values
        typed = next(node for node in nodes(operations["data"]["result"]["payload"]) if node["name"] == "teruletmeret")
        assert typed["attributes"] == {"{http://www.w3.org/2001/XMLSchema-instance}type": "xs:decimal"}
        assert typed["type_namespaces"] == {"xs": "http://www.w3.org/2001/XMLSchema"} and typed["text"] == "1.2500"
        # Inspect the real emitted XML independently of the adapter's parser.
        for index, call in enumerate(state["calls"][before:before + 3]):
            headers = {key.lower(): value for key, value in call["headers"].items()}
            assert headers["host"] == "intesztfelirapi.nebih.gov.hu" and headers["soapaction"] == '""'
            assert headers["content-type"] == "text/xml; charset=utf-8" and "authorization" not in headers and "cookie" not in headers
            assert headers["accept-encoding"] == "identity"
            assert farm["id"].encode() not in call["body"] and owner.email.encode() not in call["body"]
            soap = "http://schemas.xmlsoap.org/soap/envelope/"
            wsse = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"
            envelope = ET.fromstring(call["body"])
            assert envelope.tag == f"{{{soap}}}Envelope"
            username = envelope.find(f"{{{soap}}}Header/{{{wsse}}}Security/{{{wsse}}}UsernameToken")
            assert [node.tag for node in username] == [f"{{{wsse}}}Username", f"{{{wsse}}}Password"]
            assert username[0].text == config["FUNKYFARM_NEBIH_USERNAME"] and username[1].text == config["FUNKYFARM_NEBIH_PASSWORD"]
            assert username[1].attrib["Type"] == "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText"
            wrapper = envelope.find(f"{{{soap}}}Body")[0]
            operation = "getGnNovtermAdatokE1" if index < 2 else "getGnNovtermMuveletekE1"
            assert wrapper.tag == "{http://gazdanaplo.aap.nebih.gov.hu/}" + operation
            assert [node.tag for node in wrapper] == ["callContext", "tokenAdat", "callParameter"]
            assert UUID(wrapper.findtext("callContext/messageId"))
            assert (first, second, operations)[index]["data"]["result"]["message_id"] == wrapper.findtext("callContext/messageId")
            assert [node.tag for node in wrapper.find("tokenAdat")] == ["token", "kulsorendszer"]
            assert wrapper.findtext("tokenAdat/token") == token and wrapper.findtext("tokenAdat/kulsorendszer") == config["FUNKYFARM_NEBIH_SYSTEM_ID"]
            if index < 2:
                assert [node.tag for node in wrapper.find("callContext")] == ["messageId", "parameterList"]
                pairs = [(item.findtext("key"), item.findtext("value")) for item in wrapper.findall("callContext/parameterList/parameter")]
                assert pairs == [("pagesize", "1"), ("pagenumber", str(index + 1))]
                assert list(wrapper.find("callParameter")) == []
            else:
                assert [node.tag for node in wrapper.find("callContext")] == ["messageId"]
                assert [(node.tag, node.text) for node in wrapper.find("callParameter")] == [("termohely-id", "00071"), ("hasznositas-id", "00091")]
        try:
            for mode in ("wrong_site", "wrong_use"):
                state["mode"] = mode
                retained_count, calls = owner.get(path + "/reads").json()["total"], len(state["calls"])
                assert request(browser, path + "/read-diary-operations", operation_body, 502)["error"]["code"] == "nebih_selection_mismatch"
                assert len(state["calls"]) == calls + 1 and owner.get(path + "/reads").json()["total"] == retained_count
            for mode in ("unknown", "warning", "error"):
                state["mode"] = mode
                blocked = request(browser, path + "/read-diary", read_body)
                assert blocked["data"]["status"] == "needs_attention" and blocked["data"]["result"]["blocked"] is True
                request(browser, path + "/read-diary-operations", {**operation_body, "field_read_id": blocked["id"]}, 409)
            for mode, code in (("redirect", "nebih_read_failed"), ("http_error", "nebih_read_failed"), ("fault", "nebih_soap_fault"),
                               ("dtd", "nebih_response_xml"), ("malformed", "nebih_response_xml"), ("oversize", "nebih_response_large"),
                               ("stream_oversize", "nebih_response_large"), ("encoding", "nebih_response_encoding"), ("deflate", "nebih_response_encoding"), ("wrong_namespace", "nebih_response_schema")):
                state["mode"] = mode
                retained_count = owner.get(path + "/reads").json()["total"]
                calls = len(state["calls"])
                failed = request(browser, path + "/read-diary", read_body, 502)
                assert failed["error"]["code"] == code and len(state["calls"]) == calls + 1
                assert owner.get(path + "/reads").json()["total"] == retained_count
        finally:
            state["mode"] = "happy"
        connection = request(browser, path + "/credentials", {"expected_revision": connection["revision"], "api_key": rotated_token})
        assert connection["data"]["status"] == "not_connected"
        calls = len(state["calls"])
        assert request(browser, path + "/read-diary-operations", operation_body, 409)["error"]["code"] == "revision_conflict"
        request(browser, path + "/read-diary-operations", {**operation_body, "expected_revision": connection["revision"]}, 409)
        connection = request(browser, path + "/activate", {"expected_revision": connection["revision"]})
        request(browser, path + "/read-diary-operations", {**operation_body, "expected_revision": connection["revision"]}, 409)
        assert len(state["calls"]) == calls
        other = owner.post("/connections", expected=201, json={"farm_id": other_farm["id"], "capability_id": capability["id"]}).json()
        other_path = f"/connections/{other['id']}"
        other = request(browser, other_path + "/credentials", {"expected_revision": other["revision"], "api_key": rotated_token})
        other = request(browser, other_path + "/activate", {"expected_revision": other["revision"]})
        request(browser, other_path + "/read-diary-operations", {**operation_body, "expected_revision": other["revision"]}, 409)
        assert len(state["calls"]) == calls
        fresh = request(browser, path + "/read-diary", {**read_body, "expected_revision": connection["revision"]})
        assert fresh["data"]["connection_revision"] == connection["revision"]
        assert ET.fromstring(state["calls"][-1]["body"]).find(f"{{{soap}}}Body")[0].findtext("tokenAdat/token") == rotated_token
        connection = request(browser, path + "/disconnect", {"expected_revision": connection["revision"]})
        assert connection["data"]["credentials_present"] is False
        calls = len(state["calls"])
        request(browser, path + "/read-diary", {**read_body, "expected_revision": connection["revision"]}, 409)
        assert len(state["calls"]) == calls
        assert "credential_ciphertext" not in json.dumps(private(owner.get(path)))
        private(owner.get(path + "/reads"))
        with psycopg.connect(admin_url, connect_timeout=5) as db:
            stored_reads = db.execute("SELECT data FROM funkyfarm.records WHERE kind='connection_reads' AND workspace_id=%s AND data->>'connection_id'=%s", (owner.workspace_id, connection["id"])).fetchall()
            disconnected = db.execute("SELECT data FROM funkyfarm.records WHERE kind='connections' AND id=%s AND workspace_id=%s", (connection["id"], owner.workspace_id)).fetchone()[0]
        assert "credential_ciphertext" not in disconnected
        assert stored_reads and all(secret not in json.dumps(stored_reads) for secret in secrets)
    assert owner.get(f"/farms/{farm['id']}").json() == untouched
    assert {kind: owner.get(f"/{kind}").json()["items"] for kind in before_records} == before_records
