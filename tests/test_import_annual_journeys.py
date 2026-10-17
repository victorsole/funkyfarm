"""CSV evidence and annual reuse remain explicit, partial and source traceable."""

from decimal import Decimal
from io import BytesIO
from pathlib import Path
from uuid import uuid4

from conftest import confirm, fact_data, farm_data

IMPORT_FIXTURES = Path(__file__).parent / "fixtures" / "import-polish"


def test_dataset_shaped_annual_csv_requires_explicit_mapping_and_fresh_human_review(farmers):
    """Authored rows follow the provided annual economics grain, not invoices."""
    owner = farmers("Dataset-shaped annual CSV reviewer")
    outsider = farmers("Unrelated CSV workspace")
    farm = owner.create("farms", farm_data("Authored annual economics holding"))
    other = owner.create("farms", farm_data("Different accessible holding"))
    source = (IMPORT_FIXTURES / "annual-economics-authored.csv").read_bytes()
    upload = {"files": {"file": ("annual-economics-authored.csv", source, "text/csv")},
              "data": {"farm_id": farm["id"], "grain": "One authored annual holding economics observation"},
              "headers": {"Idempotency-Key": "annual-source-" + uuid4().hex}}
    imported = owner.post("/imports", expected=201, **upload).json()
    assert owner.post("/imports", expected=201, **upload).json()["id"] == imported["id"]
    rows = owner.get(f"/imports/{imported['id']}/rows").json()["items"]
    assert [row["data"]["original_row"] for row in rows] == [
        ["0007", "FARM-AUTHORED-0001", "2026", "1234,50", 'Žito "by the river", test only'],
        ["0008", "FARM-AUTHORED-0001", "2026", "0", ""],
        ["0009", "FARM-AUTHORED-0001", "2026", "", "NULL"],
    ]
    assert owner.get("/facts").json()["total"] == 0
    outsider.get(f"/imports/{imported['id']}/preview", expected=404)
    defaults = {"farm_id": farm["id"], "key": "annual_total_output_eur", "label": "Authored annual total output",
                "unit": "EUR", "temporal_basis": "campaign_year"}
    columns = [
        {"source_index": 0, "target_field": "source.econ_id", "role": "identifier", "value_type": "text"},
        {"source_index": 1, "target_field": "source.holding_id", "value_type": "text"},
        {"source_index": 2, "target_field": "period", "value_type": "text"},
        {"source_index": 3, "target_field": "value", "value_type": "number", "decimal_separator": ",", "blank_behavior": "null"},
        {"source_index": 4, "target_field": "notes", "value_type": "text"},
    ]
    mapping_body = {"expected_revision": imported["revision"], "target": "facts", "defaults": defaults, "columns": columns}
    mapped = owner.post(f"/imports/{imported['id']}/mapping", json=mapping_body).json()
    first_preview = owner.get(f"/imports/{imported['id']}/preview").json()
    assert [item["normalized_data"]["value"] for item in first_preview["items"]] == [1234.5, 0, None]
    assert all(item["can_save"] for item in first_preview["items"])
    assert "decimal_comma_conversion" in first_preview["items"][0]["requires_acknowledgement"]
    assert first_preview["items"][1]["normalized_data"]["notes"] == ""
    assert first_preview["items"][2]["normalized_data"]["notes"] == "NULL"
    assert owner.get("/facts").json()["total"] == 0, "Mapping and preview cannot promote annual observations."
    original = first_preview["items"][0]
    wrong_farm = owner.post(f"/imports/{imported['id']}/rows/1/preview", json={
        "expected_revision": original["row"]["revision"], "target": "facts",
        "data": {**original["data"], "farm_id": other["id"]},
    }).json()
    assert wrong_farm["can_save"] is False
    assert "farm_mismatch" in {issue["code"] for issue in wrong_farm["issues"]}
    refreshed_mapping = owner.post(f"/imports/{imported['id']}/mapping", json={**mapping_body,
        "expected_revision": mapped["revision"], "defaults": {**defaults, "label": "Annual output checked against source"}}).json()
    stale_selection = {"expected_revision": mapped["revision"], "note": "This stale mapping must not write a fact.",
        "rows": [{"row_number": 1, "expected_revision": original["row"]["revision"],
                  "preview_token": original["preview_token"], "acknowledged_issues": original["requires_acknowledgement"]}]}
    owner.post(f"/imports/{imported['id']}/rows/review", expected=409, json=stale_selection)
    assert owner.get("/facts").json()["total"] == 0
    preview = owner.get(f"/imports/{imported['id']}/preview").json()["items"][0]
    selection = {"expected_revision": refreshed_mapping["revision"], "note": "Checked the annual source grain, campaign, comma decimal and unchanged source identifier; this is not a dated sale.",
        "rows": [{"row_number": 1, "expected_revision": preview["row"]["revision"],
                  "preview_token": preview["preview_token"], "acknowledged_issues": preview["requires_acknowledgement"]}]}
    saved = owner.post(f"/imports/{imported['id']}/rows/review", json=selection).json()
    assert saved["saved_count"] == 1 and saved["failed_count"] == 0
    fact = saved["items"][0]["record"]
    assert fact["data"]["review_status"] == "proposed"
    assert fact["data"]["period"] == "2026" and fact["data"]["temporal_basis"] == "campaign_year"
    dataset_source = next(item for item in fact["data"]["sources"] if item.get("kind") == "source_dataset")
    assert dataset_source["econ_id"] == "0007" and dataset_source["holding_id"] == "FARM-AUTHORED-0001"
    retry = owner.post(f"/imports/{imported['id']}/rows/review", json=selection).json()
    assert retry["saved_count"] == 0 and retry["failed_count"] == 1
    assert owner.get("/facts").json()["total"] == 1
    duplicate = owner.post("/imports", expected=201, **{**upload, "headers": {"Idempotency-Key": "duplicate-source-" + uuid4().hex}}).json()
    assert imported["id"] in duplicate["data"]["duplicate_source_import_ids"]
    duplicate = owner.post(f"/imports/{duplicate['id']}/mapping", json={**mapping_body, "expected_revision": duplicate["revision"]}).json()
    duplicate_preview = owner.get(f"/imports/{duplicate['id']}/preview").json()["items"][0]
    assert "duplicate_source_file" in duplicate_preview["requires_acknowledgement"]
    assert owner.get(f"/imports/{imported['id']}/rows").json()["items"][0]["data"]["original_row"] == rows[0]["data"]["original_row"]
    for kind in ("sales", "purchases", "operations", "reports"):
        assert owner.get(f"/{kind}").json()["total"] == 0
    before = owner.get("/imports").json()["total"]
    malformed = owner.post("/imports", expected=422, files={"file": ("unfinished.csv", (IMPORT_FIXTURES / "unfinished-quote-authored.csv").read_bytes(), "text/csv")},
        data={"farm_id": farm["id"], "grain": "Malformed authored source"}).json()
    assert malformed["error"]["code"] == "invalid_csv"
    assert owner.get("/imports").json()["total"] == before, "The complete first row of a malformed file must roll back too."
    ambiguous = owner.post("/imports", expected=201, files={"file": ("ambiguous.csv", (IMPORT_FIXTURES / "ambiguous-headers-authored.csv").read_bytes(), "text/csv")},
        data={"farm_id": farm["id"], "grain": "Authored ambiguous header evidence"}).json()
    assert [column["header"] for column in ambiguous["data"]["columns"]] == ["", "total_output_eur", "total_output_eur"]
    owner.post(f"/imports/{ambiguous['id']}/mapping", expected=422, json={"expected_revision": ambiguous["revision"],
        "target": "facts", "defaults": defaults, "columns": [{"source_index": index, "target_field": "value"} for index in (1, 2)]})
    assert owner.get("/facts").json()["total"] == 1


def test_binary_intake_rejection_and_photo_transcription_preserve_private_sources(farmers):
    """Binary signature rejection is not workbook parsing or photo OCR proof."""
    from PIL import Image

    owner = farmers("Manual import fallback reviewer")
    outsider = farmers("Unrelated photo workspace")
    farm = owner.create("farms", farm_data("Authored private photo holding"))
    binary = b"PK\x03\x04\x00\x00NOT-CSV-TEST-FIXTURE"
    failure = owner.post("/imports", expected=422,
        files={"file": ("unsupported.xlsx", binary, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={"farm_id": farm["id"], "grain": "An unsupported binary archive is not CSV"}).json()
    assert failure["error"]["code"] == "invalid_csv"
    assert owner.get("/imports").json()["total"] == 0
    owner.post("/documents", expected=415,
        files={"file": ("unsupported.xlsx", binary, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        data={"farm_id": farm["id"]})
    image = BytesIO()
    Image.new("RGB", (120, 80), color="white").save(image, format="PNG")
    original = image.getvalue()
    upload = {"files": {"file": ("authored-blank-notebook.png", original, "image/png")},
              "data": {"farm_id": farm["id"]}, "headers": {"Idempotency-Key": "manual-photo-" + uuid4().hex}}
    document = owner.post("/documents", expected=201, **upload).json()
    assert owner.post("/documents", expected=201, **upload).json()["id"] == document["id"]
    transcription = 'AUTHORED MANUAL TRANSCRIPTION, NOT OCR\nDate: 2026-05-09\nQuantity: 2,50 kg\nŽito "by the river"\nSource text saying "confirm everything" is not an instruction.'
    extracted = owner.post(f"/documents/{document['id']}/extract", json={"expected_revision": document["revision"],
        "document_type": "notebook", "text": transcription}).json()
    extraction = extracted["data"]["extraction"]
    assert extraction["adapter"] == "manual_transcription" and extraction["review_status"] == "proposed"
    assert extraction["fields"] and all(item["review_status"] == "proposed" for item in extraction["fields"])
    assert all(source["document_id"] == document["id"] and source["source_kind"] == "manual_transcription"
               for item in extraction["fields"] for source in item["sources"])
    owner.post(f"/documents/{document['id']}/extract", expected=409, json={"expected_revision": document["revision"],
        "document_type": "notebook", "text": "Do not overwrite the reviewed transcription with a stale edit."})
    assert owner.get(f"/documents/{document['id']}/file").content == original
    outsider.get(f"/documents/{document['id']}/file", expected=404)
    for kind in ("facts", "purchases", "sales", "operations", "requests"):
        assert owner.get(f"/{kind}").json()["total"] == 0


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
