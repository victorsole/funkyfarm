"""Fictional CAP correction, real private app workflow; not an eligibility test.

This one journey is authored against runtime/cap-demo/implementation-contract.json.
It does not use authority services, satellite observations, or organizer geometry.
"""

from datetime import date
import json
from uuid import uuid4

import httpx

from conftest import human_browser
from test_guided_cases_journey import call, packet_href, review_case, reviewed_packet, upload


def test_cap_example_requires_real_private_review_and_explicit_evidence(farmers, service_url):
    owner, outsider, adviser = (farmers(name) for name in (
        "Fictional CAP example farmer", "Other private example owner", "Read-only example adviser"))
    stable_key = {"Idempotency-Key": "cap-example-" + uuid4().hex}
    acknowledge = {"acknowledged": True}
    assert owner.get("/farms").json()["total"] == 0

    with human_browser(owner, service_url) as browser:
        missing_key = call(browser, "POST", "/examples/cap", expected=400, json=acknowledge)
        assert missing_key["error"]["code"] == "idempotency_key_required"
        for body in ({}, {"acknowledged": False}, {"acknowledged": "true"}):
            call(browser, "POST", "/examples/cap", expected=422, headers=stable_key, json=body)
        assert owner.get("/farms").json()["total"] == 0, "Rejected acknowledgement must not leave a partial example farm."
        example = call(browser, "POST", "/examples/cap", expected=201, headers=stable_key, json=acknowledge)
        for headers in (stable_key, {"Idempotency-Key": "cap-another-key-" + uuid4().hex}):
            retry = call(browser, "POST", "/examples/cap", expected=201, headers=headers, json=acknowledge)
            assert retry["run_id"] == example["run_id"]
            assert {name: retry[name]["id"] for name in ("farm", "case", "proposal")} == {
                name: example[name]["id"] for name in ("farm", "case", "proposal")}
        assert owner.get("/farms").json()["total"] == 1
        farm, case, proposal, scenario = (example[name] for name in ("farm", "case", "proposal", "scenario"))
        assert scenario["id"] == "cap-correction-v1" and scenario["reference_year"] == 2026
        assert "fictional" in scenario["notice"].lower()
        assert farm["data"]["country"] == "NL"
        assert case["data"]["job_type"] == "correction" and case["data"]["status"] == "draft"
        assert case["data"]["review"] is None and len(case["data"]["items"]) == 3
        assert all(item["status"] == "open" for item in case["data"]["items"])
        assert proposal["data"]["status"] == "proposed"
        assert not example["checks"]["can_review"]
        assert example["checks"]["case_revision"] == case["revision"]
        initial_fields = owner.get(f"/farms/{farm['id']}/fields").json()["items"]
        assert len(initial_fields) == 1 and initial_fields[0]["geometry"] == scenario["claimed_geometry"]
        assert scenario["claimed_geometry"] != scenario["reference_geometry"]
        assert proposal["data"]["parcel"]["geometry"] == scenario["reference_geometry"]
        task_references = [reference for reference in case["data"]["references"] if reference["kind"] == "tasks"]
        assert {reference["role"] for reference in task_references} == {"original", "notice"}
        for reference in task_references:
            assert owner.get(f"/tasks/{reference['id']}").json()["data"]["status"] == "open"
        assert owner.get("/reports").json()["total"] == owner.get("/facts").json()["total"] == owner.get("/operations").json()["total"] == 0
        call(browser, "POST", f"/cases/{case['id']}/review", expected=422, json={"expected_revision": case["revision"],
            "expected_fingerprint": example["checks"]["fingerprint"], "acknowledged": True})
        call(browser, "GET", f"/cases/{case['id']}/handoff", expected=409)

        # The same stable key cannot expose the first owner's example in another workspace.
        with human_browser(outsider, service_url) as other_browser:
            private_example = call(other_browser, "POST", "/examples/cap", expected=201, headers=stable_key, json=acknowledge)
            assert private_example["run_id"] != example["run_id"] and private_example["farm"]["id"] != farm["id"]
            call(other_browser, "GET", f"/examples/cap/{example['run_id']}", expected=404)
        call(browser, "GET", f"/examples/cap/{private_example['run_id']}", expected=404)
        # A workspace with no membership cannot resolve this human session at
        # all; this is authentication denial, before CAP's owner-role check.
        unavailable_workspace = call(browser, "POST", "/examples/cap", expected=401,
            headers={**stable_key, "X-Workspace-ID": outsider.workspace_id}, json=acknowledge)
        assert unavailable_workspace["error"]["code"] == "authentication_required"
        assert owner.get("/farms").json()["total"] == outsider.get("/farms").json()["total"] == 1
        invitation = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser",
            "farm_ids": [farm["id"]], "permissions": ["read"], "expires_in_days": 1}).json()
        adviser.post("/invitations/accept", json={"token": invitation["token"]})
        shared_scope = {"X-Workspace-ID": owner.workspace_id}
        adviser.get(f"/examples/cap/{example['run_id']}", headers=shared_scope)
        adviser.post("/examples/cap", expected=403, headers={**stable_key, **shared_scope}, json=acknowledge)
        credential = call(browser, "POST", "/assistant/credentials", expected=201, json={"name": "Example permission boundary",
            "farm_ids": [farm["id"]], "permissions": ["read", "propose"], "expires_in_days": 1})
        assert credential["token"].startswith("ffa_")
        before_assistant = call(browser, "GET", f"/examples/cap/{example['run_id']}")
        with httpx.Client(base_url=service_url + "/", timeout=30,
                          headers={"Authorization": "Bearer " + credential["token"]}) as agent:
            # Prove this is a valid, currently authorized assistant credential,
            # not an expired token that merely fails every route with 401.
            call(agent, "GET", "/assistant/tools")
            for method, path, kwargs in (("POST", "/examples/cap", {"headers": stable_key, "json": acknowledge}),
                                         ("GET", f"/examples/cap/{example['run_id']}", {})):
                denied = call(agent, method, path, expected=403, **kwargs)
                assert denied["error"]["code"] == "assistant_scope_denied"
        after_assistant = call(browser, "GET", f"/examples/cap/{example['run_id']}")
        assert {name: after_assistant[name] for name in ("run_id", "farm", "case", "proposal")} == {
            name: before_assistant[name] for name in ("run_id", "farm", "case", "proposal")}
        assert owner.get("/farms").json()["total"] == 1

        # Approving the proposed outline updates only the private farm. The case
        # must select its new saved revision, not silently reuse the stale seed pin.
        approved = owner.post(f"/field-proposals/{proposal['id']}/approve", json={"expected_revision": proposal["revision"],
            "expected_farm_revision": farm["revision"], "note": "Farmer checked this fictional reference and chose the private boundary correction."}).json()
        corrected_farm, corrected_proposal = approved["farm"], approved["proposal"]
        assert corrected_farm["revision"] > farm["revision"] and corrected_proposal["revision"] > proposal["revision"]
        saved_fields = owner.get(f"/farms/{farm['id']}/fields").json()["items"]
        assert len(saved_fields) == 1 and saved_fields[0]["geometry"] == scenario["reference_geometry"]
        current = call(browser, "GET", f"/examples/cap/{example['run_id']}")
        assert current["farm"]["revision"] == corrected_farm["revision"]
        assert current["proposal"]["revision"] == corrected_proposal["revision"]
        assert not current["checks"]["can_review"]
        selected_proposal = next(reference for reference in current["checks"]["references"] if reference["id"] == proposal["id"])
        assert selected_proposal["current"] is False and selected_proposal["current_revision"] == corrected_proposal["revision"]
        call(browser, "PATCH", f"/cases/{case['id']}", expected=409, json={"expected_revision": case["revision"],
            "data": {"references": case["data"]["references"]}})
        references = [{**reference, "revision": corrected_proposal["revision"]} if reference["id"] == proposal["id"] else reference
                      for reference in case["data"]["references"]]
        case = call(browser, "PATCH", f"/cases/{case['id']}", json={"expected_revision": case["revision"], "data": {"references": references}})
        assert case["data"]["review"] is None and case["data"]["status"] == "draft"
        replay_after_edit = call(browser, "POST", "/examples/cap", expected=201, headers=stable_key, json=acknowledge)
        assert replay_after_edit["run_id"] == example["run_id"] and replay_after_edit["farm"]["revision"] == corrected_farm["revision"]
        assert replay_after_edit["case"]["revision"] == case["revision"]

        # These are actual explicit file uploads, not evidence synthesized by
        # viewing a reference outline or clicking the example seed button.
        assert owner.get("/documents").json()["total"] == 0
        items = {item["key"]: item for item in scenario["items"]}
        assert set(items) == {"boundary", "land_use", "commitment"}
        assert {item["id"] for item in items.values()} == {item["id"] for item in case["data"]["items"]}
        samples = {sample["id"]: sample for sample in scenario["samples"]}
        assert set(samples) == {"land-use", "commitment"}
        boundary_text = "FICTIONAL BOUNDARY REVIEW NOTE\nFarmer compared and chose the private correction, not an official LPIS or eligibility decision.\n" + json.dumps({
            "reference_year": scenario["reference_year"], "checked_private_outline": scenario["reference_geometry"]}, sort_keys=True) + "\n"
        evidence = {"boundary": (upload(owner, farm["id"], "FICTIONAL-boundary-review-2026.txt", boundary_text), boundary_text)}
        for sample_id, item_key in (("land-use", "land_use"), ("commitment", "commitment")):
            sample = samples[sample_id]
            assert sample["mime_type"] == "text/plain"
            assert "FICTIONAL" in sample["filename"] and "fictional" in sample["notice"].lower()
            assert "fictional" in sample["contents"].lower()
            evidence[item_key] = (upload(owner, farm["id"], sample["filename"], sample["contents"]), sample["contents"])
        unselected_text = "PRIVATE UNSELECTED EXAMPLE FILE " + uuid4().hex + "\n"
        unselected = upload(owner, farm["id"], "unselected-example-note.txt", unselected_text)
        foreign_text = "PRIVATE OTHER WORKSPACE EXAMPLE FILE " + uuid4().hex + "\n"
        foreign = upload(outsider, private_example["farm"]["id"], "other-workspace-private.txt", foreign_text)
        initial_item = items["boundary"]
        first_document = evidence["boundary"][0]
        item_review = {"expected_revision": case["revision"], "status": "resolved", "note": "Compared this explicitly uploaded fictional record with the requested example item.",
            "document_ids": [first_document["id"]], "document_revisions": {}, "acknowledged": True}
        call(browser, "POST", f"/cases/{case['id']}/items/{initial_item['id']}/review", expected=422, json=item_review)
        call(browser, "POST", f"/cases/{case['id']}/items/{initial_item['id']}/review", expected=409,
            json={**item_review, "document_revisions": {first_document["id"]: first_document["revision"] + 1}})
        for count, item_key in enumerate(("boundary", "land_use", "commitment"), 1):
            document = evidence[item_key][0]
            case = call(browser, "POST", f"/cases/{case['id']}/items/{items[item_key]['id']}/review", json={
                **item_review, "expected_revision": case["revision"], "document_ids": [document["id"]],
                "document_revisions": {document["id"]: document["revision"]}})
            saved_item = next(item for item in case["data"]["items"] if item["id"] == items[item_key]["id"])
            assert saved_item["status"] == "resolved"
            assert saved_item["document_pins"] == [{"id": document["id"], "revision": document["revision"]}]
            assert saved_item["review"]["actor_id"] == owner.user_id
            assert case["data"]["status"] == "draft" and case["data"]["review"] is None
            current = call(browser, "GET", f"/examples/cap/{example['run_id']}")
            assert current["case"]["revision"] == case["revision"]
            assert current["progress"]["resolved_items"] == count and current["progress"]["open_items"] == 3 - count
            assert current["checks"]["can_review"] is (count == 3)
            assert current["progress"]["can_review"] is (count == 3)
        assert current["progress"]["total_items"] == 3 and current["progress"]["cancelled_items"] == 0
        assert current["progress"]["case_status"] == "draft" and not current["progress"]["review_current"]
        case = review_case(browser, case)
        prepared_revision = case["revision"]
        current = call(browser, "GET", f"/examples/cap/{example['run_id']}")
        assert current["progress"]["case_status"] == "ready_to_send" and current["progress"]["review_current"]
        handoff = call(browser, "GET", f"/cases/{case['id']}/handoff")
        packet, manifest = reviewed_packet(browser, packet_href(handoff, case["id"], prepared_revision, "current_review"),
            case_id=case["id"], revision=prepared_revision, origin="current_review", owner_id=owner.user_id,
            excluded=(unselected["id"], unselected_text.strip(), foreign["id"], foreign_text.strip(), private_example["farm"]["id"]))
        for document, literal in evidence.values():
            path = f"originals/{document['id']}-v{document['revision']}.txt"
            assert packet[path] == literal.encode()
            assert any(file["path"] == path and file["source"] == {"kind": "documents", "id": document["id"], "revision": document["revision"]}
                       for file in manifest["files"])
        correction_file = f"fields/{corrected_proposal['id']}-v{corrected_proposal['revision']}.json"
        assert json.loads(packet[correction_file])["proposed_parcels"][0]["geometry"] == scenario["reference_geometry"]
        assert owner.get(f"/cases/{case['id']}").json()["data"]["status"] == "ready_to_send", "Downloading a folder must not send it."

        today = date.today().isoformat()
        sent = call(browser, "POST", f"/cases/{case['id']}/events", expected=201, json={"expected_revision": case["revision"],
            "action": "sent", "date": today, "reference": "FICTIONAL-MANUAL-CORRECTION-01",
            "note": "Farmer manually recorded handing over this exact fictional example folder; the app sent nothing.", "acknowledged": True})
        assert sent["case"]["data"]["status"] == "sent"
        assert sent["event"]["data"]["sealed_bundle"]["case_revision"] == prepared_revision
        receipt_body = {"expected_revision": sent["case"]["revision"], "action": "receipt", "date": today,
            "reference": "FICTIONAL-RECEIPT-01", "note": "Farmer recorded a supplied fictional receipt, not independently verified authority acceptance.", "acknowledged": True}
        call(browser, "POST", f"/cases/{case['id']}/events", expected=422, json=receipt_body)
        receipt_text = "FICTIONAL RECEIPT FOR THE CAP EXAMPLE\nReference: FICTIONAL-RECEIPT-01\nNot issued by an authority and not proof of acceptance.\n"
        receipt = upload(owner, farm["id"], "FICTIONAL-manual-receipt.txt", receipt_text)
        received = call(browser, "POST", f"/cases/{case['id']}/events", expected=201, json={**receipt_body,
            "document_id": receipt["id"], "document_revision": receipt["revision"]})
        assert received["case"]["data"]["status"] == "receipt_saved"
        assert received["case"]["data"]["external_status_notice"]
        current = call(browser, "GET", f"/examples/cap/{example['run_id']}")
        assert current["case"]["data"]["status"] == current["progress"]["case_status"] == "receipt_saved"
        assert not current["progress"]["can_review"] and not current["progress"]["review_current"]
        assert current["farm"]["revision"] == corrected_farm["revision"]
        assert current["proposal"]["data"]["status"] == "approved"
        assert owner.get("/reports").json()["total"] == owner.get("/facts").json()["total"] == owner.get("/operations").json()["total"] == 0
        for reference in task_references:
            assert owner.get(f"/tasks/{reference['id']}").json()["data"]["status"] == "open", "An example event must not manufacture an authority task outcome."
        final_retry = call(browser, "POST", "/examples/cap", expected=201, headers=stable_key, json=acknowledge)
        assert final_retry["run_id"] == example["run_id"] and final_retry["case"]["revision"] == received["case"]["revision"]
        assert owner.get("/farms").json()["total"] == 1
