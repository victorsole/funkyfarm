"""A fictional receipt is purchase evidence; actual use needs its own record."""

from decimal import Decimal
from io import BytesIO
from uuid import uuid4

from pypdf import PdfReader

from conftest import confirm, fact_data, farm_data


def test_farmer_receipt_separate_use_and_reviewed_french_draft_export(farmers):
    owner = farmers("Fictional French smallholder")
    onboarded = owner.post("/workflow/onboard", expected=201, json={
        "name": "Authored one-hectare example", "country": "FR", "region": None,
        "farm_type": "arable", "reporting_year": 2026, "previous_document_ids": [],
    }).json()
    farm = onboarded["farm"]
    assert farm["data"]["country"] == "FR"
    field_ids = [str(uuid4()), str(uuid4())]
    farm = owner.patch(f"/farms/{farm['id']}", json={"expected_revision": farm["revision"], "data": {
        "parcels": [{"id": field_ids[0], "name": "North authored outdoor field"}, {"id": field_ids[1], "name": "South authored outdoor field"}],
    }}).json()
    original = b"FICTIONAL RECEIPT - NOT A REAL SUPPLIER\nSupplier: Authored co-op\nDate: 2026-05-09\nQuantity: 2,50 L\fFICTIONAL RECEIPT PAGE TWO\nTotal: 12.50 EUR\nVAT: unreadable\n"
    document = owner.post("/documents", files={"file": ("authored-two-page-receipt.txt", original, "text/plain")}, data={"farm_id": farm["id"]}, expected=201).json()
    extracted = owner.post(f"/documents/{document['id']}/extract", json={"expected_revision": document["revision"], "document_type": "receipt"}).json()
    suggestions = extracted["data"]["extraction"]
    assert extracted["data"]["page_count"] == 2
    assert suggestions["review_status"] == "proposed"
    assert {source["page"] for field in suggestions["fields"] for source in field["sources"]} == {1, 2}
    assert owner.get("/purchases").json()["total"] == 0 and owner.get("/operations").json()["total"] == 0
    purchase_data = {"farm_id": farm["id"], "title": "Authored treatment-product purchase", "date": "2026-05-09",
                     "quantity": "2,50", "unit": None, "amount": None, "currency": "EUR", "category": "crop_treatment"}
    unresolved = owner.post("/workflow/check", json={"kind": "purchases", "data": purchase_data}).json()
    assert unresolved["can_save"] is False
    assert {issue["field"] for issue in unresolved["issues"] if issue["severity"] == "error"} >= {"unit", "amount"}
    supplied = {**purchase_data, "unit": "L", "amount": "12.50"}
    checked = owner.post("/workflow/check", json={"kind": "purchases", "data": supplied}).json()
    assert checked["can_save"] is True
    assert "decimal_comma" in checked["requires_acknowledgement"]
    assert Decimal(str(checked["normalized_data"]["quantity"])) == Decimal("2.50")
    assert checked["normalized_data"]["unit"] == "l"
    saved = owner.post(f"/documents/{document['id']}/records", expected=201, headers={"Idempotency-Key": "receipt-record-" + uuid4().hex}, json={
        "expected_revision": extracted["revision"], "kind": "purchases", "data": checked["normalized_data"],
        "selected_proposal_ids": [field["id"] for field in suggestions["fields"]],
        "acknowledged_issue_codes": checked["requires_acknowledgement"],
    }).json()
    assert saved["data"]["review_status"] == "proposed"
    purchase = owner.post(f"/purchases/{saved['id']}/review", json={"expected_revision": saved["revision"], "decision": "confirmed", "note": "Checked both authored receipt pages; unreadable VAT remains unknown."}).json()
    assert purchase["data"].get("tax_amount") is None
    assert owner.get("/operations").json()["total"] == 0
    assert owner.get(f"/documents/{document['id']}/file").content == original

    actual_use = {"farm_id": farm["id"], "title": "Farmer independently recorded outdoor use", "type": "pesticide_application",
                  "date": "2026-05-10", "parcel": "Authored one-hectare outdoor field", "product": "Authored crop-treatment example",
                  "quantity": "0.50", "unit": "l", "document_id": document["id"],
                  "notes": "Actual 0.50 L used on 1.00 ha, from a separate work note; purchase was 2.50 L."}
    receipt_current = owner.get(f"/documents/{document['id']}").json()
    owner.post(f"/documents/{document['id']}/records", expected=422, json={
        "expected_revision": receipt_current["revision"], "kind": "operations", "data": actual_use,
        "selected_proposal_ids": [], "acknowledged_issue_codes": [],
    })
    notebook = owner.post("/documents", files={"file": ("authored-work-note.txt", b"FICTIONAL FIELD NOTE\n2026-05-10: actually used 0.50 L on 1.00 ha outdoors.\n", "text/plain")}, data={"farm_id": farm["id"]}, expected=201).json()
    owner.post(f"/documents/{notebook['id']}/extract", json={"expected_revision": notebook["revision"], "document_type": "notebook"})
    actual_use["document_id"] = notebook["id"]
    work_check = owner.post("/workflow/check", json={"kind": "operations", "data": actual_use, "reporting_year": 2026}).json()
    assert work_check["can_save"] is True
    work = owner.post("/workflow/capture", expected=201, json={"kind": "operations", "data": actual_use, "reporting_year": 2026,
        "check_token": work_check["check_token"], "acknowledged_codes": work_check["requires_acknowledgement"]}).json()["record"]
    reviewed_work = owner.post(f"/operations/{work['id']}/review", json={"expected_revision": work["revision"], "decision": "confirmed", "note": "Checked actual outdoor field, work date and 0.50 L used; purchase quantity is separate."}).json()
    assert Decimal(str(reviewed_work["data"]["quantity"])) == Decimal("0.50")
    assert Decimal(str(purchase["data"]["quantity"])) == Decimal("2.50")
    pack = owner.get("/packs/FR-inputs-2026").json()
    assert pack["country"] == "FR" and pack["capability"] == "sourced_draft_mapping"
    assert pack["authority_ready"] is False
    # Authored declarations for source-mapped fields. These identifiers do not
    # establish any real SIRET, product authorisation, signature or legal status.
    declarations = [
        ("siret_holder", "12345678901234", None, None, "static"),
        ("product_name", "Authored crop-treatment example", None, "2026-05-10", "calendar_date"),
        ("product_authorisation", "1234567", None, "2026-05-10", "calendar_date"),
        ("application_date", "10/05/2026", None, "2026-05-10", "calendar_date"),
        ("application_dose", "0.50", "L/ha", "2026-05-10", "calendar_date"),
        ("treated_area", "1.00", "ha", "2026-05-10", "calendar_date"),
        ("crop_name_or_eppo", "Authored wheat example", None, "2026-05-10", "calendar_date"),
        ("organic_production", "non", None, "2026-05-10", "calendar_date"),
    ]
    facts = [confirm(owner, owner.create("facts", fact_data(farm["id"], key=key, value=value, unit=unit, period=period, basis=basis)), "Explicitly read back the authored application declaration and its supplied unit.")
             for key, value, unit, period, basis in declarations]
    parcel_facts = [confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="parcel_crop_note", value="Authored wheat example", unit=None, period=None, basis="static"), "parcel_id": field_id}), "Checked this same crop description separately for this specific field.") for field_id in field_ids]
    facts.extend(parcel_facts)
    draft = owner.post("/reports", expected=201, json={"farm_id": farm["id"], "pack_id": pack["id"], "reporting_year": 2026,
        "fact_ids": [fact["id"] for fact in facts], "operation_ids": [reviewed_work["id"]], "selected_document_ids": [document["id"], notebook["id"]]}).json()
    issued = owner.post(f"/reports/{draft['id']}/approve", json={"expected_revision": draft["revision"]}).json()
    export = owner.get(f"/reports/{issued['id']}/download", params={"format": "json"}).json()
    dose = next(field for field in export["snapshot"]["fields"] if field["fact_key"] == "application_dose")
    assert Decimal(str(dose["value"])) == Decimal("0.50") and dose["unit"] == "L/ha"
    parcel_fields = [field for field in export["snapshot"]["fields"] if field["fact_key"] == "parcel_crop_note"]
    assert len(parcel_fields) == 2
    assert {field["physical_group_id"] for field in parcel_fields} == set(field_ids)
    assert {group["id"] for group in export["snapshot"]["physical_groups"]} >= set(field_ids)
    assert next(field for field in export["snapshot"]["fields"] if field["fact_key"] == "application_date")["period"] == "2026-05-10"
    assert export["filing_status"] == "not_filed"
    pdf = owner.get(f"/reports/{issued['id']}/download", params={"format": "pdf"})
    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(pdf.content)).pages)
    assert "0.50" in text and "L/ha" in text and ("FR" in text or "France" in text)
    receipt = owner.post(f"/reports/{issued['id']}/receipts", expected=201, json={"expected_revision": issued["revision"], "reference": "FICTIONAL-FR-MANUAL-REFERENCE", "date": "2026-10-16"}).json()
    assert receipt["data"]["authority_acceptance_verified"] is False

    # Two visits to the same field, and another field on the same date, are
    # three independent questions. A campaign year must not replace an event date.
    visits = [(field_ids[0], "2026-05-10", "North first visit"),
              (field_ids[0], "2026-06-11", "North second visit"),
              (field_ids[1], "2026-05-10", "South separate visit")]
    for field_id, period, value in visits:
        confirm(owner, owner.create("facts", {**fact_data(farm["id"], key="field_observation", value=value, unit=None, period=period, basis="calendar_date"), "parcel_id": field_id}))
    visit_request = owner.create("requests", {"farm_id": farm["id"], "title": "Authored per-visit evidence questions", "recipient": "Fictional adviser", "country": "FR", "reporting_year": 2026, "deadline": None, "pack_id": "farm-evidence", "requirements": [
        {"key": "field_observation", "label": "Work note", "temporal_basis": "calendar_date"},
        {"key": "treated_area_note", "label": "Area checked at this visit", "unit": "ha", "temporal_basis": "calendar_date"},
    ], "status": "draft"})
    grouped = owner.get("/workflow/questions", params={"request_id": visit_request["id"]}).json()
    assert not [question for question in grouped["questions"] if question["key"] == "field_observation"]
    missing = [question for question in grouped["questions"] if question["key"] == "treated_area_note"]
    assert {(question["parcel_id"], question["period"]) for question in missing} == {(field_id, period) for field_id, period, _ in visits}
    assert len({question["id"] for question in missing}) == 3
    assert all(len(question["id"]) == 64 and question["physical_label"] for question in missing)
    answer = {"request_id": visit_request["id"], "expected_request_revision": visit_request["revision"], "key": "treated_area_note", "value": "1.25", "unit": "ha", "temporal_basis": "calendar_date", "note": "Measured for this specific authored field visit.", "preview": True}
    owner.post("/workflow/answer", json=answer, expected=422)
    target = next(question for question in missing if question["parcel_id"] == field_ids[0] and question["period"] == "2026-06-11")
    selected_answer = {**answer, "question_id": target["id"], "parcel_id": target["parcel_id"], "period": target["period"]}
    owner.post("/workflow/answer", json={**selected_answer, "period": "2026"}, expected=422)
    owner.post("/workflow/answer", json={**selected_answer, "period": "2026-05-10"}, expected=422)
    owner.post("/workflow/answer", json={**selected_answer, "parcel_id": field_ids[1]}, expected=422)
    preview = owner.post("/workflow/answer", json=selected_answer).json()["check"]
    assert preview["can_save"] is True
    answered = owner.post("/workflow/answer", json={**selected_answer, "preview": False, "check_token": preview["check_token"], "acknowledged_codes": preview["requires_acknowledgement"]}).json()["record"]
    assert answered["data"]["period"] == "2026-06-11" and answered["data"]["parcel_id"] == field_ids[0]
    confirm(owner, answered)
    remaining = owner.get("/workflow/questions", params={"request_id": visit_request["id"]}).json()["questions"]
    assert {(question["parcel_id"], question["period"]) for question in remaining if question["key"] == "treated_area_note"} == {(field_ids[0], "2026-05-10"), (field_ids[1], "2026-05-10")}

    wrong_region = owner.create("farms", {**farm_data("Authored regional routing example"), "region": "Bayern"})
    rejected_region = owner.post("/reports", expected=422, json={"farm_id": wrong_region["id"], "pack_id": "de-inputs-2026", "reporting_year": 2026, "fact_ids": []}).json()
    assert rejected_region["error"]["code"] == "pack_region"
    right_region = owner.patch(f"/farms/{wrong_region['id']}", json={"expected_revision": wrong_region["revision"], "data": {"region": "Nordrhein-Westfalen"}}).json()
    region_draft = owner.post("/reports", expected=201, json={"farm_id": right_region["id"], "pack_id": "de-inputs-2026", "reporting_year": 2026, "fact_ids": []}).json()
    assert region_draft["data"]["status"] == "draft"
