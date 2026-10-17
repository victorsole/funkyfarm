"""Authored boundary files through real HTTP; no authority or observed-farm data.

The shared farmers/service_url fixtures enforce the dedicated local PostgreSQL
boundary and clean only their generated identities. No domain parser is mocked.
"""

from copy import deepcopy
import hashlib
import json
from pathlib import Path
from uuid import uuid4

import httpx

from conftest import farm_data, human_browser


def _ring(west, south, east, north):
    return [[west, south], [east, south], [east, north], [west, north], [west, south]]


def _shapes():
    polygon = {"type": "Polygon", "coordinates": [
        _ring(14, 50, 14.004, 50.004), _ring(14.001, 50.001, 14.003, 50.003)]}
    multipart = {"type": "MultiPolygon", "coordinates": [
        [_ring(14.010, 50, 14.014, 50.004), _ring(14.011, 50.001, 14.013, 50.003)],
        [_ring(14.016, 50, 14.018, 50.002)]]}
    return polygon, multipart


def _feature(geometry, **properties):
    return {"type": "Feature", "geometry": geometry, "properties": properties}


def _upload(farm, contents, format="geojson", **overrides):
    return {"expected_farm_revision": farm["revision"], "filename": "authored-fields." + format,
            "format": format, "contents": contents, "source_year": 2025, "source_origin": "my_file", **overrides}


def test_geojson_selection_is_one_additive_reviewed_batch_with_exact_retries(farmers, service_url):
    owner = farmers("Authored boundary-file owner")
    outsider = farmers("Unrelated boundary-file workspace")
    polygon, multipart = _shapes()
    existing = {"id": str(uuid4()), "name": "Existing field stays unchanged", "crop": "original wheat",
                "external_id": "SUPPLIED-0007", "revision": 4, "active": True,
                "geometry": {"type": "Polygon", "coordinates": [_ring(14, 50, 14.002, 50.002)]}}
    retired = {"id": str(uuid4()), "name": "Retired field stays retired", "crop": "past crop",
               "revision": 2, "active": False,
               "geometry": {"type": "Polygon", "coordinates": [_ring(14.020, 50, 14.022, 50.002)]}}
    farm = owner.create("farms", {**farm_data("Authored Czech import holding"), "country": "CZ", "region": None,
                                  "parcels": [existing, retired]})
    marker = "ORIGINAL-GEOJSON-ONLY-NOT-RETURNED"
    first = {**_feature(polygon, name=existing["name"], crop="supplied rye", external_id="SUPPLIED-0007",
                       private_original_note=marker), "id": existing["id"]}
    second = {**_feature(multipart, name="Žluťoučký <NetworkLink> & field", crop="ječmen"), "id": retired["id"]}
    skipped = {**_feature({"type": "Polygon", "coordinates": [_ring(14.030, 50, 14.032, 50.002)]},
                         name="Unchecked row must not be applied"), "id": "SOURCE-UNSELECTED-0009"}
    contents = json.dumps({"type": "FeatureCollection", "features": [first, second, skipped]}, ensure_ascii=False)
    body = _upload(farm, contents, source_origin="public_reference")
    path = f"/farms/{farm['id']}/field-imports"
    key = {"Idempotency-Key": "authored-file-" + uuid4().hex}
    with human_browser(owner, service_url) as browser:
        denied = browser.post(path, headers={"X-CSRF-Token": ""}, json=body)
        assert denied.status_code == 403 and denied.json()["error"]["code"] == "csrf_required"
        response = browser.post(path, headers=key, json=body)
        assert response.status_code == 201, response.text
        preview = response.json()
        assert browser.post(path, headers=key, json=body).json() == preview
    assert owner.post(path, expected=409, headers=key, json={**body, "filename": "different.geojson"}).json()["error"]["code"] == "idempotency_conflict"
    assert preview["data"]["status"] == "preview" and preview["data"]["farm_revision"] == farm["revision"]
    assert preview["data"]["sha256"] == hashlib.sha256(contents.encode("utf-8")).hexdigest()
    assert "contents" not in preview["data"] and marker not in json.dumps(preview)
    rows = preview["data"]["rows"]
    assert len(rows) == 3 and rows[0]["geometry"] == polygon and rows[1]["geometry"] == multipart
    assert rows[0]["source_feature_id"] == existing["id"] and rows[1]["source_feature_id"] == retired["id"]
    assert not {row["id"] for row in rows} & {existing["id"], retired["id"]}
    assert rows[1]["external_id"] is None, "A source feature ID is not an official or farmer-confirmed reference."
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    assert owner.get(f"/farms/{farm['id']}/field-proposals").json()["total"] == 0
    assert owner.get(f"/field-imports/{preview['id']}").json() == preview

    other_preview = owner.post(path, expected=201, json=body).json()
    # Selection order is explicit, not file order; a valid unchecked row stays out.
    selected = [rows[1]["id"], rows[0]["id"]]
    proposal_body = {"expected_revision": preview["revision"], "expected_farm_revision": farm["revision"],
                     "selected_ids": selected, "note": "Compared these exact two authored rows; no ownership or official-ID claim.",
                     "acknowledged": True}
    propose_path = f"/field-imports/{preview['id']}/propose"
    assert owner.post(propose_path, expected=422, json={**proposal_body, "acknowledged": False}).json()["error"]["code"] == "field_import_acknowledgement_required"
    for invalid_ids in ([rows[0]["id"], rows[0]["id"]], [other_preview["data"]["rows"][0]["id"]]):
        assert owner.post(propose_path, expected=422, json={**proposal_body, "selected_ids": invalid_ids}).json()["error"]["code"] == "field_import_selection"
    owner.post(propose_path, expected=409, json={**proposal_body, "expected_revision": preview["revision"] + 1})
    retry = {"Idempotency-Key": "authored-selection-" + uuid4().hex}
    proposed = owner.post(propose_path, expected=201, headers=retry, json=proposal_body).json()
    assert owner.post(propose_path, expected=201, headers=retry, json=proposal_body).json() == proposed
    assert owner.post(propose_path, expected=409, headers=retry, json={**proposal_body, "selected_ids": selected[::-1]}).json()["error"]["code"] == "idempotency_conflict"
    owner.post(propose_path, expected=409, json={**proposal_body, "expected_revision": proposed["import"]["revision"]})
    proposal = proposed["proposal"]
    data = proposal["data"]
    assert proposed["import"]["data"]["status"] == "proposed" and proposed["import"]["data"]["proposal_id"] == proposal["id"]
    assert "contents" not in proposed["import"]["data"] and marker not in json.dumps(proposed)
    assert data["status"] == "proposed" and data["operation"] == "import" and data["previous_parcels"] == []
    assert [parcel["id"] for parcel in data["parcels"]] == selected
    assert [parcel["geometry"] for parcel in data["parcels"]] == [multipart, polygon]
    assert data["parcels"][0]["external_id"] is None and data["parcels"][1]["external_id"] == "SUPPLIED-0007"
    assert all("reviewed_at" not in parcel and "reviewed_by" not in parcel for parcel in data["parcels"])
    assert data["lineage"]["parents"] == [] and data["import_source"]["selected_ids"] == selected
    assert data["import_source"]["sha256"] == preview["data"]["sha256"] and data["import_source"]["source_year"] == 2025
    assert all(parcel["import_source"]["row_id"] == parcel["id"] for parcel in data["parcels"])
    assert any("does not update" in warning for warning in data["warnings"])
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    owner.patch(f"/field-proposals/{proposal['id']}", expected=409, json={"expected_revision": proposal["revision"],
        "expected_farm_revision": farm["revision"], "parcel": {"name": "No individual batch row rewrite"}})

    approval_path = f"/field-proposals/{proposal['id']}/approve"
    decision = {"expected_revision": proposal["revision"], "expected_farm_revision": farm["revision"],
                "note": "Human checked every selected outline and the explicit overlap.", "accept_overlap": True}
    # Approval is all-or-nothing: wrong proposal revision rolls back any farm write.
    owner.post(approval_path, expected=409, json={**decision, "expected_revision": proposal["revision"] + 1})
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    owner.post(approval_path, expected=409, json={**decision, "expected_farm_revision": farm["revision"] + 1})
    owner.post(approval_path, expected=422, json={**decision, "selected_ids": [selected[0]]})
    blocked = owner.post(approval_path, expected=422, json={**decision, "accept_overlap": False}).json()
    assert blocked["error"]["code"] == "overlap_review_required"
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    for foreign_path in (f"/field-imports/{preview['id']}", f"/field-proposals/{proposal['id']}", f"/farms/{farm['id']}/lpis-guide"):
        outsider.get(foreign_path, expected=404)
    outsider.post(path, expected=404, json=body)
    outsider.post(propose_path, expected=404, json=proposal_body)
    outsider.post(approval_path, expected=404, json=decision)

    approval_key = {"Idempotency-Key": "authored-human-batch-" + uuid4().hex}
    with human_browser(owner, service_url) as browser:
        response = browser.post(approval_path, headers=approval_key, json=decision)
        assert response.status_code == 200, response.text
        applied = response.json()
        assert browser.post(approval_path, headers=approval_key, json=decision).json() == applied
    saved = applied["farm"]
    assert saved["revision"] == farm["revision"] + 1 and applied["proposal"]["data"]["status"] == "approved"
    by_id = {parcel["id"]: parcel for parcel in saved["data"]["parcels"]}
    assert set(by_id) == {existing["id"], retired["id"], *selected}
    assert by_id[existing["id"]] == existing and by_id[retired["id"]] == retired
    assert by_id[selected[0]]["geometry"] == multipart and by_id[selected[1]]["geometry"] == polygon
    assert all(by_id[value]["active"] is True and by_id[value]["reviewed_by"] == owner.user_id for value in selected)
    assert rows[2]["id"] not in by_id and all(by_id[value]["lineage"]["parents"] == [] for value in selected)
    assert {item["id"] for item in owner.get(f"/farms/{farm['id']}/fields").json()["items"]} == {existing["id"], *selected}
    assert len(owner.get(f"/farms/{farm['id']}/fields", params={"include_retired": "true"}).json()["items"]) == 4
    assert owner.get(f"/farms/{farm['id']}").json() == saved
    assert owner.get(f"/farms/{farm['id']}/field-proposals").json()["total"] == 1
    assert "contents" not in owner.get(f"/field-imports/{preview['id']}").json()["data"]
    assert owner.get("/reports").json()["total"] == 0, "Private field approval must not invent an official filing."


def test_kml_multipart_holes_preserve_source_text_and_require_a_fresh_farm_preview(farmers, service_url):
    owner = farmers("Authored KML reviewer")
    farm = owner.create("farms", {**farm_data("Authored Dutch KML holding"), "country": "NL", "region": None})
    _, multipart = _shapes()
    contents = '''<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark id="SOURCE-ONLY-0008">
<name>Authored &lt;NetworkLink&gt; &amp; Žito</name><description>ORIGINAL-KML-ONLY-NOT-RETURNED</description>
<ExtendedData><Data name="crop"><value>Žito &amp; oves</value></Data></ExtendedData><MultiGeometry>
<Polygon><outerBoundaryIs><LinearRing><coordinates>14.010,50,7 14.014,50,7 14.014,50.004,7 14.010,50.004,7 14.010,50,7</coordinates></LinearRing></outerBoundaryIs>
<innerBoundaryIs><LinearRing><coordinates>14.011,50.001,7 14.013,50.001,7 14.013,50.003,7 14.011,50.003,7 14.011,50.001,7</coordinates></LinearRing></innerBoundaryIs></Polygon>
<Polygon><outerBoundaryIs><LinearRing><coordinates>14.016,50,0 14.018,50,0 14.018,50.002,0 14.016,50.002,0 14.016,50,0</coordinates></LinearRing></outerBoundaryIs></Polygon>
</MultiGeometry></Placemark></Document></kml>'''
    path = f"/farms/{farm['id']}/field-imports"
    body = _upload(farm, contents, "kml")
    stale = owner.post(path, expected=201, json=body).json()
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"],
        "data": {"notes": "Farm context changed after the file preview; no field applied."}}).json()
    stale_selection = {"expected_revision": stale["revision"], "expected_farm_revision": farm["revision"],
        "selected_ids": [stale["data"]["rows"][0]["id"]], "note": "Stale preview must not become a field.", "acknowledged": True}
    assert owner.post(f"/field-imports/{stale['id']}/propose", expected=409, json=stale_selection).json()["error"]["code"] == "revision_conflict"
    assert owner.get(f"/field-imports/{stale['id']}").json()["data"]["status"] == "preview"
    assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
    preview = owner.post(path, expected=201, json={**body, "expected_farm_revision": farm["revision"]}).json()
    row = preview["data"]["rows"][0]
    assert row["name"] == "Authored <NetworkLink> & Žito" and row["crop"] == "Žito & oves"
    assert row["source_feature_id"] == "SOURCE-ONLY-0008" and row["external_id"] is None
    assert row["geometry"] == multipart and len(row["geometry"]["coordinates"][0]) == 2
    assert any("altitude" in warning.lower() for warning in row["warnings"])
    assert preview["data"]["sha256"] == hashlib.sha256(contents.encode()).hexdigest()
    assert "contents" not in preview["data"] and "ORIGINAL-KML-ONLY-NOT-RETURNED" not in json.dumps(preview)
    proposed = owner.post(f"/field-imports/{preview['id']}/propose", expected=201, json={**stale_selection,
        "expected_revision": preview["revision"], "selected_ids": [row["id"]]}).json()["proposal"]
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"],
        "data": {"notes": "A second context change invalidates the prepared batch before approval."}}).json()
    failed = owner.post(f"/field-proposals/{proposed['id']}/approve", expected=409,
        json={"expected_revision": proposed["revision"], "expected_farm_revision": farm["revision"]}).json()
    assert failed["error"]["code"] == "revision_conflict"
    assert owner.get(f"/field-proposals/{proposed['id']}").json()["data"]["status"] == "proposed"
    assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []
    refreshed = owner.post(path, expected=201, json={**body, "expected_farm_revision": farm["revision"]}).json()
    proposed = owner.post(f"/field-imports/{refreshed['id']}/propose", expected=201,
        json={**stale_selection, "expected_revision": refreshed["revision"], "expected_farm_revision": farm["revision"],
              "selected_ids": [refreshed["data"]["rows"][0]["id"]], "note": "Re-read this exact file against the current holding context."}).json()["proposal"]
    with human_browser(owner, service_url) as browser:
        result = browser.post(f"/field-proposals/{proposed['id']}/approve", json={"expected_revision": proposed["revision"],
            "expected_farm_revision": farm["revision"], "note": "Compared both parts, the excluded ring and supplied source year."})
        assert result.status_code == 200, result.text
    saved = result.json()["farm"]["data"]["parcels"]
    assert len(saved) == 1 and saved[0]["geometry"] == multipart and saved[0]["external_id"] is None
    assert saved[0]["import_source"]["source_year"] == 2025 and saved[0]["lineage"]["operation"] == "import"


def test_file_parser_access_and_country_handoffs_fail_closed_without_provider_fetches(farmers, service_url, authored_stac):
    owner = farmers("Authored import boundary reviewer")
    farm = owner.create("farms", {**farm_data("Authored parser holding"), "country": "CZ", "region": None})
    polygon, _ = _shapes()
    feature = _feature(polygon, name="Authored valid polygon")
    valid = json.dumps(feature)
    path = f"/farms/{farm['id']}/field-imports"
    with httpx.Client(base_url=service_url + "/", timeout=30, trust_env=False) as anonymous:
        assert anonymous.post(path, json=_upload(farm, valid)).status_code == 401
        assert anonymous.get(f"/farms/{farm['id']}/lpis-guide").status_code == 401
    with human_browser(owner, service_url) as browser:
        credential = browser.post("/assistant/credentials", json={"name": "Authored assistant cannot directly import files",
            "farm_ids": [farm["id"]], "permissions": ["read", "propose"], "expires_in_days": 1})
        assert credential.status_code == 201, credential.text
        with httpx.Client(base_url=service_url + "/", headers={"Authorization": "Bearer " + credential.json()["token"]},
                          timeout=30, trust_env=False) as agent:
            assert agent.post(path, json=_upload(farm, valid)).status_code == 403
            assert agent.get(f"/farms/{farm['id']}/lpis-guide").status_code == 403
    valid_kml = '<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>14,50 14.004,50 14.004,50.004 14,50.004 14,50</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>'
    unsafe = [
        ("kml", '<!DOCTYPE kml [<!ENTITY remote SYSTEM "' + authored_stac["url"] + '">]>' + valid_kml, "field_import_unsafe_xml"),
        ("kml", valid_kml.replace("<Placemark>", '<NetworkLink><Link><href>' + authored_stac["url"] + '</href></Link></NetworkLink><Placemark>'), "field_import_unsupported_kml"),
        ("geojson", valid.replace('"type": "Feature"', '"type": "Feature", "type": "Feature"', 1), "field_import_duplicate_key"),
        ("geojson", json.dumps({**feature, "crs": {"type": "name", "properties": {"name": "EPSG:5514"}}}), "field_import_crs"),
        ("geojson", json.dumps({"type": "FeatureCollection", "features": [feature,
            _feature({"type": "Point", "coordinates": [14, 50]}, name="Do not skip this invalid row")]}), "field_import_invalid"),
    ]
    # The supplied hackathon guide explicitly labels its parcel WKT/coordinates
    # as synthetic local metres with no geographic CRS. This wholly authored
    # analogue must not become a WGS84 field by deleting the source CRS label.
    local_contents = (Path(__file__).parent / "fixtures" / "import-polish" / "local-metres-authored.geojson").read_text(encoding="utf-8")
    unsafe.append(("geojson", local_contents, "field_import_crs"))
    unlabeled_local = json.loads(local_contents)
    unlabeled_local.pop("crs")
    unsafe.append(("geojson", json.dumps(unlabeled_local), "invalid_geometry"))
    for axis in range(3):
        malformed = deepcopy(feature)
        point = malformed["geometry"]["coordinates"][0][0]
        if axis == 2:
            point.append(10 ** 400)
        else:
            point[axis] = 10 ** 400
        unsafe.append(("geojson", json.dumps(malformed), "field_import_invalid"))
    provider_before = (len(authored_stac["calls"]), len(authored_stac["public_calls"]))
    for format, contents, code in unsafe:
        failure = owner.post(path, expected=422, json=_upload(farm, contents, format)).json()
        assert failure["error"]["code"] == code
    owner.post(path, expected=422, json=_upload(farm,
        "POLYGON ((1000 2000,1100 2000,1100 2100,1000 2100,1000 2000))", "wkt"))
    assert (len(authored_stac["calls"]), len(authored_stac["public_calls"])) == provider_before
    assert owner.get(f"/farms/{farm['id']}").json() == farm
    assert owner.get(f"/farms/{farm['id']}/field-proposals").json()["total"] == 0
    assert owner.get(f"/farms/{farm['id']}/fields").json()["items"] == []

    funding_path = f"/farms/{farm['id']}/funding-guide"
    funding = owner.get(funding_path).json()
    assert funding["farm"]["id"] == farm["id"] and funding["farm"]["country"] == "CZ"
    assert funding["personalised_eligibility"] is False and funding["application_enabled"] is False
    assert "Separate from your CAP" in funding["scope_notice"]
    agrip = next(item for item in funding["items"] if item["id"] == "eu-agrip-promotion")
    assert agrip["eligibility_status"] == "not_assessed" and "CAP area-payment" in agrip["relationship_to_cap"]
    assert agrip["call_2026"]["status"] == "closed" and agrip["call_2026"]["deadline"] == "2026-04-23"
    assert set(agrip["call_2026"]["call_ids"]) == {"AGRIP-SIMPLE-2026", "AGRIP-MULTI-2026"}
    assert agrip["future_calls"]["status"] == "not_verified" and agrip["future_calls"]["campaign"] == 2027
    assert agrip["future_calls"].get("deadline") is None
    source_urls = {source["url"] for source in agrip["sources"]}
    assert source_urls == {
        "https://rea.ec.europa.eu/funding-and-grants/promotion-agricultural-products-0/calls-proposals-promotion-agricultural-products_en",
        "https://rea.ec.europa.eu/funding-and-grants/promotion-agricultural-products-0/who-can-apply-promotion-agricultural-products_en",
    }
    assert {link["url"] for link in agrip["official_links"]} == source_urls
    farmers("Unrelated funding-guide workspace").get(funding_path, expected=404)
    assert owner.get(f"/farms/{farm['id']}").json() == farm

    expected_profiles = {"CZ": "cz-lpis-drawing", "NL": "nl-mijn-percelen-gps", "SK": "sk-gsaa-land-register"}
    for country in ("CZ", "NL", "SK", "FR"):
        current = farm if country == "CZ" else owner.create("farms", {**farm_data("Authored " + country + " guidance holding"), "country": country, "region": None})
        guide = owner.get(f"/farms/{current['id']}/lpis-guide").json()
        assert guide["farm_id"] == current["id"] and guide["farm_revision"] == current["revision"]
        assert guide["country"] == country and guide["reporting_year"] == 2026
        assert guide["definition_hash"] and guide["official_url"].startswith("https://")
        assert "No official register or claim is changed" in guide["notice"]
        if country == "FR":
            assert guide["coverage"] == "general_guidance_only" and guide["profiles"] == []
            continue
        assert guide["coverage"] == "documented_steps"
        profile, = guide["profiles"]
        assert profile["id"] == expected_profiles[country] and profile["import_acceptance_verified"] is False
        assert set(profile["app_export_formats"]) == {"geojson", "kml", "correction"}
        assert profile["steps"] and profile["sources"] and profile["limits"]
        if country == "SK":
            assert "EPVP" in profile["applies_to"] and profile["campaign_year"] == 2026
            assert "slovensko.sk" in json.dumps(profile["steps"]) and profile["authority_import_formats"] == []
        elif country == "CZ":
            assert "SHP" in profile["authority_import_formats"] and "DPB" in profile["applies_to"]
        else:
            assert any("KML" in value for value in profile["authority_import_formats"])
