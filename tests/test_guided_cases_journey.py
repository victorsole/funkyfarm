"""Three guided farmer jobs through public HTTP, with no authority transport.

Acceptance oracles are pinned in runtime/guided-cases/contract.json: preparation
review is not sending, a person's delivery notes do not verify authority status,
and a sealed historic selection cannot silently become a different response.
Authored fixtures below are fictional, not legal deadlines or official notices.
"""

from copy import deepcopy
from datetime import date, timedelta
from hashlib import sha256
from io import BytesIO
import json
from pathlib import PurePosixPath
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4
from zipfile import ZipFile

import httpx

from conftest import confirm, fact_data, farm_data, human_browser


def call(client, method, path, *, expected=200, **kwargs):
    response = client.request(method, path, **kwargs)
    assert response.status_code == expected, f"{method} {path}: {response.status_code} {response.text[:2000]}"
    return response.json()


def reference(record, role):
    return {"kind": record["kind"], "id": record["id"], "revision": record["revision"], "role": role}


def upload(owner, farm_id, name, text):
    return owner.post("/documents", expected=201, data={"farm_id": farm_id},
        files={"file": (name, text.encode(), "text/plain")}).json()


def issued_report(owner, farm_id, *, fact, document=None):
    draft = owner.post("/reports", expected=201, json={"farm_id": farm_id, "pack_id": "inspection-evidence",
        "reporting_year": 2026, "fact_ids": [fact["id"]],
        "selected_document_ids": [document["id"]] if document else []}).json()
    return owner.post(f"/reports/{draft['id']}/approve", json={"expected_revision": draft["revision"]}).json()


def review_case(client, record):
    checked = call(client, "GET", f"/cases/{record['id']}/checks")
    assert checked["case_revision"] == record["revision"] and checked["can_review"], checked["issues"]
    reviewed = call(client, "POST", f"/cases/{record['id']}/review", json={"expected_revision": record["revision"],
        "expected_fingerprint": checked["fingerprint"], "acknowledged": True})
    assert reviewed["data"]["status"] == "ready_to_send"
    return reviewed


def unpack_packet(response):
    assert response.status_code == 200, response.text[:2000]
    assert response.headers["content-type"].split(";", 1)[0] == "application/zip"
    assert "no-store" in response.headers["cache-control"]
    assert len(response.content) <= 128 * 1024 * 1024
    with ZipFile(BytesIO(response.content)) as archive:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        assert len(names) == len(set(names)), "Duplicate archive paths could replace an earlier selected original."
        assert sum(entry.file_size for entry in entries) <= 128 * 1024 * 1024
        for name in names:
            assert not PurePosixPath(name).is_absolute() and ".." not in PurePosixPath(name).parts
            assert "\\" not in name and ":" not in name
        assert archive.testzip() is None
        members = {entry.filename: archive.read(entry) for entry in entries if not entry.is_dir()}
    assert {"index.html", "index.txt", "manifest.json"} <= members.keys()
    manifest = json.loads(members["manifest.json"])
    assert manifest["version"] == 1 and manifest["notice"]
    indexed = {entry["path"]: entry for entry in manifest["files"]}
    assert len(indexed) == len(manifest["files"])
    assert set(indexed) == members.keys() - {"manifest.json"}, "Every selected archive member needs a complete manifest entry."
    for path, entry in indexed.items():
        assert entry["size_bytes"] == len(members[path])
        assert entry["sha256"] == sha256(members[path]).hexdigest()
        assert entry["label"] and entry["media_type"]
    assert all(len(source["checksum"]) == 64 for source in manifest["source_records"])
    return members, manifest


def packet_href(handoff, case_id, revision, origin):
    packets = [item for item in handoff["downloads"] if urlsplit(item["href"]).path == f"/api/v1/cases/{case_id}/packet"]
    assert len(packets) == 1, "The full folder must be an explicit version-bound download."
    href = packets[0]["href"]
    parsed = urlsplit(href)
    assert not parsed.scheme and not parsed.netloc
    query = parse_qs(parsed.query)
    key = "expected_revision" if origin == "current_review" else "retained_revision"
    assert query[key] == [str(revision)] and len({"expected_revision", "retained_revision"} & query.keys()) == 1
    assert query["reference_fingerprint"] == [handoff["reference_fingerprint"]]
    return href.removeprefix("/api/v1")


def reviewed_packet(client, href, *, case_id, revision, origin, owner_id, excluded):
    members, manifest = unpack_packet(client.get(href))
    assert manifest["case_id"] == case_id and manifest["case_revision"] == revision
    assert manifest["origin"] == origin and manifest["review"]["actor_id"] == owner_id
    assert manifest["reference_fingerprint"] == parse_qs(urlsplit(href).query)["reference_fingerprint"][0]
    assert manifest["review"]["at"]
    for literal in excluded:
        assert all(literal.encode() not in content for content in members.values()), "An unrelated farm record leaked into a selected folder."
    return members, manifest


def test_three_guided_cases_keep_current_review_and_manual_delivery_distinct(farmers, service_url):
    owner, outsider, adviser = (farmers(name) for name in (
        "Guided farmer", "Unrelated case reader", "Read-only case adviser"))
    farm = owner.create("farms", {**farm_data("Fictional Dutch guided holding"), "country": "NL", "region": None})
    other = owner.create("farms", {**farm_data("Different private holding"), "country": "NL", "region": None})
    today = date.today().isoformat()
    future = (date.today() + timedelta(days=1)).isoformat()
    submitted = (date.today() - timedelta(days=5)).isoformat()
    notice_text = "FICTIONAL INSPECTION NOTICE\nRequested record: actual holding area and its checked source.\nNo legal deadline supplied.\n"
    notice = upload(owner, farm["id"], "authored-inspection-notice.txt", notice_text)
    evidence_text = "FICTIONAL REVIEWED HOLDING RECORD\nArea: 3.75 ha.\nLiteral note: <script>alert('authored-only')</script>\n"
    evidence = upload(owner, farm["id"], "../../authored-<svg onload=alert(1)>.txt", evidence_text)
    foreign_text = "PRIVATE OTHER FARM RECORD " + uuid4().hex + "\n"
    foreign = upload(owner, other["id"], "other-farm-private.txt", foreign_text)
    unselected_text = "PRIVATE UNSELECTED SAME FARM RECORD " + uuid4().hex + "\n"
    unselected = upload(owner, farm["id"], "unselected-private-packet-source.txt", unselected_text)
    excluded_packet_content = (foreign["id"], foreign_text.strip(), unselected["id"], unselected_text.strip())
    outline = {"type": "Polygon", "coordinates": [[[5.0, 52.0], [5.002, 52.0], [5.002, 52.001], [5.0, 52.001], [5.0, 52.0]]]}
    proposal = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"],
        "parcel": {"name": "Fictional north field", "geometry": outline, "crop": "Farmer's own recorded crop"},
        "note": "Farmer-authored boundary for private comparison, not an official LPIS adoption."}).json()
    assert owner.get(f"/field-proposals/{proposal['id']}").json()["revision"] == proposal["revision"]
    invitation = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser",
        "farm_ids": [farm["id"]], "permissions": ["read"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": invitation["token"]})
    shared = {"X-Workspace-ID": owner.workspace_id}

    with human_browser(owner, service_url) as browser:
        seed = {"farm_id": farm["id"], "title": "Check the authored field boundary", "job_type": "fields",
            "reporting_year": 2026, "authority": "Authority named by this fictional farmer", "deadline": None,
            "references": [reference(proposal, "change")]}
        retry = {"Idempotency-Key": "guided-case-" + uuid4().hex}
        fields = call(browser, "POST", "/cases", expected=201, headers=retry, json=seed)
        assert call(browser, "POST", "/cases", expected=201, headers=retry, json=seed) == fields
        assert fields["data"]["status"] == "draft" and fields["data"]["review"] is None
        assert fields["data"]["deadline"] is None and "events" not in fields["data"]
        for change in ({"status": "ready_to_send"}, {"original_submitted_at": future}, {"original_submitted_at": "not-a-date"},
                       {"references": [reference(proposal, "change"), reference(proposal, "change")]}):
            call(browser, "POST", "/cases", expected=422, json={**seed, **change})
        wrong_farm = call(browser, "POST", "/cases", expected=422,
            json={**seed, "references": [reference(foreign, "evidence")]})
        assert wrong_farm["error"]["code"] == "case_reference_scope"
        stale_pin = call(browser, "POST", "/cases", expected=409, json={**seed,
            "references": [{**reference(proposal, "change"), "revision": proposal["revision"] + 1}]})
        assert stale_pin["error"]["code"] == "case_reference_changed"
        call(browser, "PATCH", f"/cases/{fields['id']}", expected=422,
            json={"expected_revision": fields["revision"], "data": {"farm_id": other["id"]}})
        for path in (f"/cases/{fields['id']}", f"/cases/{fields['id']}/checks", f"/cases/{fields['id']}/events"):
            outsider.get(path, expected=404)
            adviser.get(path, headers=shared)
        outsider.get("/cases", expected=404, params={"farm_id": farm["id"]})
        adviser.patch(f"/cases/{fields['id']}", expected=403, headers=shared,
            json={"expected_revision": fields["revision"], "data": {"title": "Read permission is not mutation permission"}})
        generic = owner.client.post("/admin_cases", json={"data": seed})
        assert generic.status_code in (403, 404, 422), generic.text
        credential = call(browser, "POST", "/assistant/credentials", expected=201, json={
            "name": "Authored case-boundary agent", "farm_ids": [farm["id"]], "permissions": ["read", "propose"], "expires_in_days": 1})
        with httpx.Client(base_url=service_url + "/", timeout=30,
                          headers={"Authorization": "Bearer " + credential["token"]}) as agent:
            for method, path, body in (("GET", f"/cases/{fields['id']}", None), ("POST", "/cases", seed)):
                assert agent.request(method, path, **({"json": body} if body else {})).status_code == 403
            assert agent.post("/assistant/execute/propose_capture", json={"arguments": {
                "farm_id": farm["id"], "expected_farm_revision": farm["revision"],
                "kind": "admin_cases", "data": {"title": "No generic assistant case capture"}}}).status_code == 422
            assert agent.post(f"/cases/{fields['id']}/review", json={"expected_revision": fields["revision"],
                "expected_fingerprint": "0" * 64, "acknowledged": True}).status_code == 403
            assert agent.post(f"/cases/{fields['id']}/events", json={"expected_revision": fields["revision"],
                "action": "sent", "date": today, "note": "Assistant credentials cannot record human sending.", "acknowledged": True}).status_code == 403
            assert agent.get(f"/cases/{fields['id']}/packet", params={"expected_revision": fields["revision"],
                "reference_fingerprint": "0" * 64}).status_code == 403

        # Check fields: current pins and explicit review, not applying a boundary.
        checked = call(browser, "GET", f"/cases/{fields['id']}/checks")
        assert checked["can_review"] and checked["references"][0]["current"]
        assert any(issue["severity"] == "warning" for issue in checked["issues"]), "Unknown national coverage must remain visible."
        call(browser, "GET", f"/cases/{fields['id']}/handoff", expected=409)
        call(browser, "GET", f"/cases/{fields['id']}/packet", expected=409, params={
            "expected_revision": fields["revision"], "reference_fingerprint": checked["fingerprint"]})
        call(browser, "POST", f"/cases/{fields['id']}/review", expected=422, json={
            "expected_revision": fields["revision"], "expected_fingerprint": checked["fingerprint"], "acknowledged": False})
        call(browser, "POST", f"/cases/{fields['id']}/review", expected=409, json={
            "expected_revision": fields["revision"], "expected_fingerprint": "0" * 64, "acknowledged": True})
        fields = review_case(browser, fields)
        handoff = call(browser, "GET", f"/cases/{fields['id']}/handoff")
        assert handoff["origin"] == "current_review"
        official = owner.get("/countries/NL").json()["portal"]["url"]
        assert handoff["official_url"] == official and urlsplit(official).scheme == "https"
        first_packet_href = packet_href(handoff, fields["id"], fields["revision"], "current_review")
        packet_members, packet_manifest = reviewed_packet(browser, first_packet_href, case_id=fields["id"], revision=fields["revision"],
            origin="current_review", owner_id=owner.user_id, excluded=excluded_packet_content)
        first_field_json = f"fields/{proposal['id']}-v{proposal['revision']}.json"
        assert json.loads(packet_members[first_field_json])["proposal_revision"] == proposal["revision"]
        assert json.loads(packet_members[first_field_json])["proposed_parcels"][0]["geometry"] == outline
        assert any(source["id"] == proposal["id"] and source["revision"] == proposal["revision"] for source in packet_manifest["source_records"])
        packet_path = f"/cases/{fields['id']}/packet"
        packet_parameters = {"expected_revision": fields["revision"], "reference_fingerprint": handoff["reference_fingerprint"]}
        call(browser, "GET", packet_path, expected=422, params={"reference_fingerprint": handoff["reference_fingerprint"]})
        call(browser, "GET", packet_path, expected=422, params={**packet_parameters, "retained_revision": fields["revision"]})
        call(browser, "GET", packet_path, expected=409, params={**packet_parameters, "expected_revision": fields["revision"] - 1})
        call(browser, "GET", packet_path, expected=409, params={**packet_parameters, "reference_fingerprint": "0" * 64})
        outsider.get(packet_path, expected=404, params=packet_parameters)
        field_downloads = [item for item in handoff["downloads"] if urlsplit(item["href"]).path.startswith("/api/v1/field-proposals/")]
        assert len(field_downloads) == 3 and len(handoff["downloads"]) == 4
        geojson_href = None
        for download in field_downloads:
            parsed = urlsplit(download["href"])
            assert not parsed.scheme and not parsed.netloc
            assert parsed.path == f"/api/v1/field-proposals/{proposal['id']}/export"
            assert parse_qs(parsed.query)["expected_revision"] == [str(proposal["revision"])]
            if parse_qs(parsed.query)["format"] == ["geojson"]:
                geojson_href = download["href"]
        assert geojson_href
        export = owner.get(geojson_href.removeprefix("/api/v1"))
        assert "no-store" in export.headers["cache-control"]
        assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
        changed_proposal = owner.patch(f"/field-proposals/{proposal['id']}", json={"expected_revision": proposal["revision"],
            "expected_farm_revision": farm["revision"], "note": "Farmer clarified the private outline after its case review."}).json()
        assert changed_proposal["revision"] > proposal["revision"]
        assert not call(browser, "GET", f"/cases/{fields['id']}/checks")["can_review"]
        call(browser, "GET", f"/cases/{fields['id']}/handoff", expected=409)
        call(browser, "GET", first_packet_href, expected=409)
        owner.get(geojson_href.removeprefix("/api/v1"), expected=409)
        call(browser, "POST", f"/cases/{fields['id']}/events", expected=409, json={"expected_revision": fields["revision"],
            "action": "sent", "date": today, "note": "A stale field selection must not be recorded as freshly reviewed.", "acknowledged": True})
        reopened = call(browser, "POST", f"/cases/{fields['id']}/events", expected=201, json={"expected_revision": fields["revision"],
            "action": "reopen", "date": today, "note": "Compare the revised private boundary before preparing it.", "acknowledged": True})
        fields = call(browser, "PATCH", f"/cases/{fields['id']}", json={"expected_revision": reopened["case"]["revision"],
            "data": {"references": [reference(changed_proposal, "change")]}})
        assert fields["data"]["review"] is None
        fields = review_case(browser, fields)
        fresh_field_handoff = call(browser, "GET", f"/cases/{fields['id']}/handoff")
        prepared_field_revision = fields["revision"]
        reviewed_field_packet, _ = reviewed_packet(browser,
            packet_href(fresh_field_handoff, fields["id"], prepared_field_revision, "current_review"),
            case_id=fields["id"], revision=prepared_field_revision, origin="current_review",
            owner_id=owner.user_id, excluded=excluded_packet_content)
        field_exports = {parse_qs(urlsplit(download["href"]).query)["format"][0]:
            owner.get(download["href"].removeprefix("/api/v1")).content
            for download in fresh_field_handoff["downloads"] if urlsplit(download["href"]).path.startswith("/api/v1/field-proposals/")}
        field_sent = call(browser, "POST", f"/cases/{fields['id']}/events", expected=201, json={"expected_revision": fields["revision"],
            "action": "sent", "date": today, "reference": "AUTHORED-FIELD-001", "note": "Farmer manually recorded handing over this checked private field proposal.", "acknowledged": True})
        assert field_sent["case"]["data"]["status"] == "sent"
        assert field_sent["event"]["data"]["sealed_bundle"]["content"]["references"] == [reference(changed_proposal, "change")]
        assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == [], "A case or manual sent note cannot apply a field change."
        sealed_field_handoff = call(browser, "GET", f"/cases/{fields['id']}/handoff")
        assert sealed_field_handoff["origin"] == "sealed_sent_bundle"
        historical_hrefs = {}
        sent_proposal_revision = changed_proposal["revision"]
        for download in sealed_field_handoff["downloads"]:
            if not urlsplit(download["href"]).path.startswith("/api/v1/field-proposals/"):
                continue
            query = parse_qs(urlsplit(download["href"]).query)
            assert query["retained_revision"] == [str(sent_proposal_revision)] and "expected_revision" not in query
            historical_hrefs[query["format"][0]] = download["href"]
        revised_outline = deepcopy(outline)
        revised_outline["coordinates"][0][1][0] = 5.003
        revised_outline["coordinates"][0][2][0] = 5.003
        changed_proposal = owner.patch(f"/field-proposals/{changed_proposal['id']}", json={
            "expected_revision": sent_proposal_revision, "expected_farm_revision": farm["revision"],
            "parcel": {"name": "Later private boundary draft, not the sent selection", "geometry": revised_outline},
            "note": "A new private edit must not rewrite the earlier recorded handoff."}).json()
        for format in ("geojson", "correction"):
            historic = owner.get(historical_hrefs[format].removeprefix("/api/v1"))
            assert historic.content == field_exports[format] and "no-store" in historic.headers["cache-control"]
        current_export = owner.get(f"/field-proposals/{changed_proposal['id']}/export", params={
            "format": "correction", "expected_revision": changed_proposal["revision"]}).json()
        assert current_export["proposal_revision"] == changed_proposal["revision"]
        assert current_export["proposed_parcels"][0]["geometry"] == revised_outline
        owner.get(f"/field-proposals/{changed_proposal['id']}/export", expected=409,
            params={"format": "correction", "expected_revision": sent_proposal_revision})
        owner.get(f"/field-proposals/{changed_proposal['id']}/export", expected=422, params={
            "format": "correction", "expected_revision": changed_proposal["revision"], "retained_revision": sent_proposal_revision})
        outsider.get(historical_hrefs["correction"].removeprefix("/api/v1"), expected=404)
        retained_handoff = call(browser, "GET", f"/cases/{fields['id']}/handoff")
        assert retained_handoff["downloads"] == sealed_field_handoff["downloads"]
        retained_field_packet_href = packet_href(retained_handoff, fields["id"], prepared_field_revision, "sealed_sent_bundle")
        retained_field_packet, retained_field_manifest = reviewed_packet(browser, retained_field_packet_href,
            case_id=fields["id"], revision=prepared_field_revision, origin="sealed_sent_bundle",
            owner_id=owner.user_id, excluded=excluded_packet_content)
        for suffix in ("geojson", "json"):
            path = f"fields/{changed_proposal['id']}-v{sent_proposal_revision}.{suffix}"
            assert json.loads(retained_field_packet[path]) == json.loads(reviewed_field_packet[path])
        assert json.loads(retained_field_packet[f"fields/{changed_proposal['id']}-v{sent_proposal_revision}.json"])["proposed_parcels"][0]["geometry"] == outline
        assert any(source["id"] == changed_proposal["id"] and source["revision"] == sent_proposal_revision for source in retained_field_manifest["source_records"])

        # Inspection: the notice defines scope; visible unresolved items block preparation.
        inspection = call(browser, "POST", "/cases", expected=201, json={"farm_id": farm["id"], "job_type": "inspection",
            "reporting_year": 2026, "title": "Prepare the authored inspection records"})
        assert not call(browser, "GET", f"/cases/{inspection['id']}/checks")["can_review"]
        inspection = call(browser, "PATCH", f"/cases/{inspection['id']}", json={"expected_revision": inspection["revision"],
            "data": {"references": [reference(notice, "notice")]}})
        inspection = call(browser, "POST", f"/cases/{inspection['id']}/items", expected=201, json={
            "expected_revision": inspection["revision"], "kind": "requested_record", "title": "Supply the area record named in the notice",
            "description": "Check the original requested holding record; no automatic legal completeness claim.", "due_date": None})
        entry = inspection["data"]["items"][0]
        assert entry["status"] == "open"
        assert not call(browser, "GET", f"/cases/{inspection['id']}/checks")["can_review"]
        item_body = {"expected_revision": inspection["revision"], "status": "resolved", "note": "Compared the actual supplied record with the notice.",
            "document_ids": [], "document_revisions": {}, "acknowledged": True}
        call(browser, "POST", f"/cases/{inspection['id']}/items/{entry['id']}/review", expected=422, json=item_body)
        call(browser, "POST", f"/cases/{inspection['id']}/items/{entry['id']}/review", expected=422,
            json={**item_body, "document_ids": [foreign["id"]], "document_revisions": {foreign["id"]: foreign["revision"]}})
        inspection = call(browser, "POST", f"/cases/{inspection['id']}/items/{entry['id']}/review",
            json={**item_body, "status": "in_progress"})
        assert not call(browser, "GET", f"/cases/{inspection['id']}/checks")["can_review"]
        inspection = call(browser, "POST", f"/cases/{inspection['id']}/items/{entry['id']}/review", json={**item_body,
            "expected_revision": inspection["revision"], "document_ids": [evidence["id"]], "document_revisions": {evidence["id"]: evidence["revision"]}})
        assert inspection["data"]["items"][0]["document_pins"] == [{"id": evidence["id"], "revision": evidence["revision"]}]
        old_evidence_revision = evidence["revision"]
        evidence = owner.patch(f"/documents/{evidence['id']}", json={"expected_revision": evidence["revision"],
            "data": {"notes": "Farmer supplied a later annotation of this inspection source.",
                     "title": "../../authored-<svg onload=alert(1)>.txt"}}).json()
        assert not call(browser, "GET", f"/cases/{inspection['id']}/checks")["can_review"]
        call(browser, "POST", f"/cases/{inspection['id']}/items/{entry['id']}/review", expected=409, json={**item_body,
            "expected_revision": inspection["revision"], "document_ids": [evidence["id"]],
            "document_revisions": {evidence["id"]: old_evidence_revision}})
        assert call(browser, "GET", f"/cases/{inspection['id']}")["revision"] == inspection["revision"]
        inspection = call(browser, "POST", f"/cases/{inspection['id']}/items/{entry['id']}/review", json={**item_body,
            "expected_revision": inspection["revision"], "document_ids": [evidence["id"]], "document_revisions": {evidence["id"]: evidence["revision"]}})
        inspection = review_case(browser, inspection)
        assert inspection["data"]["status"] == "ready_to_send", "Finishing an app inspection item is not sending or authority acceptance."
        inspection_handoff = call(browser, "GET", f"/cases/{inspection['id']}/handoff")
        inspection_packet, inspection_manifest = reviewed_packet(browser,
            packet_href(inspection_handoff, inspection["id"], inspection["revision"], "current_review"),
            case_id=inspection["id"], revision=inspection["revision"], origin="current_review",
            owner_id=owner.user_id, excluded=excluded_packet_content)
        for document, literal in ((notice, notice_text), (evidence, evidence_text)):
            path = f"originals/{document['id']}-v{document['revision']}.txt"
            assert inspection_packet[path] == literal.encode()
            descriptor = next(item for item in inspection_manifest["files"] if item["path"] == path)
            assert descriptor["sha256"] == document["data"]["sha256"] == sha256(literal.encode()).hexdigest()
            assert descriptor["source"] == {"kind": "documents", "id": document["id"], "revision": document["revision"]}
        inspection_html = inspection_packet["index.html"].decode()
        assert "<svg onload=alert(1)>" not in inspection_html
        assert "&lt;svg onload=alert(1)&gt;" in inspection_html

        # Correction: a retained stale original is legitimate history, but a stale
        # proposed response is not a current reviewed submission bundle.
        fact = confirm(owner, owner.create("facts", fact_data(farm["id"], value="3.75", basis="static", period=None,
            sources=[{"document_id": unselected["id"], "document_revision": unselected["revision"],
                      "origin": "Private source checked for this authored area fact; not selected for recipient sharing."}])))
        old_source = upload(owner, farm["id"], "authored-original-submitted-source.txt", "FICTIONAL ORIGINAL HOLDING RESPONSE\n")
        original = issued_report(owner, farm["id"], fact=fact, document=old_source)
        original_file = owner.get(f"/reports/{original['id']}/download", params={"format": "json"}).content
        old_source = owner.patch(f"/documents/{old_source['id']}", json={"expected_revision": old_source["revision"],
            "data": {"notes": "Source corrected after the old response was issued."}}).json()
        response_source = upload(owner, farm["id"], "authored-current-response-source.txt", "FICTIONAL REVIEWED RESPONSE EVIDENCE\n")
        response = issued_report(owner, farm["id"], fact=fact, document=response_source)
        correction_seed = {"farm_id": farm["id"], "title": "Correct an authored submitted mistake", "job_type": "correction", "reporting_year": 2026,
            "original_reference": "0000-AUTHORED-SUBMISSION-01", "original_submitted_at": submitted,
            "reason": "The submitted source description was wrong. Literal source annotation: <img src=x onerror=alert(1)>. Supply the reviewed replacement, without changing the retained original.",
            "references": [reference(original, "original"), reference(original, "response")]}
        correction = call(browser, "POST", "/cases", expected=201, json=correction_seed)
        assert not call(browser, "GET", f"/cases/{correction['id']}/checks")["can_review"]
        unapproved = owner.post("/reports", expected=201, json={"farm_id": farm["id"], "pack_id": "inspection-evidence",
            "reporting_year": 2026, "fact_ids": [fact["id"]]}).json()
        correction = call(browser, "PATCH", f"/cases/{correction['id']}", json={"expected_revision": correction["revision"],
            "data": {"references": [reference(original, "original"), reference(unapproved, "response")]}})
        assert not call(browser, "GET", f"/cases/{correction['id']}/checks")["can_review"], "A draft report must not stand in for a separately approved response."
        correction = call(browser, "PATCH", f"/cases/{correction['id']}", json={"expected_revision": correction["revision"],
            "data": {"references": [reference(original, "original"), reference(response, "response")]}})
        checked = call(browser, "GET", f"/cases/{correction['id']}/checks")
        assert checked["can_review"], checked["issues"]
        assert any(issue["code"] == "case_original_report_changed" and issue["severity"] == "warning" for issue in checked["issues"])
        correction = review_case(browser, correction)
        owner.patch(f"/documents/{response_source['id']}", json={"expected_revision": response_source["revision"],
            "data": {"notes": "Response evidence changed after the case preparation review."}})
        changed_checks = call(browser, "GET", f"/cases/{correction['id']}/checks")
        assert not changed_checks["can_review"]
        assert changed_checks["fingerprint"] != correction["data"]["review"]["fingerprint"]
        call(browser, "POST", f"/cases/{correction['id']}/events", expected=409, json={"expected_revision": correction["revision"],
            "action": "sent", "date": today, "note": "Do not send the stale response under the old review.", "acknowledged": True})
        reopened = call(browser, "POST", f"/cases/{correction['id']}/events", expected=201, json={"expected_revision": correction["revision"],
            "action": "reopen", "date": today, "note": "Prepare and review the actual current response separately.", "acknowledged": True})
        fresh_response = issued_report(owner, farm["id"], fact=fact)
        correction = call(browser, "PATCH", f"/cases/{correction['id']}", json={"expected_revision": reopened["case"]["revision"],
            "data": {"references": [reference(original, "original"), reference(fresh_response, "response")]}})
        correction = review_case(browser, correction)
        prepared = call(browser, "GET", f"/cases/{correction['id']}/handoff")
        copied = {field["label"]: field["value"] for field in prepared["fields"]}
        assert copied["Original reference"] == correction_seed["original_reference"] and copied["Reason and changes"] == correction_seed["reason"]
        assert copied["Recorded original submission date"] == submitted
        assert prepared["official_url"] == official
        report_downloads = [item for item in prepared["downloads"] if urlsplit(item["href"]).path.startswith("/api/v1/reports/")]
        assert len(report_downloads) == 8 and len(prepared["downloads"]) == 9
        assert all(not urlsplit(download["href"]).netloc for download in prepared["downloads"])
        first_prepared_revision = correction["revision"]
        first_correction_packet_href = packet_href(prepared, correction["id"], first_prepared_revision, "current_review")
        first_correction_packet, correction_manifest = reviewed_packet(browser, first_correction_packet_href,
            case_id=correction["id"], revision=first_prepared_revision, origin="current_review",
            owner_id=owner.user_id, excluded=excluded_packet_content)
        selected_report_original = f"originals/{old_source['id']}-v{old_source['revision']}.txt"
        assert first_correction_packet[selected_report_original] == b"FICTIONAL ORIGINAL HOLDING RESPONSE\n"
        for report in (original, fresh_response):
            stem = f"reports/{report['id']}-v{report['revision']}"
            assert first_correction_packet[stem + ".pdf"].startswith(b"%PDF-")
            assert first_correction_packet[stem + ".xlsx"].startswith(b"PK")
            assert json.loads(first_correction_packet[stem + ".json"])["snapshot"] == report["data"]["snapshot"]
            assert any(source["kind"] == "reports" and source["id"] == report["id"] and source["revision"] == report["revision"]
                       for source in correction_manifest["source_records"])
        correction_html = first_correction_packet["index.html"].decode()
        assert "<img src=x onerror=alert(1)>" not in correction_html
        assert "&lt;img src=x onerror=alert(1)&gt;" in correction_html
        assert correction_seed["reason"] in first_correction_packet["index.txt"].decode()
        send_body = {"expected_revision": correction["revision"], "action": "sent", "date": today,
            "note": "Farmer manually recorded sending this exact reviewed correction.", "reference": "0000-AUTHORED-CORRECTION-01", "acknowledged": True}
        send_retry = {"Idempotency-Key": "guided-sent-" + uuid4().hex}
        sent = call(browser, "POST", f"/cases/{correction['id']}/events", expected=201, headers=send_retry, json=send_body)
        assert call(browser, "POST", f"/cases/{correction['id']}/events", expected=201, headers=send_retry, json=send_body) == sent
        sealed_first = deepcopy(sent["event"])
        assert sent["case"]["data"]["status"] == "sent"
        assert sealed_first["data"]["sealed_bundle"]["content"]["references"] == correction["data"]["references"]
        assert sealed_first["data"]["sealed_bundle"]["handoff"]["fields"] == prepared["fields"]
        correction = sent["case"]
        call(browser, "PATCH", f"/cases/{correction['id']}", expected=409,
            json={"expected_revision": correction["revision"], "data": {"reason": "Must explicitly reopen or record requested changes first."}})
        changes = call(browser, "POST", f"/cases/{correction['id']}/events", expected=201, json={"expected_revision": correction["revision"],
            "action": "needs_changes", "date": today, "note": "Farmer recorded a request to clarify the correction explanation.", "acknowledged": True})
        correction = call(browser, "PATCH", f"/cases/{correction['id']}", json={"expected_revision": changes["case"]["revision"],
            "data": {"reason": "Clarified exactly which source description changed; the original submitted response remains retained."}})
        assert correction["data"]["review"] is None
        historical = call(browser, "GET", f"/cases/{correction['id']}/handoff")
        assert historical["origin"] == "sealed_sent_bundle" and historical["fields"] == prepared["fields"]
        first_sealed_packet_href = packet_href(historical, correction["id"], first_prepared_revision, "sealed_sent_bundle")
        first_sealed_packet, _ = reviewed_packet(browser, first_sealed_packet_href,
            case_id=correction["id"], revision=first_prepared_revision, origin="sealed_sent_bundle",
            owner_id=owner.user_id, excluded=excluded_packet_content)
        assert correction_seed["reason"] in first_sealed_packet["index.txt"].decode()
        for report in (original, fresh_response):
            path = f"reports/{report['id']}-v{report['revision']}.json"
            assert json.loads(first_sealed_packet[path]) == json.loads(first_correction_packet[path])
        call(browser, "GET", first_correction_packet_href, expected=409)
        correction = review_case(browser, correction)
        new_handoff = call(browser, "GET", f"/cases/{correction['id']}/handoff")
        clarified_packet, _ = reviewed_packet(browser,
            packet_href(new_handoff, correction["id"], correction["revision"], "current_review"),
            case_id=correction["id"], revision=correction["revision"], origin="current_review",
            owner_id=owner.user_id, excluded=excluded_packet_content)
        assert correction["data"]["reason"] in clarified_packet["index.txt"].decode()
        second_sent = call(browser, "POST", f"/cases/{correction['id']}/events", expected=201, json={**send_body,
            "expected_revision": correction["revision"], "note": "Farmer recorded sending the separately reviewed clarification.", "reference": "0000-AUTHORED-CORRECTION-02"})
        correction = second_sent["case"]
        assert second_sent["event"]["id"] != sealed_first["id"]
        assert second_sent["event"]["data"]["sealed_bundle"]["content"]["reason"] != sealed_first["data"]["sealed_bundle"]["content"]["reason"]

        # Actual documented receipts and acceptance are human notes, not verified
        # authority responses, and must not mutate report filing/acceptance status.
        receipt_body = {"expected_revision": correction["revision"], "action": "receipt", "date": today,
            "note": "Farmer compared an authored receipt document.", "reference": "0000-RECEIPT-01", "acknowledged": True}
        call(browser, "POST", f"/cases/{correction['id']}/events", expected=422, json={**receipt_body, "date": future})
        call(browser, "POST", f"/cases/{correction['id']}/events", expected=422, json=receipt_body)
        call(browser, "POST", f"/cases/{correction['id']}/events", expected=422,
            json={**receipt_body, "document_id": foreign["id"], "document_revision": foreign["revision"]})
        receipt = upload(owner, farm["id"], "authored-manual-receipt.txt", "FICTIONAL RECEIPT\nReference: 0000-RECEIPT-01\nNot a live authority response.\n")
        call(browser, "POST", f"/cases/{correction['id']}/events", expected=409,
            json={**receipt_body, "document_id": receipt["id"], "document_revision": receipt["revision"] + 1})
        received = call(browser, "POST", f"/cases/{correction['id']}/events", expected=201,
            json={**receipt_body, "document_id": receipt["id"], "document_revision": receipt["revision"]})
        assert received["case"]["data"]["status"] == "receipt_saved"
        assert received["event"]["data"]["date"] == today and received["event"]["data"]["reference"] == "0000-RECEIPT-01"
        assert received["event"]["data"]["document_id"] == receipt["id"] and received["event"]["data"]["document_revision"] == receipt["revision"]
        acceptance = upload(owner, farm["id"], "authored-manual-acceptance-notice.txt", "FICTIONAL ACCEPTANCE NOTICE\nReference: 0000-ACCEPTED-01\nManually supplied, not independently verified.\n")
        accepted = call(browser, "POST", f"/cases/{correction['id']}/events", expected=201, json={
            "expected_revision": received["case"]["revision"], "action": "accepted", "date": today,
            "note": "Farmer recorded the exact supplied notice; the app has not verified authority acceptance.",
            "reference": "0000-ACCEPTED-01", "document_id": acceptance["id"], "document_revision": acceptance["revision"], "acknowledged": True})
        assert accepted["case"]["data"]["status"] == "accepted_recorded"
        assert accepted["event"]["data"]["document_id"] == acceptance["id"]
        assert accepted["event"]["data"]["document_revision"] == acceptance["revision"] and accepted["event"]["data"]["date"] == today
        assert accepted["case"]["data"]["external_status_notice"]
        after_acceptance_packet, _ = reviewed_packet(browser, first_sealed_packet_href,
            case_id=correction["id"], revision=first_prepared_revision, origin="sealed_sent_bundle",
            owner_id=owner.user_id, excluded=(*excluded_packet_content, receipt["id"], acceptance["id"]))
        assert after_acceptance_packet["index.txt"] == first_sealed_packet["index.txt"]
        for report in (original, fresh_response):
            path = f"reports/{report['id']}-v{report['revision']}.json"
            assert after_acceptance_packet[path] == first_sealed_packet[path]
        for report in (original, response, fresh_response):
            retained = owner.get(f"/reports/{report['id']}").json()["data"]
            assert retained["status"] == "issued" and retained["filing_status"] == "not_filed"
            assert retained["checksum"] == report["data"]["checksum"]
        assert owner.get(f"/reports/{original['id']}/download", params={"format": "json"}).content == original_file

        # Full audit history is separately paginated, immutable, and scoped.
        full_history = call(browser, "GET", f"/cases/{correction['id']}/events", params={"limit": 100})
        assert full_history["total"] == len(full_history["items"]) and full_history["total"] > 5
        rows = []
        for offset in range(0, full_history["total"], 2):
            page = call(browser, "GET", f"/cases/{correction['id']}/events", params={"limit": 2, "offset": offset})
            assert page["total"] == full_history["total"] and page["limit"] == 2 and page["offset"] == offset
            assert len(page["items"]) == min(2, full_history["total"] - offset)
            rows.extend(page["items"])
        assert [row["id"] for row in rows] == [row["id"] for row in full_history["items"]]
        assert len({row["id"] for row in rows}) == full_history["total"]
        assert call(browser, "GET", f"/cases/{correction['id']}/events/{sealed_first['id']}") == sealed_first
        assert {sent["event"]["id"], second_sent["event"]["id"], received["event"]["id"], accepted["event"]["id"]} <= {row["id"] for row in rows}
        assert all("sealed_bundle" not in row.get("data", {}) for row in rows), "A history list must not eagerly embed retained sent bundles."
        forged_history = owner.client.patch(f"/admin_case_events/{sealed_first['id']}", json={
            "expected_revision": sealed_first["revision"], "data": {"note": "Cannot overwrite a retained sent selection"}})
        assert forged_history.status_code in (403, 404, 422), forged_history.text
        outsider.get(f"/cases/{correction['id']}/handoff", expected=404)
        outsider.get(f"/cases/{correction['id']}/events", expected=404)
        outsider.get(f"/cases/{correction['id']}/events/{sealed_first['id']}", expected=404)
        adviser.get(f"/cases/{correction['id']}/events/{sealed_first['id']}", headers=shared)
        first_page = call(browser, "GET", "/cases", params={"farm_id": farm["id"], "limit": 2, "offset": 0})
        last_page = call(browser, "GET", "/cases", params={"farm_id": farm["id"], "limit": 2, "offset": 2})
        assert first_page["total"] == last_page["total"] == 3
        assert {item["id"] for item in first_page["items"] + last_page["items"]} == {fields["id"], inspection["id"], correction["id"]}
        filtered = call(browser, "GET", "/cases", params={"farm_id": farm["id"], "job_type": "inspection"})
        assert filtered["total"] == 1 and filtered["items"][0]["id"] == inspection["id"]
        related_path = f"/field-proposals/{changed_proposal['id']}/related-records"
        linked = owner.get(related_path, params={"section": "cases", "expected_revision": changed_proposal["revision"], "limit": 1, "offset": 0}).json()
        beyond = owner.get(related_path, params={"section": "cases", "expected_revision": changed_proposal["revision"], "limit": 1, "offset": 1}).json()
        assert linked["total"] == beyond["total"] == 1
        assert [item["id"] for item in linked["items"]] == [fields["id"]] and beyond["items"] == []
        assert linked["items"][0]["href"].startswith("/app/cases/")
        owner.get(related_path, expected=409, params={"section": "cases", "expected_revision": proposal["revision"], "limit": 1})
        outsider.get(related_path, expected=404, params={"section": "cases", "expected_revision": changed_proposal["revision"], "limit": 1})
