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
    import httpx
    from xml.etree import ElementTree

    def check_kml(response, proposal):
        assert response.headers["content-type"].split(";")[0] == "application/vnd.google-earth.kml+xml"
        assert 'filename="field-correction-draft.kml"' in response.headers["content-disposition"]
        assert "no-store" in response.headers["cache-control"]
        root = ElementTree.fromstring(response.content.decode("utf-8"))
        ns = {"k": "http://www.opengis.net/kml/2.2"}
        assert root.tag == "{http://www.opengis.net/kml/2.2}kml"
        assert not any(root.findall(".//k:" + tag, ns) for tag in ("NetworkLink", "Icon", "href", "Style", "script", "Point"))
        descriptions = root.findall(".//k:description", ns)
        assert descriptions and len({item.text for item in descriptions}) == 1
        assert "Private farmer-supplied boundary snapshot" in descriptions[0].text
        assert "No submission has been made." in descriptions[0].text
        parcels = proposal["data"].get("parcels") or [proposal["data"]["parcel"]]
        placemarks = root.findall(".//k:Placemark", ns)
        assert len(placemarks) == len(parcels)
        by_id = {parcel["id"]: parcel for parcel in parcels}
        seen = set()

        def coordinates(ring):
            result = []
            for token in ring.find("k:LinearRing/k:coordinates", ns).text.split():
                point = tuple(Decimal(value) for value in token.split(","))
                assert len(point) in (2, 3) and (len(point) == 2 or point[2] == 0)
                result.append(point[:2])  # KML order is longitude, latitude.
            assert len(result) >= 4 and result[0] == result[-1]
            return result

        def vertex_key(points):
            return frozenset(tuple(Decimal(str(value)) for value in p[:2]) for p in points[:-1])

        def check_ring(boundary, expected, positive):
            actual = coordinates(boundary)
            expected = [tuple(Decimal(str(value)) for value in p[:2]) for p in expected]
            assert len(actual) == len(expected) and vertex_key(actual) == vertex_key(expected)
            assert {frozenset((a, b)) for a, b in zip(actual, actual[1:])} == {frozenset((a, b)) for a, b in zip(expected, expected[1:])}
            signed = sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(actual, actual[1:]))
            assert signed > 0 if positive else signed < 0

        for placemark in placemarks:
            values = {item.attrib["name"]: item.findtext("k:value", default="", namespaces=ns)
                      for item in placemark.findall("k:ExtendedData/k:Data", ns)}
            parcel = by_id[values["parcel_id"]]
            assert values["parcel_id"] not in seen
            seen.add(values["parcel_id"])
            assert placemark.findtext("k:name", namespaces=ns) == parcel["name"] == values["name"]
            assert values["proposal_id"] == proposal["id"] and values["proposal_revision"] == str(proposal["revision"])
            assert values["status"] == proposal["data"]["status"] and values["crop"] == (parcel.get("crop") or "")
            assert values["external_id"] == (parcel.get("external_id") or "")
            reference = proposal["data"].get("reference") or {}
            for key in ("source", "external_id", "crop", "year"):
                expected_reference = str(reference[key]) if reference.get(key) is not None else ""
                assert values["reference_" + key] == expected_reference
            geometry = parcel["geometry"]
            parts = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            assert (placemark.find("k:MultiGeometry", ns) is not None) == (geometry["type"] == "MultiPolygon")
            polygons = placemark.findall(".//k:Polygon", ns)
            assert len(polygons) == len(parts)
            parts_by_ring = {vertex_key(part[0]): part for part in parts}
            for polygon in polygons:
                outer = polygon.find("k:outerBoundaryIs", ns)
                part = parts_by_ring.pop(vertex_key(coordinates(outer)))
                check_ring(outer, part[0], True)
                holes = polygon.findall("k:innerBoundaryIs", ns)
                assert len(holes) == len(part) - 1
                holes_by_ring = {vertex_key(points): points for points in part[1:]}
                for hole in holes:
                    check_ring(hole, holes_by_ring.pop(vertex_key(coordinates(hole))), False)
                assert not holes_by_ring
            assert not parts_by_ring
        assert seen == set(by_id)

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
    for format in ("geojson", "correction", "kml"):
        exported = owner.get(f"/field-proposals/{split['id']}/export", params={"format": format})
        assert "attachment" in exported.headers["content-disposition"] and "no-store" in exported.headers["cache-control"]
        outsider.get(f"/field-proposals/{split['id']}/export", params={"format": format}, expected=404)
        if format == "geojson":
            assert exported.json()["type"] == "FeatureCollection"
            assert {item["id"] for item in exported.json()["features"]} == {item["id"] for item in children}
            assert all(item["properties"]["status"] == "proposed" for item in exported.json()["features"])
        elif format == "correction":
            assert exported.json()["previous_parcels"][0]["id"] == parent["id"]
            assert "not been submitted" in exported.json()["handoff"]
        else:
            check_kml(exported, split)
            with httpx.Client(base_url=owner.client.base_url, timeout=10, trust_env=False) as anonymous:
                assert anonymous.get(f"/field-proposals/{split['id']}/export", params={"format": "kml"}).status_code == 401
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    approved_split = owner.post(f"/field-proposals/{split['id']}/approve", json={"expected_revision": split["revision"], "expected_farm_revision": farm["revision"]}).json()
    farm = approved_split["farm"]
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
    check_kml(owner.get(f"/field-proposals/{split['id']}/export", params={"format": "kml"}), approved_split["proposal"])
    # Reversing KML winding is an export-only representation change. Preserve
    # multipart outlines, excluded inner rings, Unicode and literal XML text.
    multipart = {"type": "MultiPolygon", "coordinates": [
        [[[12, 49], [12, 49.004], [12.004, 49.004], [12.004, 49], [12, 49]],
         [[12.001, 49.001], [12.003, 49.001], [12.003, 49.003], [12.001, 49.003], [12.001, 49.001]]],
        [[[12.006, 49], [12.006, 49.002], [12.008, 49.002], [12.008, 49], [12.006, 49]]],
    ]}
    special = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"],
        "parcel": {"name": 'Žluťoučký & <NetworkLink> "Průhon"', "crop": "Žito & oves <2026>", "external_id": 'LOCAL<&"007', "geometry": multipart},
        "reference": {"external_id": 'REFERENCE<&"007', "crop": "Oves & žito", "year": 2025,
            "source": "Authored map & notebook <not a service>\nChecked by farmer"},
        "note": "Private multipart draft; the excluded inner area must remain excluded, with no register submission."}).json()
    original_geojson = owner.get(f"/field-proposals/{special['id']}/export", params={"format": "geojson"}).json()
    original_history = owner.get(f"/farms/{farm['id']}/fields", params={"include_retired": "true"}).json()
    check_kml(owner.get(f"/field-proposals/{special['id']}/export", params={"format": "kml"}), special)
    assert owner.get(f"/field-proposals/{special['id']}/export", params={"format": "geojson"}).json() == original_geojson
    assert owner.get(f"/farms/{farm['id']}/fields", params={"include_retired": "true"}).json() == original_history
    assert original_geojson["features"][0]["geometry"] == multipart
    point_only = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"],
        "parcel": {"name": "Only a known location, not a boundary", "point": {"latitude": 49, "longitude": 12}}}).json()
    assert owner.get(f"/field-proposals/{point_only['id']}/export", params={"format": "kml"}, expected=422).json()["error"]["code"] == "boundary_required"
    for parcel, reference in (({"name": "Invalid XML control\u0001", "geometry": multipart}, None),
                              ({"name": "Valid outline with unreadable source text", "geometry": multipart}, {"source": "Never silently strip source control\u0001"})):
        invalid_text = owner.post(f"/farms/{farm['id']}/field-proposals", json={"expected_revision": farm["revision"], "parcel": parcel, "reference": reference}).json()
        assert owner.get(f"/field-proposals/{invalid_text['id']}/export", params={"format": "kml"}, expected=422).json()["error"]["code"] == "invalid_export_text"
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
    same_day_peer = owner.create("operations", {**work_data, "title": "A second distinct 14 June treatment", "date": "2026-06-14", "period": "2026-06-14",
        "quantity": 0.75, "product_authorisation": "1234567", "dose": 0.75, "dose_unit": "L/ha", "treated_size": 1, "treated_unit": "ha"})
    same_day_peer = owner.post(f"/operations/{same_day_peer['id']}/review", json={"expected_revision": same_day_peer["revision"], "decision": "confirmed",
        "note": "A separate actual treatment on the same field and day; its dose is not evidence for the first visit."}).json()
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

    # Generated action keys describe issues, not fictitious fact keys. Review
    # the real dated records, and bind completion to this action's live evidence.
    checklist = drafts["checklists"][0]
    review_path = f"/checklists/{checklist['id']}/review"
    review = owner.get(review_path).json()
    outsider.get(review_path, expected=404)
    unresolved = next(item for item in review["items"] if item["mode"] == "evidence" and not item["can_complete"]
        and any(issue["code"] == "missing_field" and "dose" in issue["message"].lower() for issue in item["issues"]))
    unresolved_body = {"expected_revision": checklist["revision"], "expected_input_fingerprint": review["expected_input_fingerprint"],
        "note": "Reading a different visit cannot resolve the missing details on 14 June."}
    denied = owner.post(f"/checklists/{checklist['id']}/items/{unresolved['key']}/complete", expected=422, json=unresolved_body).json()
    assert denied["error"]["code"] == "checklist_issue_unresolved"
    linked_task = next(task for task in drafts["tasks"] if task["data"]["checklist_item_key"] == unresolved["key"])
    assert owner.post(f"/tasks/{linked_task['id']}/complete", expected=422, json={"expected_revision": linked_task["revision"], "note": "This action is not yet reviewed."}).json()["error"]["code"] == "checklist_item_incomplete"

    # Resolve the particular 14 June visit using independently reviewed details
    # for that same day and field, not the already complete 11 June event.
    incomplete_work = owner.get(f"/operations/{incomplete_work['id']}").json()
    event_source = {"record_id": incomplete_work["id"], "record_kind": "operations", "revision": incomplete_work["revision"]}
    for key, value, unit in (("product_authorisation", "1234567", None), ("treated_area", "1.00", "ha")):
        confirm(owner, owner.create("facts", {**fact_data(farm["id"], key=key, value=value, unit=unit, basis="calendar_date", period="2026-06-14"),
            "parcel_id": field_id, "sources": [{**event_source, "note": "Authored 14 June details explicitly tied to the first actual treatment, not just its shared day and field."}]}))
    wrong_event_dose = confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="dose", value="0.75", unit="L/ha", basis="calendar_date", period="2026-06-14"),
        "parcel_id": field_id, "sources": [{"record_id": same_day_peer["id"], "record_kind": "operations", "revision": same_day_peer["revision"], "note": "Dose belongs to the second treatment only."}]}))
    ambiguous_dose = confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="dose", value="0.90", unit="L/ha", basis="calendar_date", period="2026-06-14"),
        "parcel_id": field_id, "sources": [{"note": "The notebook has two visits on this day; this loose dose has no identified event and cannot be assigned automatically."}]}))
    blocked = owner.get(review_path).json()
    blocked_item = next(item for item in blocked["items"] if item["key"] == unresolved["key"])
    assert blocked_item["can_complete"] is False
    assert {wrong_event_dose["id"], ambiguous_dose["id"]}.isdisjoint({r["id"] for r in blocked_item["evidence"]})
    assert owner.post(f"/checklists/{checklist['id']}/items/{unresolved['key']}/complete", expected=422, json={**unresolved_body,
        "expected_input_fingerprint": blocked["expected_input_fingerprint"], "evidence_fact_ids": [wrong_event_dose["id"], ambiguous_dose["id"]],
        "evidence_revisions": {wrong_event_dose["id"]: wrong_event_dose["revision"], ambiguous_dose["id"]: ambiguous_dose["revision"]}}).json()["error"]["code"] == "checklist_issue_unresolved"
    document = owner.post("/documents", expected=201, files={"file": ("authored-14-june-dose.txt", b"First treatment, 14 June 2026: dose 0.50 L/ha. Second treatment: 0.75 L/ha.\n", "text/plain")}, data={"farm_id": farm["id"]}).json()
    cited_dose = confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="dose", value="0.50", unit="L/ha", basis="calendar_date", period="2026-06-14"),
        "parcel_id": field_id, "sources": [event_source, {"document_id": document["id"], "document_revision": document["revision"], "note": "Read the original first-treatment dose, not the second visit."}]}))
    peer_citation = confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="dose", value="0.75", unit="L/ha", basis="calendar_date", period="2026-06-14"),
        "parcel_id": field_id, "sources": [{"record_id": same_day_peer["id"], "record_kind": "operations", "revision": same_day_peer["revision"]},
            {"document_id": document["id"], "document_revision": document["revision"], "note": "Separate second-treatment citation. Its later source issue must not be assigned to the first treatment."}]}))
    sound = owner.get(review_path).json()
    assert next(item for item in sound["items"] if item["key"] == unresolved["key"])["can_complete"] is True
    document = owner.post(f"/documents/{document['id']}/extract", json={"expected_revision": document["revision"], "document_type": "notebook"}).json()
    broken = owner.get(review_path).json()
    broken_item = next(item for item in broken["items"] if item["key"] == unresolved["key"])
    assert broken_item["can_complete"] is False and cited_dose["id"] not in {r["id"] for r in broken_item["evidence"]}
    assert broken_item["source_integrity_issues"], "A fresh fact revision/fingerprint cannot rehabilitate its stale cited document."
    assert owner.post(f"/checklists/{checklist['id']}/items/{unresolved['key']}/complete", expected=422, json={**unresolved_body,
        "expected_input_fingerprint": broken["expected_input_fingerprint"], "evidence_fact_ids": [cited_dose["id"]],
        "evidence_operation_ids": [incomplete_work["id"]], "evidence_document_ids": [document["id"]],
        "evidence_revisions": {cited_dose["id"]: cited_dose["revision"], incomplete_work["id"]: incomplete_work["revision"], document["id"]: document["revision"]}}).json()["error"]["code"] == "checklist_issue_unresolved"
    owner.post(f"/facts/{cited_dose['id']}/review", json={"expected_revision": cited_dose["revision"], "decision": "rejected", "note": "Original citation is stale after re-extraction; retain it and independently review a current citation."})
    confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="dose", value="0.50", unit="L/ha", basis="calendar_date", period="2026-06-14"),
        "parcel_id": field_id, "sources": [event_source, {"document_id": document["id"], "document_revision": document["revision"], "note": "Explicitly re-read the first actual treatment against the current document revision."}]}))
    stale = owner.post(f"/checklists/{checklist['id']}/items/{unresolved['key']}/complete", expected=409, json=unresolved_body).json()
    assert stale["error"]["code"] == "checklist_context_changed"
    review = owner.get(review_path).json()
    evidence_item = next(item for item in review["items"] if item["key"] == unresolved["key"])
    assert evidence_item["can_complete"] is True and evidence_item["evidence"]
    assert peer_citation["id"] not in {r["id"] for r in evidence_item["evidence"]}, "A different event's stale source must neither resolve nor block this sound event's own closure."
    eligible = [record for record in evidence_item["evidence"] if record["kind"] in {"facts", "operations"}]
    evidence_body = {"expected_revision": checklist["revision"], "expected_input_fingerprint": review["expected_input_fingerprint"],
        "note": "Compared the confirmed notebook entries for this farm's actual 2026 treatment dates.",
        "evidence_fact_ids": [r["id"] for r in eligible if r["kind"] == "facts"],
        "evidence_operation_ids": [r["id"] for r in eligible if r["kind"] == "operations"],
        "evidence_revisions": {r["id"]: r["revision"] for r in eligible}}
    complete_path = f"/checklists/{checklist['id']}/items/{evidence_item['key']}/complete"
    other_farm = owner.create("farms", farm_data("Same workspace but unrelated evidence farm"))
    invalid_evidence = [confirm(owner, owner.create("facts", fact_data(other_farm["id"], key="dose", value="0.50", unit="L/ha", basis="calendar_date", period="2026-06-11"))),
        owner.create("facts", fact_data(farm["id"], key="dose", value="0.25", unit="L/ha", basis="calendar_date", period="2026-06-20")),
        confirm(owner, owner.create("facts", fact_data(farm["id"], key="dose", value="0.50", unit="L/ha", basis="calendar_date", period="2025-06-11")))]
    for invalid in invalid_evidence:
        live = owner.get(review_path).json()
        rejected = owner.post(complete_path, expected=409, json={**evidence_body, "expected_input_fingerprint": live["expected_input_fingerprint"],
            "evidence_fact_ids": [invalid["id"]], "evidence_operation_ids": [], "evidence_revisions": {invalid["id"]: invalid["revision"]}}).json()
        assert rejected["error"]["code"] == "evidence_context_changed"
    live = owner.get(review_path).json()
    evidence_body["expected_input_fingerprint"] = live["expected_input_fingerprint"]
    outsider.post(complete_path, expected=404, json=evidence_body)
    assert owner.post(complete_path, expected=409, json={**evidence_body, "evidence_revisions": {}}).json()["error"]["code"] == "evidence_context_changed"
    checklist = owner.post(complete_path, json=evidence_body).json()
    completed = next(item for item in checklist["data"]["items"] if item["key"] == evidence_item["key"])
    assert completed["done"] is True and completed["status"] == "evidence_reviewed"
    assert owner.post(f"/tasks/{linked_task['id']}/complete", json={"expected_revision": linked_task["revision"], "note": "Reviewed this task's own linked action, not every unrelated checklist step."}).json()["data"]["status"] == "done"
    assert any(not item["done"] for item in checklist["data"]["items"]), "A task's own item can finish while unrelated actions remain open."

    live = owner.get(review_path).json()
    human = next(item for item in live["items"] if item["mode"] == "human_review")
    human_path = f"/checklists/{checklist['id']}/items/{human['key']}/complete"
    human_body = {"expected_revision": checklist["revision"], "expected_input_fingerprint": live["expected_input_fingerprint"], "note": "Read the cited source limits; the national deadline remains unknown, not certified."}
    assert owner.post(human_path, expected=422, json=human_body).json()["error"]["code"] == "explicit_review_required"
    checklist = owner.post(human_path, json={**human_body, "review_acknowledged": True}).json()
    assert next(i for i in checklist["data"]["items"] if i["key"] == human["key"])["status"] == "review_recorded"
    still_unknown = next(rule for rule in owner.get(f"/compliance/farms/{farm['id']}").json()["obligations"] if rule["id"] == "eu-ppp-surface-use")
    assert still_unknown["deadline"]["date"] is None and still_unknown["status"] != "ready_for_review"
    prior_revision = checklist["revision"]
    withdrawn = owner.get(f"/operations/{incomplete_work['id']}").json()
    owner.post(f"/operations/{withdrawn['id']}/review", json={"expected_revision": withdrawn["revision"], "decision": "rejected",
        "note": "Farmer withdrew this 14 June transcription after review. Preserve history and explicitly reassess its follow-ups; 11 June is not a substitute."})
    current_review = owner.get(review_path).json()
    old_action = next(item for item in current_review["items"] if item["key"] == evidence_item["key"])
    assert current_review["needs_refresh"] is True and old_action["requires_refresh"] is True
    assert old_action["can_complete"] is False and "event_context_changed" in {issue["code"] for issue in old_action["issues"]}
    assert owner.post(complete_path, expected=422, json={**evidence_body, "expected_revision": prior_revision,
        "expected_input_fingerprint": current_review["expected_input_fingerprint"]}).json()["error"]["code"] == "checklist_issue_unresolved"
    assert owner.post(f"/checklists/{checklist['id']}/refresh", expected=409, json={"expected_revision": prior_revision,
        "expected_input_fingerprint": "0" * 64}).json()["error"]["code"] == "checklist_context_changed"
    refreshed = owner.post(f"/checklists/{checklist['id']}/refresh", json={"expected_revision": prior_revision,
        "expected_input_fingerprint": current_review["expected_input_fingerprint"]}).json()
    assert refreshed["revision"] == prior_revision + 1 and all(not item["done"] for item in refreshed["data"]["items"])
    history = owner.get(f"/checklists/{checklist['id']}/history").json()["items"]
    assert any(h["revision"] == prior_revision and any(i.get("done") for i in h["data"]["items"]) for h in history)
    owner.post(f"/checklists/{checklist['id']}/refresh", expected=409, json={"expected_revision": prior_revision,
        "expected_input_fingerprint": current_review["expected_input_fingerprint"]})
    refreshed_review = owner.get(review_path).json()
    earlier = next(item for item in refreshed_review["items"] if item["key"] == "earlier-follow-ups")
    assert earlier["mode"] == "human_review" and earlier["can_complete"] is True
    reviewed_followup = owner.post(f"/checklists/{checklist['id']}/items/{earlier['key']}/complete", json={"expected_revision": refreshed["revision"],
        "expected_input_fingerprint": refreshed_review["expected_input_fingerprint"], "review_acknowledged": True,
        "note": "Reviewed withdrawn-event follow-ups against current evidence; this review does not establish that the 14 June event occurred."}).json()
    assert next(i for i in reviewed_followup["data"]["items"] if i["key"] == earlier["key"])["status"] == "review_recorded"

    # Ordinary pack/manual checklists keep strict real fact keys, review, farm
    # and actual ISO-date year validation; an old whole-checklist task is strict.
    legacy = owner.create("checklists", {"farm_id": farm["id"], "title": "Actual day evidence review", "reporting_year": 2026,
        "items": [{"key": "dose", "label": "Dose recorded on the actual application day", "done": False}]})
    whole_task = owner.create("tasks", {"farm_id": farm["id"], "title": "Older whole checklist follow-up", "checklist_id": legacy["id"]})
    owner.post(f"/tasks/{whole_task['id']}/complete", expected=422, json={"expected_revision": whole_task["revision"], "note": "The whole linked checklist is still incomplete."})
    for invalid, error in zip(invalid_evidence, ("invalid_evidence", "invalid_evidence", "wrong_period")):
        result = owner.post(f"/checklists/{legacy['id']}/items/dose/complete", expected=422, json={"expected_revision": legacy["revision"], "evidence_fact_ids": [invalid["id"]]}).json()
        assert result["error"]["code"] == error
    actual_dose = next(r for r in owner.get("/facts").json()["items"] if r["data"].get("key") == "dose"
        and r["data"].get("period") == "2026-06-11" and r["data"].get("farm_id") == farm["id"] and r["data"].get("review_status") == "confirmed")
    legacy = owner.post(f"/checklists/{legacy['id']}/items/dose/complete", json={"expected_revision": legacy["revision"], "evidence_fact_ids": [actual_dose["id"]]}).json()
    assert legacy["data"]["items"][0]["evidence_fact_ids"] == [actual_dose["id"]], "Actual-day facts in 2026 must be eligible without converting the date into a year string."

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
    # Correct native Boolean and multi-choice answers through explicit proposals
    # and review; serializing them as prose must never change applicability.
    profile_body["expected_farm_revision"] = farm["revision"]
    professional = owner.get(f"/facts/{professional['id']}").json()
    use_types = owner.get(f"/facts/{use_types['id']}").json()
    for source, value in ((professional, False), (use_types, ["closed_space"])):
        answer = {"key": source["data"]["key"], "value": value}
        assert owner.post(profile_path, expected=409, json={**profile_body, "answers": [answer]}).json()["error"]["code"] == "profile_correction_required"
        owner.post(profile_path, expected=409, json={**profile_body, "answers": [{**answer, "supersedes_id": source["id"], "expected_source_revision": source["revision"] - 1}]})
        proposal = owner.post(profile_path, json={**profile_body, "answers": [{**answer, "supersedes_id": source["id"], "expected_source_revision": source["revision"]}]}).json()["facts"][0]
        assert proposal["data"]["value"] == value and type(proposal["data"]["value"]) is type(value)
        assert proposal["data"]["review_status"] == "proposed" and proposal["data"]["supersedes_id"] == source["id"]
        assert owner.get(f"/facts/{source['id']}").json()["data"]["review_status"] == "confirmed"
        typed = next(q for q in owner.get(f"/compliance/farms/{farm['id']}").json()["profile_review"] if q["key"] == answer["key"])
        assert any(item["id"] == source["id"] and item["value"] == source["data"]["value"] for item in typed["confirmed"])
        proposal = confirm(owner, proposal, "Corrected the current activity answer against the authored farm notebook; keep the previous review in history.")
        assert proposal["data"]["value"] == value
        assert owner.get(f"/facts/{source['id']}").json()["data"]["review_status"] == "rejected"
        current = next(q for q in owner.get(f"/compliance/farms/{farm['id']}").json()["profile_review"] if q["key"] == answer["key"])
        assert current["current_value"] == value and current["state"] == "confirmed"
    for key, text in (("uses_professional_plant_protection", "false"), ("ppp_use_type", '["closed_space"]')):
        bad = owner.post("/facts", expected=422, json={"data": fact_data(farm["id"], key=key, value=text, unit=None)}).json()
        assert bad["error"]["code"] == "invalid_profile_answer"
    editable_profile = owner.create("facts", fact_data(farm["id"], key="organic_operator", value=True, unit=None))
    assert owner.patch(f"/facts/{editable_profile['id']}", expected=422, json={"expected_revision": editable_profile["revision"], "data": {"value": "false"}}).json()["error"]["code"] == "invalid_profile_answer"
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
