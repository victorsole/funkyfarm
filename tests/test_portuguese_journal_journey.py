"""One fictional Portuguese literal journal through public farm-private HTTP.

Oracles are the retained DGAV workbook's A:M columns and the independently
agreed implementation/delivery contracts, not a production journal builder.
No assertion establishes applicability, product approval or authority filing.
"""

from copy import deepcopy
import csv
from hashlib import sha256
from io import BytesIO, StringIO
import json
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx
from pypdf import PdfReader

from conftest import confirm, fact_data, farm_data, human_browser
from test_guided_cases_journey import call, upload


PACK = "pt-ppp-surface-journal"
SCHEMA = "pt-ppp-surface-v1"
KEY = "pt.ppp.surface_journal"
SOURCE_SHA = "34ebb9d9d933cab566cf2084a6592ade06aa80821e363b7a428969c9f19dd2f3"
# Literal order and whitespace are taken from A4:M4, not pack metadata.
COLUMNS = [
    ("application_date_time_text", "Data (e hora de início, se aplicável)"),
    ("location_text", "Localização "),
    ("use_crop_oepp_text", "Tipo de utilização/cultura (código OEPP)"),
    ("bbch_text", "Estado fenológico (BBCH)"),
    ("target_text", "Inimigo "),
    ("treated_area_text", "Área tratada\n(ha ou m2)"),
    ("applicator_number_text", "N.º de aplicador"),
    ("product_name_text", "Nome"),
    ("product_authorisation_text", "Número de autorização"),
    ("seller_establishment_text", " Estabelecimento de venda "),
    ("seller_activity_authorisation_text", "N.º de autorização de exercício de atividade"),
    ("quantity_or_dose_text", "Quant. de produto aplicado (kg ou L) ou dose (kg ou L/ha ou m²)"),
    ("mixture_volume_text", "Volume de calda  (L)"),
]


def test_portuguese_partial_literal_journal_explicit_order_and_immutable_exports(farmers, service_url, tmp_path):
    owner, outsider, adviser = (farmers(name) for name in (
        "Portuguese literal journal keeper", "Unrelated source reader", "Read-only Portuguese adviser"))
    farm = owner.create("farms", {**farm_data("Fictional Portuguese holding"), "country": "PT", "region": None})
    other = owner.create("farms", {**farm_data("Different Portuguese holding"), "country": "PT", "region": None})
    non_pt = owner.create("farms", {**farm_data("Not a Portuguese holding"), "country": "DE", "region": None})
    private_marker = "PRIVATE-UNSELECTED-PT-NOTE-" + uuid4().hex
    document = upload(owner, farm["id"], "fictional-literal-notebook.txt", private_marker + "\nAuthored notebook, not an official record.\n")
    sources = [{"document_id": document["id"], "document_revision": document["revision"]}]
    partial_cells = {key: None for key, _ in COLUMNS}
    partial_cells.update(application_date_time_text="01/02/?? 07h — original undecided text",
                         location_text="  Talhão São João — 00001  ", bbch_text="", mixture_volume_text="0")
    partial = {"schema_id": SCHEMA, "identity_text": None, "observations_text": "",
        "entries": [{"entry_id": str(uuid4()), "cells": partial_cells, "actual_date": None, "date_confirmed": False}]}
    body = {"kind": "facts", "data": fact_data(farm["id"], key=KEY, value=partial,
        unit=None, period=None, basis="static", sources=sources)}
    checked = owner.post("/workflow/check", json=body).json()
    assert checked["can_save"], checked["issues"]
    saved = owner.post("/workflow/capture", expected=201, json={**body, "check_token": checked["check_token"],
        "acknowledged_codes": checked["requires_acknowledgement"]}).json()["record"]
    assert saved["data"]["review_status"] == "proposed"
    reopened = owner.get(f"/facts/{saved['id']}").json()
    assert reopened["data"]["value"] == partial
    assert reopened["data"]["period"] is None and reopened["data"]["temporal_basis"] == "static"
    assert reopened["data"]["sources"] == sources
    assert owner.get("/operations", params={"farm_id": farm["id"]}).json()["total"] == 0
    outsider.get(f"/facts/{saved['id']}", expected=404)

    # Repeated same-day rows are independent literal entries, not deduplicated
    # operations. Quantities, dose grammar and precision are not normalised.
    entries = []
    for index in range(17):
        cells = {key: None for key, _ in COLUMNS}
        cells.update(application_date_time_text="15/06/26 às 07h00 — raw A unchanged",
            location_text=f"  Linha {index + 1:02d} — São João  ", use_crop_oepp_text="OLIVE / código não verificado",
            bbch_text="00–09", target_text="", treated_area_text="001,2500 m2",
            applicator_number_text="000007", product_name_text=f"Fictional product {index + 1:02d}",
            product_authorisation_text="=000012", seller_establishment_text="Loja Açores & Filhos",
            seller_activity_authorisation_text="+000045", quantity_or_dose_text="0,000500 L/ha ?",
            mixture_volume_text="0")
        if index == 0:
            cells["bbch_text"] = None
            cells["seller_activity_authorisation_text"] = "@000045"
        entries.append({"entry_id": str(uuid4()), "cells": cells, "actual_date": "2026-06-15", "date_confirmed": True})
    undated = deepcopy(partial["entries"][0])
    other_year = deepcopy(entries[0]); other_year.update(entry_id=str(uuid4()), actual_date="2025-06-15")
    identity = "  Produtor fictício João & Filhos — 000012  "
    observations = "OBS-GLOBAL-ONCE: mistura/quantidade por confirmar; nenhum total inferido."
    value = {"schema_id": SCHEMA, "identity_text": identity, "observations_text": observations,
             "entries": [*entries, undated, other_year]}
    saved = owner.patch(f"/facts/{saved['id']}", json={"expected_revision": saved["revision"], "data": {"value": value}}).json()
    assert saved["data"]["value"] == value and saved["data"]["review_status"] == "proposed"
    ordered_ids = [entry["entry_id"] for entry in reversed(entries)]

    def report_body(source, **changes):
        return {"farm_id": farm["id"], "pack_id": PACK, "reporting_year": 2026,
            "fact_ids": [source["id"]], "selected_document_ids": [],
            "manual_journal_selection": {"source_fact_id": source["id"], "source_fact_revision": source["revision"],
                "entry_ids": ordered_ids, "acknowledged_unresolved": True}, **changes}

    letter = upload(owner, farm["id"], "fictional-portuguese-request.txt",
        "FICTIONAL REQUEST\nPlease provide the selected surface journal and a separate explanation of the requested follow-up.\n")
    requested_key = "requested_followup_note"
    linked_request = owner.create("requests", {"farm_id": farm["id"], "title": "Fictional actual saved Portuguese letter",
        "recipient": "Fictional named record reviewer", "country": "PT", "region": None,
        "reporting_year": 2026, "deadline": None, "pack_id": PACK, "status": "draft", "document_id": letter["id"],
        "requirements": [{"key": requested_key, "label": "Requested follow-up explanation", "required": True,
                          "temporal_basis": "static", "unit": None}]})
    questions = owner.get("/workflow/questions", params={"request_id": linked_request["id"]}).json()
    journal_question = next(item for item in questions["questions"] if item["key"] == KEY)
    assert journal_question["capture_kind"] == "manual_journal" and journal_question["value_type"] == "object"
    destination = urlsplit(journal_question["completion_url"])
    assert destination.path == "/app/record-work" and destination.fragment == "portuguese-journal"
    assert parse_qs(destination.query) == {"farm_id": [farm["id"]], "pt_journal_request": [linked_request["id"]]}
    refused_scalar_answer = owner.post("/workflow/answer", expected=422, json={"request_id": linked_request["id"],
        "expected_request_revision": linked_request["revision"], "question_id": journal_question["id"], "key": KEY,
        "value": partial, "unit": None, "temporal_basis": "static", "period": None,
        "note": "This structured journal must use its own explicit row and date review.", "preview": False}).json()
    assert refused_scalar_answer["error"]["code"] == "journal_editor_required"
    assert refused_scalar_answer["error"]["details"]["fix_url"] == journal_question["completion_url"]
    owner.post("/reports", expected=422, json=report_body(saved))
    saved = confirm(owner, saved, "Compared every literal source cell and separately supplied dates; missing cells remain unknown, not legally certified.")
    assert saved["data"]["value"] == value and saved["data"]["sources"] == sources
    # Exact fact-key filtering must happen before pagination, not in a client
    # that can miss the journal behind unrelated records.
    owner.create("facts", fact_data(farm["id"], key="unrelated_note", value="Not the journal", unit=None, basis="static", period=None))
    listed = owner.get("/facts", params={"farm_id": farm["id"], "fact_key": KEY, "limit": 1, "offset": 0}).json()
    assert listed["total"] == 1 and [item["id"] for item in listed["items"]] == [saved["id"]]

    selection = report_body(saved)["manual_journal_selection"]
    for change, status in (({"entry_ids": [undated["entry_id"]]}, 422),
                           ({"entry_ids": [other_year["entry_id"]]}, 422),
                           ({"source_fact_revision": saved["revision"] - 1}, 409),
                           ({"acknowledged_unresolved": False}, 422),
                           ({"acknowledged_unresolved": "true"}, 422),
                           ({"entry_ids": [ordered_ids[0], ordered_ids[0]]}, 422),
                           ({"entry_ids": [str(uuid4())]}, 422)):
        owner.post("/reports", expected=status, json={**report_body(saved), "manual_journal_selection": {**selection, **change}})
    owner.post("/reports", expected=422, json=report_body(saved, fact_ids=[]))
    owner.post("/reports", expected=422, json=report_body(saved, farm_id=other["id"]))
    owner.post("/reports", expected=422, json=report_body(saved, farm_id=non_pt["id"]))
    owner.post("/reports", expected=422, json=report_body(saved, reporting_year=2025))
    assert owner.get(f"/facts/{saved['id']}").json()["data"]["value"] == value
    assert owner.get("/reports").json()["total"] == 0, "Rejected selections must not leave prepared report records."

    invitation = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser",
        "farm_ids": [farm["id"]], "permissions": ["read"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": invitation["token"]})
    shared = {"X-Workspace-ID": owner.workspace_id}
    adviser.get(f"/facts/{saved['id']}", headers=shared)
    adviser.get(f"/farms/{other['id']}", headers=shared, expected=404)

    packs = owner.get("/packs").json()["items"]
    pack = next(item for item in packs if item["id"] == PACK)
    assert pack["country"] == "PT" and pack["reporting_year"] is None
    assert pack["capability"] == "manual_preparation" and pack["authority_ready"] is False
    assert [(column["key"], column["label"]) for column in pack["manual_schema"]["columns"]] == COLUMNS
    draft = owner.post("/reports", expected=201, json=report_body(saved)).json()
    assert draft["data"]["status"] == "draft" and draft["data"]["approval"] is None
    snapshot = draft["data"]["snapshot"]
    assert snapshot["operations"] == [] and snapshot["evidence"] == []
    journal, = snapshot["journals"]
    assert journal["schema_id"] == SCHEMA and journal["country"] == "PT" and journal["reporting_year"] == 2026
    assert journal["source"]["sha256"].lower() == SOURCE_SHA
    assert journal["source"]["sheet"] == "Tratamento de superfícies"
    assert [(column["key"], column["label"]) for column in journal["columns"]] == COLUMNS
    assert journal["holder"] == {"fact_id": saved["id"], "fact_revision": saved["revision"], "value": identity}
    assert journal["observations_text"] == observations and journal["selection"] == selection
    assert journal["source_fact_hash"] == sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert [entry["entry_id"] for entry in journal["entries"]] == ordered_ids
    assert [entry["entry_id"] for entry in snapshot["facts"][0]["data"]["value"]["entries"]] == ordered_ids
    originals = {entry["entry_id"]: entry for entry in entries}
    for entry in journal["entries"]:
        assert entry["values"] == originals[entry["entry_id"]]["cells"]
        assert entry["actual_date"] == "2026-06-15" and entry["source_fact_revision"] == saved["revision"]
        assert "operation_id" not in entry
    assert [(entry["entry_id"], entry["reason"]) for entry in journal["excluded_entries"]] == [
        (undated["entry_id"], "date_missing"), (other_year["entry_id"], "different_year")]
    assert all(issue["severity"] != "error" for issue in journal["issues"])
    assert not any(str(issue["code"]).startswith("cz_") for issue in snapshot.get("warnings", []))
    assert "not an authority" in journal["capability_notice"].lower()
    # A source pin validates the journal, but is not consent to export its file.
    assert private_marker not in json.dumps(snapshot, ensure_ascii=False)

    def read_binding(report):
        return owner.get(f"/reports/{report['id']}", params={"view": "review"}).json()["data"]

    def approval(report, binding):
        return {"expected_revision": report["revision"], "snapshot_checksum": binding["snapshot_checksum"],
                "check_fingerprint": binding["check_fingerprint"]}

    review = read_binding(draft)
    assert review["can_approve"] is True
    binding = review["review"]
    fields, offset = [], 0
    while True:
        page = owner.get(f"/reports/{draft['id']}/review", params={"section": "fields", "offset": offset, "limit": 5,
            "expected_revision": draft["revision"], "snapshot_checksum": binding["snapshot_checksum"],
            "check_fingerprint": binding["check_fingerprint"]}).json()
        fields.extend(page["items"])
        if page["next_offset"] is None:
            assert len(fields) == page["total"]
            break
        assert page["next_offset"] > offset
        offset = page["next_offset"]
    manual_fields = [field for field in fields if field.get("journal_schema") == SCHEMA]
    assert len(manual_fields) == 2 + 17 * 13
    assert [field["value"] for field in manual_fields[:2]] == [identity, observations]
    context = manual_fields[0]["journal_context"]
    assert manual_fields[0]["manual_journal_role"] == "identity"
    assert context["schema_id"] == SCHEMA and context["reporting_year"] == 2026
    assert context["source"]["sha256"].lower() == SOURCE_SHA
    assert context["source"] == {key: journal["source"][key] for key in ("title", "url", "page_url", "edition", "sha256")}
    assert context["source_fact_id"] == saved["id"] and context["source_fact_revision"] == saved["revision"]
    assert context["source_fact_hash"] == journal["source_fact_hash"]
    assert context["selection"] == {"entry_ids": ordered_ids, "acknowledged_unresolved": True}
    assert context["excluded_entries"] == journal["excluded_entries"]
    assert all(set(entry) == {"entry_id", "actual_date", "reason"} for entry in context["excluded_entries"])
    assert context["capability_notice"] == journal["capability_notice"]
    assert document["id"] not in json.dumps(context), "Private validation files must not become outward journal context."
    for position, entry_id in enumerate(ordered_ids):
        row = manual_fields[2 + position * 13:2 + (position + 1) * 13]
        assert [field["value"] for field in row] == [originals[entry_id]["cells"][key] for key, _ in COLUMNS]
        assert all(field["entry_id"] == entry_id and field["actual_date"] == "2026-06-15" for field in row)
    adviser.post(f"/reports/{draft['id']}/approve", headers=shared, expected=403, json=approval(draft, binding))
    outsider.get(f"/reports/{draft['id']}", expected=404)
    issued = owner.post(f"/reports/{draft['id']}/approve", json=approval(draft, binding)).json()
    assert issued["data"]["status"] == "issued" and issued["data"]["filing_status"] == "not_filed"
    exports = {}
    for fmt in ("json", "csv", "pdf"):
        response = owner.get(f"/reports/{issued['id']}/download", params={"format": fmt})
        assert "no-store" in response.headers["cache-control"]
        exports[fmt] = response.content
        outsider.get(f"/reports/{issued['id']}/download", params={"format": fmt}, expected=404)
    (tmp_path / "portuguese-journal.pdf").write_bytes(exports["pdf"])
    assert json.loads(exports["json"])["snapshot"] == snapshot

    # Parse CSV as CSV, not by comma/newline splitting. Each derivative block
    # has the literal A:M order; metadata never becomes an eighteenth row.
    rows = list(csv.reader(StringIO(exports["csv"].decode("utf-8-sig"), newline="")))
    header = [label for _, label in COLUMNS]
    positions = [index for index, row in enumerate(rows) if row == header]
    assert len(positions) == 2
    output_rows = rows[positions[0] + 1:positions[0] + 17] + rows[positions[1] + 1:positions[1] + 2]
    assert len(output_rows) == 17 and all(len(row) == 13 for row in output_rows)
    for csv_row, entry_id in zip(output_rows, ordered_ids):
        raw = originals[entry_id]["cells"]
        assert csv_row[0] == raw["application_date_time_text"] and csv_row[1] == raw["location_text"]
        assert csv_row[5] == "001,2500 m2" and csv_row[6] == "000007"
        assert csv_row[8] == "'=000012"
        assert csv_row[10] == ("'@000045" if raw["seller_activity_authorisation_text"].startswith("@") else "'+000045")
        assert csv_row[11:] == ["0,000500 L/ha ?", "0"]
    assert [row for row in rows if row and row[0] == "16-entry block"] == [["16-entry block", "1"], ["16-entry block", "2"]]
    assert [row for row in rows if row and row[0] == "Nome do produtor/empresa ou entidade autorizada:"] == [["Nome do produtor/empresa ou entidade autorizada:", identity]] * 2
    assert [row for row in rows if row and row[0] == "Obs. — whole document"] == [["Obs. — whole document", observations]]
    state_rows = [row for row in rows if row and row[0] == "Row cell-state map"]
    state = json.loads(next(row[2] for row in state_rows if row[1] == entries[0]["entry_id"]))
    assert "bbch_text" in state["null_columns"] and "target_text" in state["empty_columns"]
    assert {"product_authorisation_text", "seller_activity_authorisation_text"} <= set(state["protected_columns"])
    # Text extraction may represent layout wraps and nonbreaking spaces
    # differently; normalise whitespace only, never source numbers or cells.
    pdf = " ".join("\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(exports["pdf"])).pages).split())
    assert "16-entry block 1" in pdf and "16-entry block 2" in pdf
    assert pdf.count(observations) == 1 and SOURCE_SHA in pdf
    assert pdf.index("Fictional product 17") < pdf.index("Fictional product 01")
    assert "0,000500 L/ha ?" in pdf and "001,2500 m2" in pdf
    assert private_marker not in pdf and private_marker not in exports["csv"].decode("utf-8-sig")

    # A real saved letter can ask for more than the journal. Its extra answer
    # and attachment are independent selections, not the journal's private pin.
    attachment = upload(owner, farm["id"], "fictional-requested-followup.txt",
        "FICTIONAL FOLLOW-UP ATTACHMENT\nThe farmer supplied this separate record for the recipient's requested explanation.\n")
    extra = confirm(owner, owner.create("facts", fact_data(farm["id"], key=requested_key,
        value="Explicitly checked fictional follow-up explanation", unit=None, period=None, basis="static",
        sources=[{"document_id": attachment["id"], "document_revision": attachment["revision"]}])))
    incomplete_linked = owner.post("/reports", expected=201, json=report_body(saved,
        request_id=linked_request["id"], selected_document_ids=[attachment["id"]])).json()
    assert any(issue["code"] == "missing_requirement" and issue.get("field") == requested_key
               for issue in incomplete_linked["data"]["blockers"])
    assert read_binding(incomplete_linked)["can_approve"] is False
    owner.post(f"/reports/{incomplete_linked['id']}/approve", expected=409,
               json=approval(incomplete_linked, read_binding(incomplete_linked)["review"]))
    linked = owner.post("/reports", expected=201, json=report_body(saved, request_id=linked_request["id"],
        fact_ids=[saved["id"], extra["id"]], selected_document_ids=[attachment["id"]])).json()
    linked_snapshot = linked["data"]["snapshot"]
    assert linked["data"]["request_id"] == linked_request["id"] and linked_snapshot["request"]["id"] == linked_request["id"]
    assert any(field.get("fact_id") == extra["id"] and field.get("fact_key") == requested_key
               and field["value"] == extra["data"]["value"] for field in linked_snapshot["fields"])
    assert [item["id"] for item in linked_snapshot["evidence"]] == [attachment["id"]]
    assert document["id"] not in json.dumps(linked_snapshot) and letter["id"] not in [item["id"] for item in linked_snapshot["evidence"]]
    linked_review = read_binding(linked)
    assert linked_review["can_approve"] is True
    linked_issued = owner.post(f"/reports/{linked['id']}/approve", json=approval(linked, linked_review["review"])).json()
    assert linked_issued["data"]["status"] == "issued" and linked_issued["data"]["filing_status"] == "not_filed"

    # A named recipient receives the selected issued rows, not the private
    # full-source dependency or unselected draft cells behind their hash.
    share = owner.post("/shares", expected=201, json={"report_id": issued["id"],
        "recipient_email": outsider.email, "expires_in_days": 1}).json()
    shared_path = "/shares/access/" + share["token"]
    shared = outsider.get(shared_path)
    assert shared.json()["report"]["data"]["snapshot"] == snapshot and shared.json()["documents"] == []
    shared_json = outsider.get(shared_path + "/download", params={"format": "json"})
    assert shared_json.content == exports["json"]
    for outward in (shared.text, shared_json.text):
        assert "validation_sources" not in outward and document["id"] not in outward
        assert private_marker not in outward and partial_cells["application_date_time_text"] not in outward
    adviser.get(shared_path, expected=404)
    outsider.get(shared_path + f"/documents/{document['id']}/download", expected=404)
    owner.post(f"/shares/{share['share']['id']}/revoke")
    outsider.get(shared_path, expected=404)

    with human_browser(owner, service_url) as browser:
        credential = call(browser, "POST", "/assistant/credentials", expected=201, json={"name": "PT read-only tool boundary",
            "farm_ids": [farm["id"]], "permissions": ["read", "propose"], "expires_in_days": 1})
        with httpx.Client(base_url=service_url + "/", headers={"Authorization": "Bearer " + credential["token"]}, timeout=30) as agent:
            call(agent, "GET", "/assistant/tools")
            fact_count = owner.get("/facts", params={"farm_id": farm["id"]}).json()["total"]
            report_count = owner.get("/reports", params={"farm_id": farm["id"]}).json()["total"]
            arguments = {"farm_id": farm["id"], "expected_farm_revision": farm["revision"],
                "kind": "facts", "data": deepcopy(body["data"])}
            assistant_check = call(agent, "POST", "/assistant/execute/check_capture", json={"arguments": arguments})
            assert assistant_check["can_save"] is True
            staged = call(agent, "POST", "/assistant/execute/propose_capture", json={"arguments": arguments})
            assert staged["status"] == "requires_human_review"
            staged_details = call(browser, "GET", f"/assistant/approvals/{staged['approval_id']}")
            assert staged_details["payload"]["data"]["value"] == partial
            assert staged_details["payload"]["data"]["review_status"] == "proposed"
            # An assistant may retain literal drafts, but cannot supply the
            # human's actual-date confirmation, even through a check tool.
            claimed_human_date = deepcopy(arguments)
            claimed_human_date["data"]["value"]["entries"][0].update(actual_date="2026-06-15", date_confirmed=True)
            for tool in ("check_capture", "propose_capture"):
                denied_date = call(agent, "POST", "/assistant/execute/" + tool, expected=422,
                                   json={"arguments": claimed_human_date})
                assert denied_date["error"]["code"] == "human_date_review_required"
            denied = call(agent, "POST", "/reports", expected=403, json=report_body(saved))
            assert denied["error"]["code"] == "assistant_scope_denied"
            assert owner.get("/facts", params={"farm_id": farm["id"]}).json()["total"] == fact_count
            assert owner.get("/reports", params={"farm_id": farm["id"]}).json()["total"] == report_count

    # A confirmed successor changes the live source, not the issued snapshot.
    # Confirmation remains separate from proposing the literal correction.
    old_pending = owner.post("/reports", expected=201, json=report_body(saved)).json()
    old_binding = read_binding(old_pending)["review"]
    changed_value = deepcopy(value)
    changed_value["observations_text"] = "Explicitly corrected global observation; original report remains retained."
    successor = owner.create("facts", {**fact_data(farm["id"], key=KEY, value=changed_value,
        unit=None, period=None, basis="static", sources=sources), "supersedes_id": saved["id"]})
    assert successor["data"]["review_status"] == "proposed"
    assert owner.get(f"/facts/{saved['id']}").json()["data"]["review_status"] == "confirmed"
    successor = confirm(owner, successor, "Explicitly confirmed corrected document-wide observations against the still-current source.")
    assert read_binding(old_pending)["can_approve"] is False
    owner.post(f"/reports/{old_pending['id']}/approve", expected=409, json=approval(old_pending, old_binding))

    reissue_base = {"expected_revision": issued["revision"], "snapshot_checksum": issued["data"]["checksum"]}
    missing_selection = owner.post(f"/reports/{issued['id']}/reissue", expected=409, json=reissue_base).json()
    assert missing_selection["error"]["code"] == "pt_journal_source_changed"
    revised_selection = report_body(successor)["manual_journal_selection"]
    wrong_revision = owner.post(f"/reports/{issued['id']}/reissue", expected=409, json={**reissue_base,
        "fact_ids": [successor["id"]], "manual_journal_selection": {**revised_selection,
            "source_fact_revision": successor["revision"] + 1}}).json()
    assert wrong_revision["error"]["code"] == "pt_journal_source_changed"
    amendment = owner.post(f"/reports/{issued['id']}/reissue", expected=201, json={**reissue_base,
        "fact_ids": [successor["id"]], "manual_journal_selection": revised_selection}).json()
    assert amendment["id"] != issued["id"] and amendment["data"]["correction_of"] == issued["id"]
    assert amendment["data"]["status"] == "draft" and amendment["data"]["approval"] is None
    assert amendment["data"]["request_id"] is None and amendment["data"]["reporting_year"] == 2026
    amended_snapshot = amendment["data"]["snapshot"]
    assert amended_snapshot["request"] is None and amended_snapshot["reporting_year"] == 2026
    assert amended_snapshot["journals"][0]["selection"] == revised_selection
    assert amended_snapshot["journals"][0]["observations_text"] == changed_value["observations_text"]
    owner.post(f"/reports/{amendment['id']}/approve", expected=409, json=approval(amendment, binding))
    fresh_review = read_binding(amendment)
    assert fresh_review["can_approve"]
    amended_issued = owner.post(f"/reports/{amendment['id']}/approve", json=approval(amendment, fresh_review["review"])).json()
    assert amended_issued["data"]["status"] == "issued" and amended_issued["data"]["request_id"] is None

    # A preview cannot issue after its exact document source changes. A pinned
    # old citation is not silently upgraded when another preview is prepared.
    pending = owner.post("/reports", expected=201, json=report_body(successor)).json()
    prior_binding = read_binding(pending)["review"]
    owner.patch(f"/documents/{document['id']}", json={"expected_revision": document["revision"], "data": {"notes": "Notebook reread after preview."}})
    assert read_binding(pending)["can_approve"] is False
    owner.post(f"/reports/{pending['id']}/approve", expected=409, json=approval(pending, prior_binding))
    stale_source = owner.post("/reports", expected=409, json=report_body(successor)).json()
    assert stale_source["error"]["code"] == "pt_journal_source_changed"
    for fmt, content in exports.items():
        assert owner.get(f"/reports/{issued['id']}/download", params={"format": fmt}).content == content
    assert owner.get("/operations", params={"farm_id": farm["id"]}).json()["total"] == 0
    assert owner.get("/purchases", params={"farm_id": farm["id"]}).json()["total"] == 0
    assert owner.get(f"/facts/{saved['id']}").json()["data"]["value"] == value
