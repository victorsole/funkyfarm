"""Fictional parcel checks, source-bound answer review and retained handoff.

The fixture's seven authored scenarios are training data. Technical overlap,
an EU timing ceiling and a private review never establish CAP eligibility,
permission to amend, an official LPIS change or authority filing.
"""

from datetime import date
import json
from uuid import uuid4

import httpx

from conftest import farm_data, human_browser
from test_guided_cases_journey import call, packet_href, reviewed_packet


FIXTURE = "lpis-correction-2026-v1"
SCENARIOS = {"nl-overlap", "cz-area-crop", "es-protected-unknown", "nl-missing-documents",
             "cz-mock-amendment-window", "sk-announced-check", "nl-ams-response"}


def test_focused_parcels_demo_scope_answer_checks_and_sealed_handoff(farmers, service_url):
    owner, outsider, reader, adviser = (farmers(name) for name in (
        "Focused fictional farmer", "Unrelated parcel reader", "Read-only parcel adviser", "Reviewing parcel adviser"))
    start = {"fixture_id": FIXTURE, "acknowledged": True}
    retry_key = {"Idempotency-Key": "focused-demo-" + uuid4().hex}
    with human_browser(owner, service_url) as browser:
        assert call(browser, "POST", "/examples/workspace", expected=400, json=start)["error"]["code"] == "idempotency_key_required"
        call(browser, "POST", "/examples/workspace", expected=422, headers=retry_key, json={**start, "acknowledged": False})
        call(browser, "POST", "/examples/workspace", expected=422, headers=retry_key, json={**start, "acknowledged": "true"})
        demo = call(browser, "POST", "/examples/workspace", expected=201, headers=retry_key, json=start)
        replay = call(browser, "POST", "/examples/workspace", expected=201, headers=retry_key, json=start)
        assert replay["run_id"] == demo["run_id"] and replay["workspace"]["id"] == demo["workspace"]["id"]
        assert demo["workspace"]["id"] != owner.workspace_id and demo["workspace"]["role"] == "owner"
        assert "fictional" in demo["notice"].lower() and demo["fixture_record_count"] == 39
        assert demo["fixture_version"] == 2
        base = [record for record in demo["records"] if record["kind"] not in {"admin_case_events", "demo_runs"}]
        assert len(base) == 39 and len({record["id"] for record in base}) == 39
        assert demo["record_count"] == len(demo["records"]) == sum(item["count"] for item in demo["inventory"])
        assert {scenario["id"] for scenario in demo["scenarios"]} == SCENARIOS
        assert all(len([record for record in base if record["scenario_id"] == scenario]) ==
                   (9 if scenario == "es-protected-unknown" else 5) for scenario in SCENARIOS)
        assert all(scenario["farmer_goal"] and scenario["adviser_goal"] and scenario["primary_start"]["href"].startswith("/app/") for scenario in demo["scenarios"])
        assert all(case["status"] == "draft" and not case["checks"]["can_review"]
                   for scenario in demo["scenarios"] for case in scenario["cases"])
        assert all(record["status"] == "proposed" for record in base if record["kind"] in {"facts", "operations", "field_change_proposals"})
        records = {record["alias"]: record for record in base}
        scope = {"X-Workspace-ID": demo["workspace"]["id"]}
        assert owner.get("/farms").json()["total"] == 0, "Training farms must not appear in the original workspace."
        call(browser, "GET", f"/examples/workspace/{demo['run_id']}", expected=404)
        browser.headers.update(scope)
        assert call(browser, "GET", "/farms")["total"] == 7
        outsider.get(f"/examples/workspace/{demo['run_id']}", expected=404)
        call(browser, "GET", f"/examples/workspace/{demo['run_id']}")
        originals = {}
        for record in base:
            if record["kind"] == "documents":
                response = browser.get(f"/documents/{record['id']}/file")
                assert response.status_code == 200 and "no-store" in response.headers["cache-control"]
                assert b"FICTIONAL" in response.content
                originals[record["id"]] = response.content
        assert len(originals) == 6

        # Spain's supplied figures are not a command to resize a physical
        # pasture. The proposed claim is separate from the original claim.
        es_farm = call(browser, "GET", f"/farms/{records['es-farm']['id']}")
        es_parcel = es_farm["data"]["parcels"][0]
        es_facts = {}
        for summary in base:
            if summary["kind"] == "facts" and summary["farm_id"] == es_farm["id"]:
                fact = call(browser, "GET", f"/facts/{summary['id']}")
                es_facts[fact["data"]["key"]] = fact
        expected_figures = {"cap.claimed_area_ha": (6.7, "ha"), "cap.supplied_max_eligible_area_ha": (3.02, "ha"),
                            "cap.pasture_coefficient_percent": (45, "%"), "cap.proposed_claim_area_ha": (3.02, "ha")}
        assert set(es_facts) == set(expected_figures)
        for key, (value, unit) in expected_figures.items():
            fact = es_facts[key]
            assert fact["data"]["value"] == value and fact["data"]["unit"] == unit
            assert fact["data"]["review_status"] == "proposed" and fact["data"]["parcel_id"] == es_parcel["id"]
            assert fact["data"]["period"] == "2026" and fact["data"]["temporal_basis"] == "campaign_year"
            assert fact["data"]["sources"] and all(source["document_id"] in originals and source["document_revision"] == 1
                                                   for source in fact["data"]["sources"])
        assert "supersedes_id" not in es_facts["cap.proposed_claim_area_ha"]["data"]
        assert b"6.70 ha" in originals[records["es-original-claim"]["id"]]

        def spanish_check():
            result = call(browser, "GET", f"/farms/{es_farm['id']}/parcel-check", params={
                "expected_farm_revision": es_farm["revision"], "reporting_year": 2026, "limit": 100})
            assert result["field_count"] == 1
            return result, result["fields"][0]

        es_initial, es_field = spanish_check()
        assert 6.69 < es_field["outline_area_ha"] < 6.71
        assert es_field["claimed_area_ha"] is None and es_field["eligible_area_ha"] is None
        context = es_field["claim_context"]
        assert context["status"] == "unconfirmed"
        assert {key: context[key] for key in ("declared", "max", "coefficient", "proposed_claim", "excess")} == {
            "declared": 6.7, "max": 3.02, "coefficient": 45, "proposed_claim": 3.02, "excess": 3.68}
        assert context["proposed_claim_is_draft"] is True and all(source["status"] == "current" for source in context["sources"])
        assert {issue["code"] for issue in es_initial["issues"]} >= {"claim_context_needs_review", "claimed_above_supplied_maximum"}
        for key, fact in es_facts.items():
            es_facts[key] = call(browser, "POST", f"/facts/{fact['id']}/review", json={"expected_revision": fact["revision"],
                "decision": "confirmed", "note": "Explicitly compared this supplied fictional number and exact original document; app review is not authority certification or filing."})
        es_confirmed, es_field = spanish_check()
        assert es_confirmed["fingerprint"] != es_initial["fingerprint"]
        assert es_field["claim_context"]["status"] == "confirmed"
        assert es_field["claimed_area_ha"] == 6.7 and es_field["eligible_area_ha"] == 3.02
        assert es_field["eligible_area_basis"] == "user_supplied_maximum_not_certified"
        assert es_field["claim_context"]["proposed_claim"] == 3.02 and es_field["claim_context"]["proposed_claim_is_draft"] is True
        assert es_field["claim_context"]["excess"] == 3.68 and 6.69 < es_field["outline_area_ha"] < 6.71
        assert call(browser, "GET", f"/facts/{es_facts['cap.claimed_area_ha']['id']}")["data"]["value"] == 6.7

        # Contradictory maxima must not become a latest-value-wins result.
        maximum = es_facts["cap.supplied_max_eligible_area_ha"]
        conflicting = call(browser, "POST", "/facts", expected=201, json={"data": {
            "farm_id": es_farm["id"], "parcel_id": es_parcel["id"], "key": "cap.supplied_max_eligible_area_ha",
            "label": "FICTIONAL contradictory supplied maximum", "value": 3.5, "unit": "ha", "period": "2026",
            "temporal_basis": "campaign_year", "sources": maximum["data"]["sources"], "review_status": "proposed"}})
        conflict_check, es_field = spanish_check()
        assert conflict_check["fingerprint"] != es_confirmed["fingerprint"]
        assert es_field["claim_context"]["status"] == "needs_review"
        assert es_field["claim_context"]["max"] is None and es_field["claim_context"]["excess"] is None
        assert es_field["eligible_area_ha"] is None and es_field["claimed_area_ha"] == 6.7
        assert {maximum["id"], conflicting["id"]} <= set(es_field["claim_context"]["fact_ids"])
        conflicting = call(browser, "POST", f"/facts/{conflicting['id']}/review", json={"expected_revision": conflicting["revision"],
            "decision": "confirmed", "note": "Explicitly checked this competing source statement; its conflict still requires a separate choice."})
        confirmed_conflict, es_field = spanish_check()
        assert es_field["claim_context"]["max"] is None and es_field["eligible_area_ha"] is None

        def maximum_conflict():
            return next(item for item in call(browser, "GET", "/reconciliation", params={"farm_id": es_farm["id"]})["items"]
                        if item["data"]["key"] == "cap.supplied_max_eligible_area_ha")

        def choose_original(conflict):
            return call(browser, "POST", f"/reconciliation/{conflict['id']}/resolve", expected=201, json={
                "farm_id": es_farm["id"], "expected_revision": conflict["revision"], "chosen_fact_id": maximum["id"],
                "note": "Compared the two exact confirmed sources and explicitly chose the original supplied 3.02 ha, not the latest value."})

        conflict = maximum_conflict()
        assert conflict["data"]["status"] == "needs_review" and conflict["data"]["resolution"] is None
        assert {item["id"] for item in conflict["data"]["candidates"]} == {maximum["id"], conflicting["id"]}
        choose_original(conflict)
        resolved_check, es_field = spanish_check()
        assert resolved_check["fingerprint"] != confirmed_conflict["fingerprint"]
        assert es_field["claim_context"]["max"] == 3.02 and es_field["eligible_area_ha"] == 3.02
        assert es_field["claim_context"]["status"] == "confirmed" and conflicting["id"] not in es_field["claim_context"]["fact_ids"]
        # A confirmed fact cannot be edited in place. Explicitly reopen its
        # review, change the cited source location, and confirm it separately.
        conflicting = call(browser, "POST", f"/facts/{conflicting['id']}/review", json={"expected_revision": conflicting["revision"],
            "decision": "rejected", "note": "Reopen this competing source statement for an explicit corrected source location."})
        conflicting = call(browser, "PATCH", f"/facts/{conflicting['id']}", json={"expected_revision": conflicting["revision"], "data": {
            "sources": [{**source, "location": "Explicitly reread this competing supplied maximum at a changed source location."}
                        for source in conflicting["data"]["sources"]]}})
        conflicting = call(browser, "POST", f"/facts/{conflicting['id']}/review", json={"expected_revision": conflicting["revision"],
            "decision": "confirmed", "note": "Checked this changed competing source statement; the earlier resolution must not be silently reused."})
        changed_conflict = maximum_conflict()
        assert changed_conflict["revision"] != conflict["revision"] and changed_conflict["data"]["resolution"] is None
        invalid_choice_check, es_field = spanish_check()
        assert invalid_choice_check["fingerprint"] != resolved_check["fingerprint"]
        assert es_field["claim_context"]["status"] == "needs_review" and es_field["claim_context"]["max"] is None
        assert es_field["eligible_area_ha"] is None
        choose_original(changed_conflict)
        restored, es_field = spanish_check()
        assert es_field["eligible_area_ha"] == 3.02 and es_field["claim_context"]["status"] == "confirmed"
        call(browser, "POST", f"/facts/{conflicting['id']}/review", json={"expected_revision": conflicting["revision"],
            "decision": "rejected", "note": "Explicitly set aside the competing statement after the renewed source choice."})

        # The source is legal to cite while unassigned. If later assigned to a
        # different farm, its ID and metadata must disappear from this context,
        # even though the source fact remains readable on the original farm.
        foreign_source = call(browser, "POST", "/documents", expected=201,
            files={"file": ("private-moved-maximum.txt", b"FICTIONAL separately supplied maximum 3.02 ha.\n", "text/plain")})
        moved_fact = call(browser, "POST", "/facts", expected=201, json={"data": {
            "farm_id": es_farm["id"], "parcel_id": es_parcel["id"], "key": "cap.supplied_max_eligible_area_ha",
            "label": "FICTIONAL second supplied maximum with an initially unassigned original", "value": 3.02, "unit": "ha",
            "period": "2026", "temporal_basis": "campaign_year", "review_status": "proposed",
            "sources": [{"document_id": foreign_source["id"], "document_revision": foreign_source["revision"]}]}})
        call(browser, "POST", f"/facts/{moved_fact['id']}/review", json={"expected_revision": moved_fact["revision"],
            "decision": "confirmed", "note": "Checked the exact current unassigned original before choosing this additional supplied statement."})
        _, es_field = spanish_check()
        assert es_field["eligible_area_ha"] == 3.02
        call(browser, "PATCH", f"/documents/{foreign_source['id']}", json={"expected_revision": foreign_source["revision"],
            "data": {"farm_id": records["overlap-farm"]["id"]}})
        masked_check, masked_field = spanish_check()
        masked = next(source for source in masked_field["claim_context"]["sources"] if source["status"] == "unavailable")
        assert all(masked[key] is None for key in ("document_id", "document_revision", "current_revision", "sha256", "href"))
        assert masked["name"] == "Original unavailable for this farm"
        assert masked_field["claim_context"]["status"] == "needs_review" and masked_field["eligible_area_ha"] is None
        outward = json.dumps(masked_field["claim_context"])
        assert foreign_source["id"] not in outward and records["overlap-farm"]["id"] not in outward
        assert foreign_source["data"]["sha256"] not in outward and foreign_source["data"]["filename"] not in outward
        supplied = call(browser, "GET", f"/documents/{records['es-supplied-reference']['id']}")
        changed_supplied = call(browser, "PATCH", f"/documents/{supplied['id']}", json={"expected_revision": supplied["revision"],
            "data": {"notes": "Source reread; old fact pins require explicit renewed review."}})
        stale_check, es_field = spanish_check()
        assert stale_check["fingerprint"] != masked_check["fingerprint"]
        assert es_field["claim_context"]["status"] == "needs_review" and es_field["eligible_area_ha"] is None
        assert es_field["claimed_area_ha"] == 6.7 and es_field["claim_context"]["max"] == 3.02
        source = next(source for source in es_field["claim_context"]["sources"] if source["document_id"] == supplied["id"])
        assert source["status"] == "stale" and source["document_revision"] == supplied["revision"]
        assert source["current_revision"] == changed_supplied["revision"]
        assert call(browser, "GET", f"/farms/{es_farm['id']}") == es_farm, "Claim review must not shrink or otherwise mutate physical pasture geometry."

        # Independently authored intersecting rectangles: one crop is absent,
        # reported area is not the drawn area, and an inactive row is ignored.
        a, b, retired = str(uuid4()), str(uuid4()), str(uuid4())
        west = {"type": "Polygon", "coordinates": [[[5.0, 52.0], [5.002, 52.0], [5.002, 52.001], [5.0, 52.001], [5.0, 52.0]]]}
        east = {"type": "Polygon", "coordinates": [[[5.001, 52.0], [5.003, 52.0], [5.003, 52.001], [5.001, 52.001], [5.001, 52.0]]]}
        technical_farm = call(browser, "POST", "/farms", expected=201, json={"data": {
            **farm_data("FICTIONAL deterministic geometry"), "country": "NL", "region": None,
            "parcels": [{"id": a, "name": "Authored west", "crop": "", "active": True, "area_ha": 7.5, "geometry": west},
                        {"id": b, "name": "Authored east", "crop": "Recorded grass", "active": True, "geometry": east},
                        {"id": retired, "name": "Retained inactive", "crop": "", "active": False, "geometry": west}]}})
        params = {"expected_farm_revision": technical_farm["revision"], "reporting_year": 2026, "limit": 2, "offset": 0}
        first = call(browser, "GET", f"/farms/{technical_farm['id']}/parcel-check", params=params)
        issues, offset = [], 0
        while True:
            page = call(browser, "GET", f"/farms/{technical_farm['id']}/parcel-check", params={**params, "offset": offset})
            assert page["fingerprint"] == first["fingerprint"] and page["rule_hash"] == first["rule_hash"]
            assert page["issue_total"] == first["issue_total"] and len(page["issues"]) <= 2
            issues.extend(page["issues"])
            if not page["has_more"]:
                break
            offset += len(page["issues"])
        assert len(issues) == first["issue_total"] == len({item["id"] for item in issues})
        assert first["field_count"] == 2 and {field["id"] for field in first["fields"]} == {a, b}
        assert {issue["field_id"] for issue in issues if issue["code"] == "internal_overlap"} == {a, b}
        assert {issue["field_id"] for issue in issues if issue["code"] == "crop_missing"} == {a}
        field = next(field for field in first["fields"] if field["id"] == a)
        assert 1 < field["outline_area_ha"] < 2 and field["farmer_reported_area_ha"] == 7.5
        assert field["area_difference_ha"] < 0 and field["claimed_area_ha"] is None and field["eligible_area_ha"] is None
        assert all(field["natura_status"] == "unknown" for field in first["fields"])
        assert all(issue["sources"] and issue["who_decides"] for issue in issues)
        assert next(issue for issue in issues if issue["code"] == "crop_missing")["sources"][0]["article"] == "Article 8(3)(d)"
        assert call(browser, "GET", f"/farms/{technical_farm['id']}") == technical_farm
        call(browser, "GET", f"/farms/{technical_farm['id']}/parcel-check", expected=409,
             params={**params, "expected_farm_revision": technical_farm["revision"] + 1})

        case = call(browser, "GET", f"/cases/{records['nl-missing-case']['id']}")
        farm = call(browser, "GET", f"/farms/{case['data']['farm_id']}")
        proposal = call(browser, "GET", f"/field-proposals/{records['nl-missing-change']['id']}")
        applied = call(browser, "POST", f"/field-proposals/{proposal['id']}/approve", json={
            "expected_revision": proposal["revision"], "expected_farm_revision": farm["revision"],
            "note": "Explicitly checked this fictional private east-edge change, not official LPIS or a claim."})
        assert applied["farm"]["revision"] > farm["revision"] and applied["proposal"]["data"]["status"] == "approved"
        assert applied["farm"]["data"]["parcels"][0]["geometry"] == proposal["data"]["parcel"]["geometry"]
        assert farm["data"]["parcels"][0]["geometry"] != applied["farm"]["data"]["parcels"][0]["geometry"]
        notice_text = "FICTIONAL FOCUSED CORRECTION SOURCE\nOriginal statement: an invented outline was filed on 2026-05-20.\nAll dates below are authored exercise inputs, never a verified national deadline.\n"
        notice = call(browser, "POST", "/documents", expected=201, data={"farm_id": farm["id"]},
                      files={"file": ("FICTIONAL-focused-source.txt", notice_text.encode(), "text/plain")})
        private_text = "UNSELECTED FOCUSED FILE " + uuid4().hex
        private = call(browser, "POST", "/documents", expected=201, data={"farm_id": farm["id"]},
                       files={"file": ("unselected-private.txt", private_text.encode(), "text/plain")})
        notice_pin = {"kind": "documents", "id": notice["id"], "revision": notice["revision"], "role": "notice"}
        references = [{**pin, "revision": applied["proposal"]["revision"]} if pin["id"] == proposal["id"] else pin
                      for pin in case["data"]["references"]] + [notice_pin]
        context = {"regime": "unknown", "filed_on": "2026-05-20", "fictional": True}

        def change_case(record, **data):
            return call(browser, "PATCH", f"/cases/{record['id']}", json={"expected_revision": record["revision"], "data": data})

        statement = "FICTIONAL original: supplied east edge and land-use statement; not a verified submission."
        case = change_case(case, references=references, original_statement="",
                           cap_context=context, focused_review_required=True)
        assert any(issue["code"] == "case_original_statement_required"
                   for issue in call(browser, "GET", f"/cases/{case['id']}/checks")["issues"])
        case = change_case(case, original_statement=statement)
        guide = call(browser, "GET", f"/cases/{case['id']}/correction-guide")
        assert guide["original"]["statement"] == statement and guide["evaluation"]["status"] == "needs_information"
        assert guide["evaluation"]["deadlines"]["national"] is None and guide["evaluation"]["deadlines"]["effective"] is None
        assert "national_deadline" in guide["evaluation"]["missing"]
        assert all(source["url"].startswith("https://eur-lex.europa.eu/") and source["article"] and source["version"]
                   for source in guide["evaluation"]["sources"])
        # This known 15-day arithmetic is not a substitute for national law.
        context = {**context, "regime": "ams", "national_deadline": "2026-10-01", "national_deadline_source": notice_pin,
            "first_instalment_on": "2026-10-10", "finding_channel": "ams", "non_monitorable_breach": False}
        case = change_case(case, cap_context=context)
        guide = call(browser, "GET", f"/cases/{case['id']}/correction-guide")
        assert guide["evaluation"]["deadlines"]["eu_latest_possible"] == "2026-09-25"
        assert guide["evaluation"]["deadlines"]["status"] == "eu_ceiling_conflict"
        assert guide["evaluation"]["deadlines"]["effective"] is None and guide["evaluation"]["status"] == "ask_authority"
        context.update(check_announced_on="2026-10-08", check_scope="unaffected")
        case = change_case(case, cap_context=context)
        announced = call(browser, "GET", f"/cases/{case['id']}/correction-guide")["evaluation"]
        assert announced["status"] == "restricted" and "announced check" in announced["title"].lower()
        context["regime"] = "other"
        case = change_case(case, cap_context=context)
        unaffected = call(browser, "GET", f"/cases/{case['id']}/correction-guide")["evaluation"]
        assert unaffected["status"] == "ask_authority" and "unaffected-part exception" in unaffected["title"].lower()
        call(browser, "PATCH", f"/cases/{case['id']}", expected=422,
             json={"expected_revision": case["revision"], "data": {"focused_review_required": False}})

        def resolve_items(record, selected_document):
            for item in record["data"]["items"]:
                record = call(browser, "POST", f"/cases/{record['id']}/items/{item['id']}/review", json={
                    "expected_revision": record["revision"], "status": "resolved", "note": "Explicitly compared this fictional record and retained all unknown legal and source limitations.",
                    "document_ids": [selected_document["id"]], "document_revisions": {selected_document["id"]: selected_document["revision"]}, "acknowledged": True})
            return record

        case = resolve_items(case, notice)
        checked = call(browser, "GET", f"/cases/{case['id']}/checks")
        assert any(issue["code"] == "case_answers_unchecked" for issue in checked["issues"])
        call(browser, "POST", f"/cases/{case['id']}/review", expected=422, json={"expected_revision": case["revision"],
             "expected_fingerprint": checked["fingerprint"], "acknowledged": True})

        def answers(record):
            rows, offset, fingerprint = [], 0, None
            while True:
                page = call(browser, "GET", f"/cases/{record['id']}/answer-review", params={"limit": 5, "offset": offset})
                fingerprint = fingerprint or page["fingerprint"]
                assert page["fingerprint"] == fingerprint and len(page["items"]) <= 5
                rows.extend(page["items"])
                if page["next_offset"] is None:
                    assert len(rows) == page["total"] == len({row["id"] for row in rows})
                    return page, rows
                assert page["next_offset"] > offset
                offset = page["next_offset"]

        page, rows = answers(case)
        assert page["checked_count"] == 0 and not page["all_checked"]
        assert next(row for row in rows if row["id"] == "case:original_statement")["value"] == statement
        boundary = next(row for row in rows if row["id"] == "field_change_proposals:" + proposal["id"])
        assert boundary["review_kind"] == "boundary" and boundary["previous_value"] != boundary["value"]
        assert all(len(row["row_hash"]) == 64 for row in rows)
        invalid_answer = call(browser, "POST", f"/cases/{case['id']}/answer-review", expected=422, json={
            "expected_revision": case["revision"], "fingerprint": page["fingerprint"], "checked_ids": ["not-a-displayed-answer"]})
        assert invalid_answer["error"]["code"] == "case_answer_selection"
        for actor, permissions in ((reader, ["read"]), (adviser, ["read", "review"])):
            invited = call(browser, "POST", "/invitations", expected=201, json={"email": actor.email, "role": "adviser",
                "farm_ids": [farm["id"], records["overlap-farm"]["id"]], "permissions": permissions, "expires_in_days": 1})
            actor.post("/invitations/accept", json={"token": invited["token"]})
            if actor is adviser:
                review_invitation = invited
            actor.get(f"/cases/{case['id']}/answer-review", headers=scope)
            actor.get(f"/farms/{technical_farm['id']}/parcel-check", headers=scope, params=params, expected=404)
            scoped_demo = actor.get(f"/examples/workspace/{demo['run_id']}", headers=scope).json()
            assert {scenario["id"] for scenario in scoped_demo["scenarios"]} == {"nl-overlap", "nl-missing-documents"}
            assert {record["farm_id"] for record in scoped_demo["records"]} <= {farm["id"], records["overlap-farm"]["id"]}
            actor.post("/examples/workspace", expected=403, headers={**scope, **retry_key}, json=start)
        decision = {"expected_revision": case["revision"], "fingerprint": page["fingerprint"], "checked_ids": [rows[0]["id"]]}
        reader.post(f"/cases/{case['id']}/answer-review", expected=403, headers=scope, json=decision)
        partial = adviser.post(f"/cases/{case['id']}/answer-review", headers=scope, json=decision).json()
        case = partial["case"]
        assert partial["answer_review"]["checked_count"] == 1 and not partial["answer_review"]["all_checked"]
        assert not call(browser, "GET", f"/cases/{case['id']}/checks")["can_review"]
        page, current_rows = answers(case)
        assert current_rows[0]["check"]["actor_id"] == adviser.user_id
        completed = call(browser, "POST", f"/cases/{case['id']}/answer-review", json={"expected_revision": case["revision"],
            "fingerprint": page["fingerprint"], "checked_ids": [row["id"] for row in current_rows[1:]]})
        case = completed["case"]
        assert completed["answer_review"]["all_checked"] and completed["answer_review"]["checked_count"] == len(rows)
        credential = call(browser, "POST", "/assistant/credentials", expected=201, json={"name": "Focused demo permission boundary",
            "farm_ids": [farm["id"]], "permissions": ["read", "propose"], "expires_in_days": 1})
        with httpx.Client(base_url=service_url + "/", timeout=30,
                          headers={"Authorization": "Bearer " + credential["token"]}) as assistant:
            call(assistant, "GET", "/assistant/tools")
            denied = call(assistant, "POST", "/examples/workspace", expected=403, headers=retry_key, json=start)
            assert denied["error"]["code"] == "assistant_scope_denied"
            call(assistant, "POST", f"/cases/{case['id']}/answer-review", expected=403,
                 json={"expected_revision": case["revision"], "fingerprint": page["fingerprint"], "checked_ids": [rows[0]["id"]]})

        # A current document revision changes the whole review binding even
        # when its immutable original bytes and most displayed answers match.
        before_change, _ = answers(case)
        notice = call(browser, "PATCH", f"/documents/{notice['id']}", json={"expected_revision": notice["revision"], "data": {"notes": "Source reread; require explicit selection of the new metadata revision."}})
        changed_page, _ = answers(case)
        assert changed_page["fingerprint"] != before_change["fingerprint"] and changed_page["checked_count"] == 0
        call(browser, "POST", f"/cases/{case['id']}/answer-review", expected=409, json={"expected_revision": case["revision"],
            "fingerprint": before_change["fingerprint"], "checked_ids": [rows[0]["id"]]})
        references = [{**pin, "revision": notice["revision"]} if pin["id"] == notice["id"] else pin for pin in references]
        context["national_deadline_source"] = {**notice_pin, "revision": notice["revision"]}
        case = change_case(case, references=references, cap_context=context)
        case = resolve_items(case, notice)
        page, current_rows = answers(case)
        completed = call(browser, "POST", f"/cases/{case['id']}/answer-review", json={"expected_revision": case["revision"],
            "fingerprint": page["fingerprint"], "checked_ids": [row["id"] for row in current_rows]})
        case = completed["case"]
        checked = call(browser, "GET", f"/cases/{case['id']}/checks")
        assert checked["can_review"] and checked["answer_review"]["all_checked"]
        assert any(issue["code"] == "case_correction_guidance" and issue["severity"] == "warning" for issue in checked["issues"])
        case = call(browser, "POST", f"/cases/{case['id']}/review", json={"expected_revision": case["revision"],
            "expected_fingerprint": checked["fingerprint"], "acknowledged": True})
        assert case["data"]["status"] == "ready_to_send"
        handoff = call(browser, "GET", f"/cases/{case['id']}/handoff")
        packet, _ = reviewed_packet(browser, packet_href(handoff, case["id"], case["revision"], "current_review"),
            case_id=case["id"], revision=case["revision"], origin="current_review", owner_id=owner.user_id,
            excluded=(private["id"], private_text, technical_farm["id"]))
        assert packet[f"originals/{notice['id']}-v{notice['revision']}.txt"] == notice_text.encode()
        assert json.loads(packet["case-context.json"])["content"]["original_statement"] == statement
        assert json.loads(packet["case-context.json"])["content"]["answer_review"]["checks"]
        prepared_revision = case["revision"]
        sent = call(browser, "POST", f"/cases/{case['id']}/events", expected=201, json={"expected_revision": case["revision"],
            "action": "sent", "date": date.today().isoformat(), "reference": "FICTIONAL-MANUAL-ONLY",
            "note": "Human recorded this fictional handoff; no authority channel was contacted by the app.", "acknowledged": True})
        assert sent["case"]["data"]["status"] == "sent" and sent["case"]["data"]["external_status_notice"]
        seal = sent["event"]["data"]["sealed_bundle"]
        assert seal["case_revision"] == prepared_revision and seal["content"]["answer_review"]["checks"]
        assert all(check["row_hash"] for check in seal["content"]["answer_review"]["checks"].values())
        sent_case = call(browser, "GET", f"/cases/{case['id']}")
        refreshed_seed = call(browser, "POST", "/examples/workspace", expected=201, headers=retry_key, json=start)
        assert refreshed_seed["run_id"] == demo["run_id"]
        assert next(record for record in refreshed_seed["records"] if record.get("alias") == "nl-missing-case")["revision"] == sent_case["revision"]
        call(browser, "POST", f"/invitations/{review_invitation['invitation']['id']}/revoke")
        adviser.get(f"/cases/{case['id']}/answer-review", headers=scope, expected=401)

        # Starting again allocates a new actually-owned workspace; it cannot
        # erase the sent case, original bytes or return new records on retry.
        next_key = {"Idempotency-Key": "focused-reset-" + uuid4().hex}
        reset_body = {"expected_revision": demo["revision"], "acknowledged": True}
        newer = call(browser, "POST", f"/examples/workspace/{demo['run_id']}/start-again", expected=201, headers=next_key, json=reset_body)
        again = call(browser, "POST", f"/examples/workspace/{demo['run_id']}/start-again", expected=201, headers=next_key, json=reset_body)
        assert newer["run_id"] == again["run_id"] and newer["workspace"]["id"] == again["workspace"]["id"]
        assert newer["workspace"]["id"] != demo["workspace"]["id"] and newer["run_id"] != demo["run_id"]
        assert newer["previous_run_id"] == demo["run_id"] and newer["source_workspace_id"] == demo["workspace"]["id"]
        assert set(newer["farm_ids"]).isdisjoint(demo["farm_ids"])
        new_base = [record for record in newer["records"] if record["kind"] not in {"admin_case_events", "demo_runs"}]
        assert len(new_base) == 39 and {record["id"] for record in new_base}.isdisjoint(record["id"] for record in base)
        assert call(browser, "GET", f"/cases/{case['id']}") == sent_case
        retained, _ = reviewed_packet(browser, packet_href(seal["handoff"], case["id"], prepared_revision, "sealed_sent_bundle"),
            case_id=case["id"], revision=prepared_revision, origin="sealed_sent_bundle", owner_id=owner.user_id,
            excluded=(private["id"], private_text, technical_farm["id"]))
        retained_context = json.loads(retained["case-context.json"])
        assert retained_context["content"]["answer_review"] == seal["content"]["answer_review"]
        assert retained[f"originals/{notice['id']}-v{notice['revision']}.txt"] == notice_text.encode()
        for identifier, original in originals.items():
            assert browser.get(f"/documents/{identifier}/file").content == original
        assert call(browser, "GET", f"/examples/workspace/{demo['run_id']}")["run_id"] == demo["run_id"]
        assert call(browser, "GET", f"/examples/workspace/{newer['run_id']}", headers={"X-Workspace-ID": newer["workspace"]["id"]})["fixture_record_count"] == 39
        call(browser, "GET", f"/cases/{case['id']}", expected=404, headers={"X-Workspace-ID": newer["workspace"]["id"]})
