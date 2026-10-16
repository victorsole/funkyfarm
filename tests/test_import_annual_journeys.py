"""CSV evidence and annual reuse remain explicit, partial and source traceable."""

from decimal import Decimal
from uuid import uuid4

from conftest import confirm, fact_data, farm_data


def test_multirow_import_mapping_partial_review_and_duplicate_identity(farmers):
    owner = farmers("Import reviewer")
    outsider = farmers("Separate import account")
    farm = owner.create("farms", farm_data())
    source = b'identifier,annual_credit,comment\r\n0007,0,\r\n0007,"-12,50",NULL\r\n0008,unreadable,unknown\r\n'
    retry_key = "csv-" + uuid4().hex
    upload = {"files": {"file": ("fictional-credit-rows.csv", source, "text/csv")},
              "data": {"farm_id": farm["id"], "grain": "One fictional annual credit observation"},
              "headers": {"Idempotency-Key": retry_key}}
    imported = owner.post("/imports", expected=201, **upload).json()
    assert owner.post("/imports", expected=201, **upload).json()["id"] == imported["id"]
    original = owner.get(f"/imports/{imported['id']}/rows").json()["items"]
    assert [row["data"]["original_row"] for row in original] == [
        ["0007", "0", ""], ["0007", "-12,50", "NULL"], ["0008", "unreadable", "unknown"],
    ]
    assert owner.get("/facts").json()["total"] == 0
    outsider.get(f"/imports/{imported['id']}", expected=404)
    mapping = owner.post(f"/imports/{imported['id']}/mapping", json={
        "expected_revision": imported["revision"], "target": "facts",
        "defaults": {"farm_id": farm["id"], "key": "annual_credit", "label": "Annual credit",
                     "unit": "EUR", "period": "2025", "temporal_basis": "campaign_year"},
        "columns": [{"source_index": 0, "role": "identifier", "value_type": "text"},
                    {"source_index": 1, "target_field": "value", "value_type": "number", "decimal_separator": ","},
                    {"source_index": 2, "value_type": "text", "blank_behavior": "preserve"}],
    }).json()
    preview = owner.get(f"/imports/{imported['id']}/preview").json()["items"]
    assert len(preview) == 3
    assert preview[0]["can_save"] is True and preview[2]["can_save"] is False
    assert preview[1]["requires_acknowledgement"], "Duplicate source identifier requires a recorded decision."
    reviewed = owner.post(f"/imports/{imported['id']}/rows/review", json={
        "expected_revision": mapping["revision"], "note": "Explicit comma-decimal mapping; duplicate identifier represents a separately reviewed credit observation.",
        "rows": [{"row_number": item["row"]["data"]["row_number"], "expected_revision": item["row"]["revision"],
                  "preview_token": item["preview_token"], "acknowledged_issues": item["requires_acknowledgement"]} for item in preview],
    }).json()
    assert reviewed["saved_count"] == 1 and reviewed["failed_count"] == 2
    assert next(item for item in reviewed["items"] if item["row_number"] == 2)["error"]["code"] == "preview_changed"
    saved = [item["record"] for item in reviewed["items"] if item["status"] == "saved"]
    # Saving row one changed the competing-evidence context of row two. The
    # farmer must read its refreshed warnings before promoting that row.
    refreshed = owner.get(f"/imports/{imported['id']}/preview").json()
    second = refreshed["items"][1]
    repaired = owner.post(f"/imports/{imported['id']}/rows/review", json={
        "expected_revision": refreshed["import_revision"], "note": "Read the refreshed competing-value and duplicate-identifier warnings; retain both original sources for later reconciliation.",
        "rows": [{"row_number": 2, "expected_revision": second["row"]["revision"], "preview_token": second["preview_token"], "acknowledged_issues": second["requires_acknowledgement"]}],
    }).json()
    assert repaired["saved_count"] == 1 and repaired["failed_count"] == 0
    saved.append(repaired["items"][0]["record"])
    assert [Decimal(str(item["data"]["value"])) for item in saved] == [Decimal("0"), Decimal("-12.50")]
    assert all(item["data"]["review_status"] == "proposed" for item in saved)
    assert all(item["data"]["unit"] == "EUR" and item["data"]["period"] == "2025" for item in saved)
    assert all(any(source["import_id"] == imported["id"] and source["row_number"] in (1, 2) for source in item["data"]["sources"] if "import_id" in source) for item in saved)
    retained = owner.get(f"/imports/{imported['id']}/rows").json()["items"]
    assert [row["data"]["original_row"] for row in retained] == [row["data"]["original_row"] for row in original]
    assert retained[2]["data"]["review_status"] == "unreviewed"
    # The same reviewed source row cannot create a second farm record.
    repeat = owner.client.post(f"/imports/{imported['id']}/rows/review", json={
        "expected_revision": mapping["revision"], "note": "An uncertain response retry must not duplicate a promoted row.",
        "rows": [{"row_number": preview[0]["row"]["data"]["row_number"], "expected_revision": preview[0]["row"]["revision"], "preview_token": preview[0]["preview_token"], "acknowledged_issues": preview[0]["requires_acknowledgement"]}],
    })
    assert repeat.status_code in (200, 409)
    assert owner.get("/facts").json()["total"] == 2
    assert owner.get("/operations").json()["total"] == 0
    assert owner.get("/purchases").json()["total"] == 0


def test_annual_comparison_carries_proposals_without_reobserving_static_or_dated_work(farmers):
    owner = farmers("Annual reviewer")
    farm = owner.create("farms", farm_data())
    standing = confirm(owner, owner.create("facts", fact_data(farm["id"], key="holding_reference", value="000007", unit=None, period=None, basis="static")))
    previous = confirm(owner, owner.create("facts", fact_data(farm["id"], key="annual_area", value="3.75", period="2025")))
    dated = confirm(owner, owner.create("facts", fact_data(farm["id"], key="observed_inspection", value=True, unit=None, period="2025-10-12", basis="calendar_date")))
    comparison = {"farm_id": farm["id"], "from_period": "2025", "to_period": "2026"}
    before = owner.post("/guidance/compare-periods", json=comparison).json()["items"]
    by_key = {item["key"]: item for item in before}
    assert by_key["annual_area"]["status"] == "missing_current"
    assert by_key["holding_reference"]["status"] == "static_reference"
    owner.post("/guidance/carry-forward", json={**comparison, "fact_ids": [dated["id"]]}, expected=422)
    carried = owner.post("/guidance/carry-forward", json={**comparison, "fact_ids": [standing["id"], previous["id"]]}).json()
    assert len(carried["proposals"]) == 1
    proposal = carried["proposals"][0]
    assert proposal["data"]["value"] == "3.75"
    assert proposal["data"]["period"] == "2026" and proposal["data"]["review_status"] == "proposed"
    assert {item["fact_id"] for item in carried["static_references"]} == {standing["id"]}
    assert owner.get(f"/facts/{standing['id']}").json()["data"]["period"] is None
    assert owner.get(f"/facts/{previous['id']}").json()["data"]["period"] == "2025"
    changed = owner.patch(f"/facts/{proposal['id']}", json={"expected_revision": proposal["revision"], "data": {"value": "4.25"}}).json()
    confirm(owner, changed, "The 2026 survey changed the recorded annual area; earlier source retained.")
    after = owner.post("/guidance/compare-periods", json=comparison).json()["items"]
    assert next(item for item in after if item["key"] == "annual_area")["status"] == "changed"
    owner.post("/guidance/carry-forward", json={**comparison, "fact_ids": [previous["id"]]}, expected=409)
    facts = owner.get("/facts").json()["items"]
    assert len([fact for fact in facts if fact["data"]["key"] == "holding_reference"]) == 1
    assert len([fact for fact in facts if fact["data"]["key"] == "observed_inspection"]) == 1
    area = confirm(owner, owner.create("facts", fact_data(farm["id"], value="3.75", period=None, basis="static")))
    reused = confirm(owner, owner.create("facts", fact_data(farm["id"], key="reviewed_area_from_prior_source", value="4.25", period="2026", sources=[{
        "record_id": previous["id"], "record_kind": "facts", "revision": previous["revision"], "source_kind": "annual_reuse",
    }])), "The previous fact is context for this newly checked 2026 answer, not an operation.")
    observed = confirm(owner, owner.create("facts", fact_data(farm["id"], key="inspection_date_reviewed", value=True, unit=None, period="2026-05-10", basis="calendar_date")))
    zero = confirm(owner, owner.create("facts", fact_data(farm["id"], key="annual_credit_zero", value=0, unit="EUR", period="2026")))
    dated_requirement = {"key": "inspection_date_reviewed", "label": "Evidence for the requested inspection day", "temporal_basis": "calendar_date", "period": "2026-05-10"}
    request = owner.create("requests", {"farm_id": farm["id"], "title": "Evidence for one exact inspection day", "recipient": "Fictional inspector", "country": "DE", "reporting_year": 2026, "deadline": None, "pack_id": "farm-evidence", "requirements": [dated_requirement], "status": "draft"})
    report_body = {"farm_id": farm["id"], "request_id": request["id"], "pack_id": "farm-evidence", "reporting_year": 2026, "fact_ids": [area["id"], reused["id"], observed["id"], zero["id"]]}
    before_day_change = owner.post("/reports", expected=201, json=report_body).json()
    request = owner.patch(f"/requests/{request['id']}", json={"expected_revision": request["revision"], "data": {"requirements": [{**dated_requirement, "period": "2026-05-11"}]}}).json()
    owner.post(f"/reports/{before_day_change['id']}/approve", json={"expected_revision": before_day_change["revision"]}, expected=409)
    wrong_day = owner.post("/reports", expected=201, json=report_body).json()
    owner.post(f"/reports/{wrong_day['id']}/approve", json={"expected_revision": wrong_day["revision"]}, expected=409)
    request = owner.patch(f"/requests/{request['id']}", json={"expected_revision": request["revision"], "data": {"requirements": [dated_requirement]}}).json()
    draft = owner.post("/reports", expected=201, json=report_body).json()
    issued = owner.post(f"/reports/{draft['id']}/approve", json={"expected_revision": draft["revision"]}).json()
    dated_field = next(field for field in issued["data"]["snapshot"]["fields"] if field.get("fact_id") == observed["id"])
    assert issued["data"]["snapshot"]["reporting_year"] == 2026
    assert dated_field["period"] == "2026-05-10" and dated_field["temporal_basis"] == "calendar_date"
    assert next(field for field in issued["data"]["snapshot"]["fields"] if field.get("fact_id") == zero["id"])["value"] == 0
    assert owner.get("/operations").json()["total"] == 0
