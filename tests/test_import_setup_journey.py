"""Automatic CSV setup suggests choices without changing the source or farm records."""

from conftest import farm_data


def test_automatic_csv_setup_keeps_literal_evidence_and_requires_mapping_and_row_review(farmers):
    owner = farmers("CSV setup reviewer")
    outsider = farmers("Separate CSV setup workspace")
    farm = owner.create("farms", farm_data("Spanish-heading import holding"))

    def upload(name, source, expected=201, **choices):
        return owner.post("/imports", expected=expected,
            files={"file": (name, source.encode("utf-8"), "text/csv")},
            data={"farm_id": farm["id"], "grain": "One original row from the farmer's file",
                  "delimiter": "auto", **choices}).json()

    source = (
        "record_id;Fecha;Descripción;Cantidad;Unidad;Importe;Moneda;Proveedor;Notas\r\n"
        "0007;15/06/2026;Semillas;0;kg;12,50;EUR;Cooperativa;NULL\r\n"
        "0008;16/06/2026;Pienso;2,50;kg;0;EUR;Cooperativa;\r\n"
    )
    imported = upload("records-es.csv", source)
    assert imported["data"]["delimiter"] == ";"
    assert all(column["target_field"] is None for column in imported["data"]["columns"])
    detail = owner.get(f"/imports/{imported['id']}").json()
    originals = [row["data"]["original_row"] for row in detail["rows"]["items"]]
    assert originals == [
        ["0007", "15/06/2026", "Semillas", "0", "kg", "12,50", "EUR", "Cooperativa", "NULL"],
        ["0008", "16/06/2026", "Pienso", "2,50", "kg", "0", "EUR", "Cooperativa", ""],
    ]
    setup = detail["setup_suggestions"]
    assert setup["target"] == "purchases" and setup["sampled_rows"] == 2
    suggested = {column["header"]: column for column in setup["columns"]}
    assert suggested["record_id"]["target_field"] == "external_id"
    assert suggested["record_id"]["value_type"] == "text"
    assert suggested["Fecha"]["target_field"] == "date"
    assert suggested["Fecha"]["date_format"] == "dmy"
    assert suggested["Cantidad"]["decimal_separator"] == ","
    assert suggested["Importe"]["decimal_separator"] == ","
    assert suggested["Proveedor"]["target_field"] == "supplier"
    assert all(column["null_tokens"] == [] for column in setup["columns"])
    outsider.get(f"/imports/{imported['id']}", expected=404)
    for kind in ("facts", "purchases", "sales", "operations"):
        assert owner.get(f"/{kind}").json()["total"] == 0

    # A human may replace the suggested purchase interpretation with farm facts.
    # The earlier invoice date and amount stay literal source details, not invented events.
    columns = [
        {"source_index": 0, "target_field": "key", "role": "identifier", "value_type": "text"},
        {"source_index": 1, "target_field": "source.original_date", "value_type": "text"},
        {"source_index": 2, "target_field": "label", "value_type": "text"},
        {"source_index": 3, "target_field": "value", "value_type": "number", "decimal_separator": ","},
        {"source_index": 4, "target_field": "unit", "value_type": "text"},
        {"source_index": 5, "target_field": "source.original_amount", "value_type": "text"},
        {"source_index": 6, "target_field": "source.currency", "value_type": "text"},
        {"source_index": 7, "target_field": "source.supplier", "value_type": "text"},
        {"source_index": 8, "target_field": "notes", "value_type": "text"},
    ]
    mapped = owner.post(f"/imports/{imported['id']}/mapping", json={
        "expected_revision": imported["revision"], "target": "facts", "columns": columns,
        "defaults": {"farm_id": farm["id"], "period": "2026",
                     "temporal_basis": "campaign_year"},
    }).json()
    reviewed_detail = owner.get(f"/imports/{imported['id']}").json()
    assert reviewed_detail["setup_suggestions"] is None
    assert reviewed_detail["data"]["target"] == "facts"
    assert reviewed_detail["data"]["columns"][0]["target_field"] == "key"
    preview = owner.get(f"/imports/{imported['id']}/preview").json()
    assert [item["normalized_data"]["value"] for item in preview["items"]] == [0, 2.5]
    assert [item["normalized_data"]["notes"] for item in preview["items"]] == ["NULL", ""]
    assert all(item["can_save"] for item in preview["items"])
    assert owner.get("/facts").json()["total"] == 0, "Setup and preview must not save facts."
    saved = owner.post(f"/imports/{imported['id']}/rows/review", json={
        "expected_revision": mapped["revision"],
        "note": "Checked the farmer's chosen year, original identifiers, units and comma decimals.",
        "rows": [{"row_number": item["row"]["data"]["row_number"],
                  "expected_revision": item["row"]["revision"], "preview_token": item["preview_token"],
                  "acknowledged_issues": item["requires_acknowledgement"]} for item in preview["items"]],
    }).json()
    assert saved["saved_count"] == 2 and saved["failed_count"] == 0
    assert owner.get("/facts").json()["total"] == 2
    for item, expected_id in zip(saved["items"], ("0007", "0008")):
        fact = item["record"]
        assert fact["data"]["review_status"] == "proposed"
        assert fact["data"]["key"] == expected_id
        evidence = next(part for part in fact["data"]["sources"] if part.get("kind") == "source_dataset")
        assert evidence["currency"] == "EUR"
        assert "date" not in fact["data"]
    assert [row["data"]["original_row"] for row in owner.get(f"/imports/{imported['id']}/rows").json()["items"]] == originals

    ambiguous = upload("date-order.csv",
        "Fecha;Cantidad;Descripción;Proveedor;Importe;Moneda\n"
        "01/02/2026;0;Semillas;Cooperativa;1,234;EUR\n")
    ambiguous_detail = owner.get(f"/imports/{ambiguous['id']}").json()
    uncertain = {column["header"]: column for column in ambiguous_detail["setup_suggestions"]["columns"]}
    assert uncertain["Fecha"]["date_format"] is None, "Do not choose between 1 February and 2 January."
    assert uncertain["Importe"]["decimal_separator"] is None, "Do not guess decimal versus thousands."
    manual_columns = [{key: value for key, value in column.items() if key != "header"}
                      for column in ambiguous_detail["setup_suggestions"]["columns"]]
    for column in manual_columns:
        column["date_format"] = "dmy" if column["target_field"] == "date" else "iso"
        column["decimal_separator"] = "," if column["target_field"] == "amount" else "."
    owner.post(f"/imports/{ambiguous['id']}/mapping", json={
        "expected_revision": ambiguous["revision"], "target": "purchases", "columns": manual_columns,
        "defaults": {"farm_id": farm["id"], "unit": "kg", "period": "2026-02-01",
                     "temporal_basis": "calendar_date"},
    })
    chosen = owner.get(f"/imports/{ambiguous['id']}/preview").json()["items"][0]
    assert chosen["can_save"]
    assert chosen["normalized_data"]["date"] == "2026-02-01"
    assert chosen["normalized_data"]["amount"] == 1.234
    assert {"date_format_conversion", "decimal_comma_conversion"}.issubset(chosen["requires_acknowledgement"])
    assert owner.get("/purchases").json()["total"] == 0, "An explicitly chosen format is still not a reviewed row."

    before = owner.get("/imports").json()["total"]
    # Both separators produce consistent rows and at least two recognized headings.
    failed = upload("two-separators.csv",
        "Date,Description;Quantity;Unit;Notes,Amount\n2026-06-15,seeds;2;kg;note,12.50\n", expected=422)
    assert failed["error"]["code"] == "delimiter_ambiguous"
    # Detection samples twenty complete rows; parsing must still reject a bad later row atomically.
    malformed = "Date;Description\n" + "2026-06-15;seeds\n" * 20 + '2026-06-16;"unfinished\n'
    failed = upload("broken-later-row.csv", malformed, expected=422)
    assert failed["error"]["code"] == "invalid_csv"
    assert owner.get("/imports").json()["total"] == before
    assert owner.get("/facts").json()["total"] == 2
    for kind in ("purchases", "sales", "operations"):
        assert owner.get(f"/{kind}").json()["total"] == 0
