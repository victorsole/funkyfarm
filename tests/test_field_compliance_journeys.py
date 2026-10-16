"""Map corrections and source-backed paperwork checks stay human reviewed."""

from uuid import uuid4
from decimal import Decimal
import hashlib
import json

import pytest

from conftest import confirm, fact_data, farm_data


def _rectangle(west, east):
    return {"type": "Polygon", "coordinates": [[[west, 48.0], [east, 48.0], [east, 48.001], [west, 48.001], [west, 48.0]]]}


def _planar_area(geometry):
    # Independent rectangle-fixture oracle in coordinate-space, not a cadastral
    # hectare calculation and not the application's geometry implementation.
    ring = geometry["coordinates"][0]
    return abs(sum(a[0] * b[1] - a[1] * b[0] for a, b in zip(ring, ring[1:]))) / 2


def test_private_field_drafts_overlap_split_merge_and_export_keep_parent_history(farmers):
    owner = farmers("Fictional field editor")
    outsider = farmers("Unrelated map account")
    farm = owner.create("farms", farm_data("Authored map holding"))
    outline = _rectangle(11.0, 11.002)
    crossed = {"type": "Polygon", "coordinates": [[[11, 48], [11.002, 48.001], [11.002, 48], [11, 48.001], [11, 48]]]}
    owner.post(f"/farms/{farm['id']}/field-proposals", expected=422, json={"expected_revision": farm["revision"], "parcel": {"name": "Unusable crossed draft", "geometry": crossed}})
    assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
    body = {"expected_revision": farm["revision"], "parcel": {"name": "Authored whole field", "crop": "wheat", "geometry": outline}, "note": "Farmer outline only; not an official LPIS boundary."}
    stale = owner.post(f"/farms/{farm['id']}/field-proposals", json=body).json()
    assert stale["data"]["status"] == "proposed"
    assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {"notes": "Farm context was updated while the correction draft was open."}}).json()
    owner.post(f"/field-proposals/{stale['id']}/approve", expected=409, json={"expected_revision": stale["revision"], "expected_farm_revision": farm["revision"]})
    proposed = owner.post(f"/farms/{farm['id']}/field-proposals", json={**body, "expected_revision": farm["revision"]}).json()
    revised = owner.patch(f"/field-proposals/{proposed['id']}", json={"expected_revision": proposed["revision"], "expected_farm_revision": farm["revision"], "parcel": {"name": "Authored north wheat field"}}).json()
    owner.patch(f"/field-proposals/{proposed['id']}", expected=409, json={"expected_revision": proposed["revision"], "expected_farm_revision": farm["revision"], "note": "A stale tab must not overwrite the new name."})
    retry = {"Idempotency-Key": "field-approval-" + uuid4().hex}
    approval = {"expected_revision": revised["revision"], "expected_farm_revision": farm["revision"], "note": "Compared this supplied outline before applying it to private farm records."}
    applied = owner.post(f"/field-proposals/{proposed['id']}/approve", headers=retry, json=approval).json()
    assert owner.post(f"/field-proposals/{proposed['id']}/approve", headers=retry, json=approval).json() == applied
    farm = applied["farm"]
    parent = applied["proposal"]["data"]["parcel"]
    assert parent["name"] == "Authored north wheat field"

    overlap = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"], "parcel": {"name": "Authored neighbouring field", "crop": "wheat", "geometry": _rectangle(11.001, 11.003)}}).json()
    assert parent["id"] in {item["id"] for item in overlap["data"]["overlapping_fields"]}
    rejected = owner.post(f"/field-proposals/{overlap['id']}/approve", expected=422, json={"expected_revision": overlap["revision"], "expected_farm_revision": farm["revision"]}).json()
    assert rejected["error"]["code"] == "overlap_review_required"
    corrected_overlap = owner.patch(f"/field-proposals/{overlap['id']}", json={"expected_revision": overlap["revision"], "expected_farm_revision": farm["revision"], "parcel": {"name": "Authored neighbouring field", "geometry": _rectangle(11.002, 11.003)}, "note": "Corrected the accidental overlap; adjacent boundaries may touch."}).json()
    farm = owner.post(f"/field-proposals/{overlap['id']}/approve", json={"expected_revision": corrected_overlap["revision"], "expected_farm_revision": farm["revision"]}).json()["farm"]
    observation = owner.create("operations", {"farm_id": farm["id"], "title": "Notebook visit before split", "type": "observation", "date": "2026-06-10", "period": "2026-06-10", "temporal_basis": "calendar_date", "parcel_id": parent["id"], "quantity": None, "unit": None})
    observation = owner.post(f"/operations/{observation['id']}/review", json={"expected_revision": observation["revision"], "decision": "confirmed", "note": "Actual visit to the original field, before it was divided."}).json()
    split_body = {"expected_revision": farm["revision"], "operation": "split", "parcel_ids": [parent["id"]], "split_line": {"type": "LineString", "coordinates": [[11.001, 47.999], [11.001, 48.002]]}, "names": ["Authored west half", "Authored east half"], "note": "Private division draft; no official boundary or eligible-area claim."}
    split_key = {"Idempotency-Key": "field-split-" + uuid4().hex}
    split = owner.post(f"/farms/{farm['id']}/field-proposals/transform", headers=split_key, json=split_body).json()
    assert owner.post(f"/farms/{farm['id']}/field-proposals/transform", headers=split_key, json=split_body).json()["id"] == split["id"]
    children = split["data"]["parcels"]
    assert len(children) == 2 and len({item["id"] for item in children}) == 2
    assert sum(_planar_area(item["geometry"]) for item in children) == pytest.approx(_planar_area(outline), rel=1e-6)
    assert split["data"]["lineage"]["parents"] == [{"id": parent["id"], "revision": parent["revision"]}]
    assert {item["id"] for item in owner.get(f"/farms/{farm['id']}/fields").json()["items"]} == {item["id"] for item in farm["data"]["parcels"]}
    for format in ("geojson", "correction"):
        exported = owner.get(f"/field-proposals/{split['id']}/export", params={"format": format})
        assert "attachment" in exported.headers["content-disposition"] and "no-store" in exported.headers["cache-control"]
        outsider.get(f"/field-proposals/{split['id']}/export", params={"format": format}, expected=404)
        if format == "geojson":
            assert exported.json()["type"] == "FeatureCollection"
            assert {item["id"] for item in exported.json()["features"]} == {item["id"] for item in children}
            assert all(item["properties"]["status"] == "proposed" for item in exported.json()["features"])
        else:
            assert exported.json()["previous_parcels"][0]["id"] == parent["id"]
            assert "not been submitted" in exported.json()["handoff"]
    farm = owner.post(f"/field-proposals/{split['id']}/approve", json={"expected_revision": split["revision"], "expected_farm_revision": farm["revision"]}).json()["farm"]
    active = owner.get(f"/farms/{farm['id']}/fields").json()["items"]
    assert parent["id"] not in {item["id"] for item in active}
    history = owner.get(f"/farms/{farm['id']}/fields", params={"include_retired": "true"}).json()["items"]
    old_parent = next(item for item in history if item["id"] == parent["id"])
    assert old_parent["active"] is False and set(old_parent["successor_ids"]) == {item["id"] for item in children}
    assert owner.get(f"/operations/{observation['id']}").json()["data"]["parcel_id"] == parent["id"]
    owner.post(f"/farms/{farm['id']}/field-proposals/transform", expected=409, json={**split_body, "expected_revision": farm["revision"] - 1})
    merged = owner.post(f"/farms/{farm['id']}/field-proposals/transform", json={"expected_revision": farm["revision"], "operation": "merge", "parcel_ids": [item["id"] for item in children], "names": ["Authored joined wheat field"], "crop": "wheat", "note": "Rejoin only these adjacent halves; retain all previous field IDs."}).json()
    assert len(merged["data"]["parcels"]) == 1
    assert _planar_area(merged["data"]["parcel"]["geometry"]) == pytest.approx(_planar_area(outline), rel=1e-6)
    farm = owner.post(f"/field-proposals/{merged['id']}/approve", json={"expected_revision": merged["revision"], "expected_farm_revision": farm["revision"]}).json()["farm"]
    assert len(owner.get(f"/farms/{farm['id']}/fields").json()["items"]) == 2
    retained = owner.get(f"/farms/{farm['id']}/fields", params={"include_retired": "true"}).json()["items"]
    assert {item["id"] for item in retained if item.get("active") is False} == {parent["id"], *(item["id"] for item in children)}
    assert owner.get("/reports").json()["total"] == 0


def test_source_backed_ppp_checks_ask_for_actual_use_and_leave_national_timing_unknown(farmers):
    owner = farmers("Fictional Slovak professional user")
    outsider = farmers("Separate obligation account")
    field_id = str(uuid4())
    farm = owner.create("farms", {**farm_data("Authored Slovak holding"), "country": "SK", "region": None,
        "parcels": [{"id": field_id, "name": "Authored one-hectare outdoor field", "area_ha": 1.0, "crop": "wheat"}]})
    initial = owner.get(f"/compliance/farms/{farm['id']}", params={"year": 2026}).json()
    assert "uses_professional_plant_protection" in {item["key"] for item in initial["profile_questions"]}
    assert owner.get("/tasks").json()["total"] == 0 and owner.get("/checklists").json()["total"] == 0
    profile_path = f"/compliance/farms/{farm['id']}/profile"
    profile_body = {"year": 2026, "expected_farm_revision": farm["revision"], "answers": [{"key": "uses_professional_plant_protection", "value": True}]}
    owner.post(profile_path, expected=422, json={**profile_body, "answers": [{"key": "uses_professional_plant_protection", "value": 1}]})
    owner.post(profile_path, expected=422, json={**profile_body, "answers": [{"key": "invented_legal_exemption", "value": True}]})
    owner.post(profile_path, expected=422, json={**profile_body, "year": 2025})
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {"notes": "Updated profile context before answering activity questions."}}).json()
    owner.post(profile_path, expected=409, json=profile_body)
    profile_body["expected_farm_revision"] = farm["revision"]
    profile_retry = {"Idempotency-Key": "activity-answer-" + uuid4().hex}
    profile = owner.post(profile_path, headers=profile_retry, json=profile_body).json()
    assert owner.post(profile_path, headers=profile_retry, json=profile_body).json() == profile
    professional = profile["facts"][0]
    assert professional["data"]["value"] is True and professional["data"]["review_status"] == "proposed"
    assert professional["data"]["period"] == "2026" and professional["data"]["temporal_basis"] == "campaign_year"
    assert owner.post(profile_path, json=profile_body).json()["facts"][0]["id"] == professional["id"]
    assert owner.get(f"/farms/{farm['id']}").json()["revision"] == farm["revision"], "A proposed profile answer must not auto-approve or rewrite the farm."
    unconfirmed = owner.get(f"/compliance/farms/{farm['id']}").json()
    assert next(rule for rule in unconfirmed["obligations"] if rule["id"] == "eu-ppp-records")["applicability"] == "unknown"
    confirm(owner, professional)
    assert owner.post(profile_path, json=profile_body).json()["facts"] == []
    assert len([fact for fact in owner.get("/facts").json()["items"] if fact["data"]["key"] == "uses_professional_plant_protection"]) == 1
    use_types = owner.post(profile_path, json={**profile_body, "answers": [{"key": "ppp_use_type", "value": ["surface", "closed_space", "seed_treatment"]}]}).json()["facts"][0]
    confirm(owner, use_types)
    purchase = owner.create("purchases", {"farm_id": farm["id"], "title": "Authored product acquisition, not application", "category": "crop_treatment", "date": "2026-06-09", "quantity": 2.5, "unit": "l", "amount": 12.5, "currency": "EUR"})
    owner.post(f"/purchases/{purchase['id']}/review", json={"expected_revision": purchase["revision"], "decision": "confirmed", "note": "Read acquisition only; actual use date, field and dose are not established by this receipt."})
    no_work = owner.get(f"/compliance/farms/{farm['id']}").json()
    surface = next(rule for rule in no_work["obligations"] if rule["id"] == "eu-ppp-surface-use")
    assert surface["applicability"] == "applies"
    assert {issue["code"] for issue in surface["issues"]} >= {"missing_evidence", "purchase_is_not_use"}
    assert surface["deadline"]["status"] == "unknown" and surface["deadline"]["date"] is None
    assert surface["citations"], "Personalized checks must retain their official-source basis."
    work_data = {"farm_id": farm["id"], "title": "Authored actual surface application", "type": "pesticide_application", "treatment_type": "surface",
        "date": "2026-06-11", "period": "2026-06-11", "temporal_basis": "calendar_date", "parcel_id": field_id,
        "product": "Fictional product, no authorisation-validity claim", "crop": "wheat", "quantity": 0.5, "unit": "l",
        "sources": [{"kind": "manual", "note": "Authored field notebook: actually used 0.50 L on 1.00 ha on 11 June; not the 2.50 L purchased."}]}
    work = owner.create("operations", work_data)
    owner.post(f"/operations/{work['id']}/review", json={"expected_revision": work["revision"], "decision": "confirmed", "note": "Explicitly checked actual application date, original field and total amount used."})
    missing = next(rule for rule in owner.get(f"/compliance/farms/{farm['id']}").json()["obligations"] if rule["id"] == "eu-ppp-surface-use")
    assert "missing_field" in {issue["code"] for issue in missing["issues"]}, "Total litres used is not a per-hectare dose or treated area."
    wrong_day = confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="product_authorisation", value="WRONG-DAY-ONLY", unit=None, basis="calendar_date", period="2026-06-12"), "parcel_id": field_id}))
    still_missing = next(rule for rule in owner.get(f"/compliance/farms/{farm['id']}").json()["obligations"] if rule["id"] == "eu-ppp-surface-use")
    assert wrong_day["id"] not in {evidence["id"] for requirement in still_missing["requirements"] for evidence in requirement["evidence"]}
    for key, value, unit in (("product_authorisation", "1234567", None), ("dose", "0.50", "L/ha"), ("treated_area", "1.00", "ha")):
        confirm(owner, owner.create("facts", {**fact_data(farm["id"], key=key, value=value, unit=unit, basis="calendar_date", period="2026-06-11", sources=[{"note": "Manually read the authored notebook for this specific field and actual day; not a legal product authorisation check."}]), "parcel_id": field_id}))
    checked = owner.get(f"/compliance/farms/{farm['id']}", params={"year": 2026}).json()
    surface = next(rule for rule in checked["obligations"] if rule["id"] == "eu-ppp-surface-use")
    assert "missing_field" not in {issue["code"] for issue in surface["issues"]}
    assert "conditional_field_review" in {issue["code"] for issue in surface["issues"]}, "Missing time, growth-stage or treated-fraction applicability must not be silently waived."
    assert surface["status"] == "needs_adviser"
    assert surface["deadline"]["status"] == "unknown" and surface["deadline"]["date"] is None

    # A later split/retirement must not hide an earlier dated event's missing
    # information or borrow observations from a different visit to the field.
    incomplete_work = owner.create("operations", {**work_data, "title": "Earlier field visit still missing required details", "date": "2026-06-14", "period": "2026-06-14",
        "sources": [{"note": "Authored notebook records a separate 14 June application of 0.50 L; authorisation, dose and treated area are still unknown."}]})
    owner.post(f"/operations/{incomplete_work['id']}/review", json={"expected_revision": incomplete_work["revision"], "decision": "confirmed", "note": "Confirmed the actual visit only; missing dose, treated area and authorisation remain unanswered."})
    child_id = str(uuid4())
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {"parcels": [
        {**farm["data"]["parcels"][0], "active": False, "successor_ids": [child_id]},
        {"id": child_id, "name": "Current replacement field", "crop": "wheat", "area_ha": 1.0, "active": True},
    ]}}).json()
    historical = next(rule for rule in owner.get(f"/compliance/farms/{farm['id']}").json()["obligations"] if rule["id"] == "eu-ppp-surface-use")
    assert incomplete_work["id"] in {evidence["id"] for requirement in historical["requirements"] for evidence in requirement["evidence"]}
    assert any(issue["code"] == "missing_field" and incomplete_work["id"] in issue["record_ids"] for issue in historical["issues"])

    # Explicit dose/treated-size fields serve distinct Annex use types. They
    # never invent total litres, or default a facility/seed amount to hectares.
    for index, (use_type, dose, dose_unit, size, size_unit, location) in enumerate((
        ("surface", "0.50", "L/ha", "1.00", "ha", "Authored current field reference"),
        ("closed_space", "0.01", "L/m3", "300.00", "m3", "Authored empty grain store A"),
        ("seed", "0.20", "L/t", "2.00", "t", "Authored seed treatment batch A"),
    )):
        actual_day = f"2026-06-{15 + index:02d}"
        direct = {"farm_id": farm["id"], "title": "Authored direct " + use_type + " treatment", "type": "pesticide_application",
            "date": actual_day, "temporal_basis": "calendar_date", "period": actual_day, "treatment_type": use_type,
            "product": "Fictional treatment product", "product_authorisation": "1234567", "crop": "wheat",
            "quantity": None, "unit": None, "dose": dose, "dose_unit": dose_unit, "treated_size": size,
            "treated_unit": size_unit, "treated_location": location, "label_time_required": False,
            "label_growth_stage_required": False, "sources": [{"note": "Explicit authored actual treatment record, preserving the printed rate and treated unit; no total quantity was supplied."}],
            **({"parcel_id": child_id} if use_type == "surface" else {"batch_number": "AUTHORED-SEED-BATCH"} if use_type == "seed" else {})}
        if use_type != "surface":
            wrong_unit = owner.post("/workflow/check", json={"kind": "operations", "data": {**direct, "treated_unit": "ha"}}).json()
            assert "ppp_extent_unit_review" in wrong_unit["requires_acknowledgement"]
            assert wrong_unit["normalized_data"]["treated_unit"] == "ha", "A unit warning must not silently convert the source value."
        direct_check = owner.post("/workflow/check", json={"kind": "operations", "data": direct}).json()
        assert direct_check["can_save"] is True, "A supplied dose must not require an invented total amount."
        captured = owner.post("/workflow/capture", expected=201, json={"kind": "operations", "data": direct,
            "check_token": direct_check["check_token"], "acknowledged_codes": direct_check["requires_acknowledgement"]}).json()["record"]
        assert captured["data"]["review_status"] == "proposed" and captured["data"]["quantity"] is None
        assert captured["data"]["treated_unit"] == size_unit and captured["data"]["dose_unit"] == dose_unit
        assert Decimal(str(captured["data"]["dose"])) == Decimal(dose) and Decimal(str(captured["data"]["treated_size"])) == Decimal(size)
        reviewed = owner.post(f"/operations/{captured['id']}/review", json={"expected_revision": captured["revision"], "decision": "confirmed", "note": "Read the actual dose and corresponding treated field/facility/seed amount; no total quantity or national acceptance was inferred."}).json()
        assert reviewed["data"]["quantity"] is None and reviewed["data"]["treated_unit"] == size_unit
    request = owner.create("requests", {"farm_id": farm["id"], "title": "Fictional request with a recorded deadline", "recipient": "Fictional office", "country": "SK", "reporting_year": 2026, "deadline": "2026-11-17", "pack_id": "farm-evidence", "requirements": [], "status": "draft"})
    deadlines = owner.get(f"/compliance/farms/{farm['id']}").json()["deadlines"]
    assert any(item.get("request_id") == request["id"] and item["date"] == "2026-11-17" and item["status"] == "recorded" for item in deadlines)
    checklist_body = {"rule_ids": ["eu-ppp-surface-use"], "expected_farm_revision": farm["revision"], "year": 2026}
    retry = {"Idempotency-Key": "obligation-drafts-" + uuid4().hex}
    drafts = owner.post(f"/compliance/farms/{farm['id']}/checklist", headers=retry, json=checklist_body).json()
    assert owner.post(f"/compliance/farms/{farm['id']}/checklist", headers=retry, json=checklist_body).json() == drafts
    assert drafts["checklists"] and drafts["tasks"]
    assert all(item["done"] is False and item["deadline"] is None for checklist in drafts["checklists"] for item in checklist["data"]["items"])
    assert all(task["data"]["status"] == "open" and task["data"]["due_date"] is None for task in drafts["tasks"])
    repeated = owner.post(f"/compliance/farms/{farm['id']}/checklist", json=checklist_body).json()
    assert not repeated["checklists"] and not repeated["tasks"] and repeated["skipped"]
    before = owner.get(f"/requests/{request['id']}/checks", params={"selected_fact_ids": ""}).json()
    assert before["status"] != "ready_for_review" and before["issues"]
    assert all(issue["fix_url"].startswith("/app/") for issue in before["issues"])
    area = owner.create("facts", fact_data(farm["id"], value="1.00", basis="static", period=None))
    proposed_check = owner.get(f"/requests/{request['id']}/checks", params={"selected_fact_ids": area["id"]}).json()
    assert "unreviewed_fact" in {issue["code"] for issue in proposed_check["issues"]}
    area = confirm(owner, area)
    after = owner.get(f"/requests/{request['id']}/checks", params={"selected_fact_ids": area["id"]}).json()
    assert "unreviewed_fact" not in {issue["code"] for issue in after["issues"]}
    assert owner.get(f"/requests/{request['id']}").json()["data"]["status"] == "draft", "Preflight must not approve, file or mutate the request."
    outsider.get(f"/compliance/farms/{farm['id']}", expected=404)
    outsider.get(f"/requests/{request['id']}/checks", expected=404)
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {"notes": "A changed farm invalidates an old checklist creation context."}}).json()
    owner.post(f"/compliance/farms/{farm['id']}/checklist", expected=409, json=checklist_body)


def test_historical_iacs_subset_preserves_codes_rights_and_source_area_without_adopting_land(farmers):
    owner = farmers("Fictional historical-reference reviewer")
    outsider = farmers("Unrelated reference account")
    farm = owner.create("farms", {**farm_data("Private Dutch reference comparison"), "country": "NL", "region": None, "area_ha": 9.0})
    original_farm = owner.get(f"/farms/{farm['id']}").json()
    catalog = owner.get("/reference-data/iacs/catalog").json()
    assert catalog["version"] == "1.3" and catalog["native_crs"] == "EPSG:3035"
    assert catalog["accepted_subset_crs"] == "EPSG:4326" and catalog["automatic_download"] is False
    properties = {"field_id": "source-007", "crop_code": "0012", "crop_name": "Original rye", "EC_trans_n": "Rye", "EC_hcat_n": "rye", "EC_hcat_c": "0012345678", "field_size": "3.750", "crop_area": "2.500", "farm_id": "public-applicant-not-owner", "organic": "2"}
    outline = {"type": "Polygon", "coordinates": [[[5.0, 52.0], [5.002, 52.0], [5.002, 52.001], [5.0, 52.001], [5.0, 52.0]]]}
    feature = {"type": "Feature", "properties": properties, "geometry": outline}
    content = json.dumps({"type": "FeatureCollection", "features": [feature]}, separators=(",", ":"))
    body = {"farm_id": farm["id"], "country": "NL", "region": None, "year": 2025, "format": "geojson", "content": content,
        "source_crs": "EPSG:4326", "source_area_unit": "ha", "rights_basis": "I checked the original source reuse terms for this authored fixture.",
        "source_context_confirmed": True, "upstream_file_name": "NL_2025.parquet", "use_purpose": "private_reference"}
    retry = {"Idempotency-Key": "historical-reference-" + uuid4().hex}
    preview = owner.post("/reference-data/iacs/preview", expected=201, headers=retry, json=body).json()
    assert owner.post("/reference-data/iacs/preview", expected=201, headers=retry, json=body).json() == preview
    candidate = preview["data"]["candidates"][0]
    assert candidate["external_id"] == "source-007" and candidate["crop_code"] == "0012" and candidate["hcat_code"] == "0012345678"
    assert candidate["original_properties"] == properties
    assert candidate["source_area_ha"] == 3.75 and candidate["source_crop_area_ha"] == 2.5
    assert candidate["organic_raw"] == "2" and candidate["organic_verified"] is False
    assert candidate["upstream_applicant_id"] == "public-applicant-not-owner" and candidate["review_status"] == "historical_reference_unreviewed"
    provenance = preview["data"]["provenance"]
    assert provenance["subset_sha256"] == hashlib.sha256(content.encode()).hexdigest()
    assert provenance["source_crs_original"] == "EPSG:3035" and provenance["subset_crs_confirmed_by_user"] == "EPSG:4326"
    assert provenance["upstream_file_checksum_verified"] is False and preview["data"]["shared_redistribution"] is False
    assert owner.get(f"/farms/{farm['id']}").json() == original_farm
    assert owner.get("/facts").json()["total"] == 0 and owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
    outsider.get(f"/reference-data/iacs/{preview['id']}", expected=404)
    outsider.post("/reference-data/iacs/preview", expected=404, json=body)
    invalid_contents = [
        {"type": "FeatureCollection", "features": [{**feature, "properties": {**properties, "EC_hcat_c": 12345678}}]},
        {"type": "FeatureCollection", "features": [feature, feature]},
        {"type": "FeatureCollection", "features": [{**feature, "properties": {key: value for key, value in properties.items() if key != "crop_code"}}]},
        {"type": "FeatureCollection", "features": [{**feature, "geometry": {"type": "Polygon", "coordinates": [[[4000000, 3000000], [4000010, 3000000], [4000010, 3000010], [4000000, 3000000]]]}}]},
    ]
    for invalid in invalid_contents:
        owner.post("/reference-data/iacs/preview", expected=422, json={**body, "content": json.dumps(invalid)})
    for change in ({"year": 2026}, {"country": "DE"}, {"source_crs": "EPSG:3035"}, {"source_context_confirmed": False}):
        owner.post("/reference-data/iacs/preview", expected=422, json={**body, **change})
    lithuanian = owner.create("farms", {**farm_data("Rights-restricted reference example"), "country": "LT", "region": None})
    owner.post("/reference-data/iacs/preview", expected=422, json={**body, "farm_id": lithuanian["id"], "country": "LT", "upstream_file_name": "LT_2025.parquet"})
    csv_content = "field_id,crop_code,crop_name,EC_trans_n,EC_hcat_n,EC_hcat_c,field_size\nsource-008,0012,Original rye,Rye,rye,0012345678,3.750\n"
    metadata = owner.post("/reference-data/iacs/preview", expected=201, json={**body, "format": "csv", "content": csv_content}).json()["data"]["candidates"][0]
    assert metadata["geometry"] is None and metadata["field_reference"]["geometry"] is None
    proposed = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"], "parcel": {"name": "Farmer-supplied present outline", "geometry": outline, "crop": "Farmer to review current crop"}, "reference": candidate["field_reference"], "note": "Compare a historical reference; no ownership or current eligible-area assertion."}).json()
    assert proposed["data"]["status"] == "proposed" and proposed["data"]["reference"]["external_id"] == "source-007"
    assert owner.get(f"/farms/{farm['id']}").json() == original_farm
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {"notes": "Current farm context changed after the historical preview."}}).json()
    assert owner.get(f"/reference-data/iacs/{preview['id']}").json()["farm_context_changed"] is True
