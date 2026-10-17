"""Deterministic exports of retained report snapshots; no live farm lookups."""

from __future__ import annotations

import csv
import io
import json
import os
import re
import threading
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape


def literal(value):
    """A reversible display of JSON values, including null, false and blanks."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def readable(value):
    if value is None:
        return "Not recorded"
    if value == "":
        return "Blank entry"
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, dict):
        return "; ".join(f"{str(key).replace('_', ' ')}: {readable(item)}" for key, item in value.items()) or "Empty record"
    if isinstance(value, list):
        return "; ".join(readable(item) for item in value) or "Empty list"
    return str(value)


def period_text(field):
    basis = field.get("temporal_basis")
    period = field.get("period")
    if basis == "static":
        return "Standing farm detail"
    if period is None or period == "":
        return "Period not recorded"
    if basis == "campaign_year":
        return f"Campaign year {period}"
    if basis == "calendar_date":
        return f"Recorded on {period}"
    return str(period)


def source_cells(field):
    """Read retained source-column definitions, not mutable country packs."""
    schema, value = field.get("row_schema"), field.get("value")
    if not schema or not isinstance(value, dict):
        return []
    columns = {column["key"]: column for column in schema["row_columns"]}
    keys = [key for key in columns if key in value] + [key for key in value if key not in columns]
    return [(key, columns.get(key, {}).get("label", "Additional source column"), value[key], columns.get(key, {}).get("unit")) for key in keys]


def journal_cells(journal, entry):
    """Original supplied numbers and units under the retained column definitions."""
    values = entry["values"]
    originals = entry.get("original_numbers", (entry.get("data", {}).get("cz_ppp") or {}).get("original_numbers", {}))
    for column in journal["columns"]:
        key = column["key"]
        value = originals[key] if key in originals else values.get(key)
        unit = values.get(column["unit_field"]) if column.get("unit_field") else column.get("unit")
        yield key, column["label"], value, unit


def journal_value(value):
    if isinstance(value, dict) and value.get("status") == "pending":
        return "Pending — follow-up not complete"
    if isinstance(value, dict) and value.get("status") == "not_applicable":
        return "Not applicable — explicitly recorded"
    if isinstance(value, dict) and value.get("status") == "recorded":
        return "Recorded: " + readable(value.get("date", value.get("value")))
    return readable(value)


def _pt_journal(journal):
    return journal.get("schema_id") == "pt-ppp-surface-v1"


def _pt_csv_rows(journal):
    """Document context is separate from the thirteen retained event cells."""
    source = journal["source"]
    yield ["Manual preparation only", journal["capability_notice"]]
    yield ["Retained source", literal(source)]
    yield ["Application selection year (not a source field)", journal["reporting_year"]]
    yield ["Cell encoding", "Literal supplied text. The cell-state map distinguishes unavailable null from supplied empty text and lists formula-safe protective apostrophes. The retained JSON contains unchanged original values."]
    identity = journal.get("holder", {}).get("value")
    observations = journal.get("observations_text")
    yield ["Document text state", literal({
        "identity": "null" if identity is None else "empty" if identity == "" else "supplied",
        "identity_protected": identity is not None and _pt_csv_dangerous(identity),
        "observations": "null" if observations is None else "empty" if observations == "" else "supplied",
        "observations_protected": observations is not None and _pt_csv_dangerous(observations),
    })]
    entries = journal["entries"]
    for start in range(0, len(entries), 16):
        yield []
        yield ["16-entry block", start // 16 + 1]
        yield ["Nome do produtor/empresa ou entidade autorizada:", identity]
        yield ["Retained column definitions", literal(journal["columns"])]
        for entry in entries[start:start + 16]:
            values = entry["values"]
            states = {"null_columns": [], "empty_columns": [], "protected_columns": []}
            for column in journal["columns"]:
                key = column["key"]
                value = values.get(key)
                if value is None:
                    states["null_columns"].append(key)
                elif value == "":
                    states["empty_columns"].append(key)
                elif _pt_csv_dangerous(value):
                    states["protected_columns"].append(key)
            yield ["Selected row context", entry["entry_id"], entry["actual_date"], entry["source_fact_id"], entry["source_fact_revision"]]
            yield ["Row cell-state map", entry["entry_id"], literal(states)]
        yield [column["label"] for column in journal["columns"]]
        for entry in entries[start:start + 16]:
            yield [entry["values"].get(column["key"]) for column in journal["columns"]]
    yield []
    yield ["Obs. — whole document", observations]
    if journal.get("excluded_entries"):
        yield ["Source rows not selected for this document", literal(journal["excluded_entries"])]


def _pt_csv_dangerous(value):
    text = str(value)
    return text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n"))


def export_rows(snapshot):
    rows = [["field", "label", "value_json", "unit_json", "period_json", "temporal_basis", "fact_id", "fact_revision", "availability"]]
    for field in snapshot.get("fields", []):
        rows.append([
            field["field"], field.get("label", field["field"]), literal(field.get("value")),
            literal(field.get("unit")), literal(field.get("period")), field.get("temporal_basis", ""),
            field.get("fact_id", ""), field.get("fact_revision", ""), "missing" if field.get("missing") else "recorded",
        ])
        for key, label, value, unit in source_cells(field):
            rows.append([
                f"{field['fact_key']}.{key}", f"{field.get('label', field['field'])}: {label} ({key})",
                literal(value), literal(unit), literal(field.get("period")), field.get("temporal_basis", ""),
                field.get("fact_id", ""), field.get("fact_revision", ""), "recorded",
            ])
    for operation in snapshot.get("operations", []):
        data = operation["data"]
        for key in ("title", "type", "date", "quantity", "parcel", "parcel_id", "physical_group_label", "crop", "product", "operator", "hours"):
            if key in data:
                rows.append([f"activity.{key}", f"{data.get('title', 'Farm activity')} — {key.replace('_', ' ')}", literal(data[key]), literal(data.get("unit") if key == "quantity" else None), literal(data.get("period", data.get("date"))), data.get("temporal_basis", "calendar_date" if data.get("date") else ""), operation["id"], operation["revision"], "recorded"])
    for journal in snapshot.get("journals", []):
        prefix = "journal." + journal["schema_id"]
        if _pt_journal(journal):
            for key in ("source", "columns", "capability_notice", "holder", "observations_text", "excluded_entries"):
                rows.append([f"{prefix}.{key}", f"{journal['title']} — {key}", literal(journal.get(key)), literal(None), literal(journal["reporting_year"]), "app_selection_year", "", "", "retained_context"])
            for entry in journal["entries"]:
                entry_prefix = f"{prefix}.{entry['entry_id']}"
                rows.append([entry_prefix, "Retained manually selected row and actual-date confirmation", literal(entry), literal(None), literal(entry["actual_date"]), "calendar_date", entry["source_fact_id"], entry["source_fact_revision"], "recorded"])
                for column in journal["columns"]:
                    key = column["key"]
                    rows.append([f"{entry_prefix}.{key}", column["label"], literal(entry["values"].get(key)), literal(column.get("unit")), literal(entry["actual_date"]), "calendar_date", entry["source_fact_id"], entry["source_fact_revision"], "recorded"])
            continue
        for key in ("source", "columns", "capability_notice", "holder"):
            rows.append([f"{prefix}.{key}", f"{journal['title']} — {key}", literal(journal.get(key)), literal(None), literal(journal["reporting_year"]), "campaign_year", "", "", "retained_context"])
        for entry in journal["entries"]:
            entry_prefix = f"{prefix}.{entry['operation_id']}"
            rows.append([entry_prefix, "Retained application and source context", literal(entry), literal(None), literal(entry["date"]), "calendar_date", entry["operation_id"], entry["operation_revision"], "recorded"])
            for key, label, value, unit in journal_cells(journal, entry):
                rows.append([f"{entry_prefix}.{key}", f"{label} ({key})", literal(value), literal(unit), literal(entry["date"]), "calendar_date", entry["operation_id"], entry["operation_revision"], "pending" if isinstance(value, dict) and value.get("status") == "pending" else "recorded"])
    return rows


def csv_bytes(snapshot):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
    pt_journals = [journal for journal in snapshot.get("journals", []) if _pt_journal(journal)]
    if pt_journals:
        for journal in pt_journals:
            for row in _pt_csv_rows(journal):
                # Guard context/header values too, rather than trusting a
                # retained source label. The cell-state map records protection.
                writer.writerow(["'" + str(value) if _pt_csv_dangerous(value) else value for value in row])
        return output.getvalue().encode("utf-8-sig")
    # Quote syntax alone does not prevent a spreadsheet interpreting a formula.
    for row in export_rows(snapshot):
        safe = []
        for index, value in enumerate(row):
            text = str(value)
            number_literal = index == 2 and re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?", text)
            dangerous = text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n"))
            safe.append("'" + text if dangerous and not number_literal else value)
        writer.writerow(safe)
    return output.getvalue().encode("utf-8-sig")


def xlsx_bytes(snapshot):
    """Minimal OOXML workbook with explicit string cells, never formulas."""
    def column(number):
        result = ""
        while number:
            number, rest = divmod(number - 1, 26)
            result = chr(65 + rest) + result
        return result

    def xml_text(value):
        text = str(value)
        # XML 1.0 cannot carry these code points; JSON value columns preserve them escaped.
        return escape("".join(c for c in text if c in "\t\n\r" or 32 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF))

    row_xml = []
    for index, row in enumerate(export_rows(snapshot), 1):
        cells = "".join(f'<c r="{column(col)}{index}" t="inlineStr"><is><t xml:space="preserve">{xml_text(value)}</t></is></c>' for col, value in enumerate(row, 1))
        row_xml.append(f'<row r="{index}">{cells}</row>')
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report facts" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="9" width="24" customWidth="1"/></cols><sheetData>' + "".join(row_xml) + '</sheetData></worksheet>',
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, content.encode("utf-8"))
    return output.getvalue()


_font_lock = threading.Lock()


def _unicode_font():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    with _font_lock:
        if "ReportUnicode" in pdfmetrics.getRegisteredFontNames():
            return "ReportUnicode"
        configured = os.environ.get("FUNKYFARM_REPORT_FONT")
        candidates = ([Path(configured)] if configured else []) + [
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
            Path("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"),
            Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts/arial.ttf",
            Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        ]
        for candidate in candidates:
            if candidate.is_file():
                pdfmetrics.registerFont(TTFont("ReportUnicode", str(candidate)))
                return "ReportUnicode"
    raise RuntimeError("Install a Unicode TrueType font or set FUNKYFARM_REPORT_FONT to its path.")


def pdf_bytes(report_id, snapshot, checksum, issued, approval=None):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_LEFT
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak

    output = io.BytesIO()
    font = _unicode_font()
    normal = ParagraphStyle("ReportBody", fontName=font, fontSize=10, leading=15, alignment=TA_LEFT, splitLongWords=True)
    title = ParagraphStyle("ReportTitle", parent=normal, fontSize=18, leading=23, spaceAfter=10)
    heading = ParagraphStyle("ReportSection", parent=normal, fontSize=12, leading=17, spaceBefore=15, spaceAfter=7)
    small = ParagraphStyle("ReportSmall", parent=normal, fontSize=8, leading=11, textColor=colors.HexColor("#526050"))

    def p(value, style=normal):
        return Paragraph(escape(str(value)).replace("\n", "<br/>"), style)

    pack = snapshot["pack"]
    farm_name = snapshot.get("farm", {}).get("name") or "Farm records"
    story = [p(pack.get("title", pack.get("name", "Farm report")), title), p(f"{farm_name} · {snapshot['reporting_year']}"), p("Approved report version" if issued else "Draft — review and approval required", heading), p(snapshot.get("capability_notice", "Prepared evidence; authority acceptance is recorded separately."))]
    version = pack.get("version")
    country = pack.get("country")
    story.append(p(" · ".join(item for item in (f"Country: {country}" if country else "General farm dossier", f"Format version: {version}" if version else None) if item), small))
    if approval and approval.get("at"):
        story.append(p(f"Review approved on {str(approval['at'])[:10]}.", small))
    if snapshot.get("correction_of"):
        story.append(p("Amendment to an earlier retained report. The earlier version remains in the report history.", small))
    if snapshot.get("request"):
        request = snapshot["request"]["data"]
        story.extend([p(f"Request: {request.get('title', '')}"), p(f"Recipient: {request.get('recipient', '')}"), Spacer(1, 8)])
    evidence_numbers = {document["id"]: index for index, document in enumerate(snapshot.get("evidence", []), 1)}
    groups = {}
    for field in snapshot.get("fields", []):
        if field.get("journal_schema") == "pt-ppp-surface-v1":
            # These reviewed cells appear under the retained PT definitions
            # below, including document observations exactly once.
            continue
        groups.setdefault(str(field.get("group_label") or "Farm facts"), []).append(field)

    def table(rows, widths):
        result = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT", splitInRow=1)
        result.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EFE7")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), .3, colors.HexColor("#CDD5CC")), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9)]))
        return result

    for group, group_fields in groups.items():
        story.append(p(group, heading))
        rows = [[p("Farm detail"), p("Recorded answer"), p("Period / evidence")]]
        for field in group_fields:
            if field.get("row_schema"):
                continue
            value = "Not available — no matching record" if field.get("missing") else readable(field.get("value"))
            if field.get("unit") not in (None, ""):
                value += f" {field['unit']}"
            references = sorted({evidence_numbers[source["document_id"]] for source in field.get("sources", []) if isinstance(source, dict) and source.get("document_id") in evidence_numbers})
            context = period_text(field)
            if references:
                context += "\nEvidence " + ", ".join(str(number) for number in references)
            rows.append([p(field.get("label", field["field"])), p(value), p(context, small)])
        if len(rows) > 1:
            story.append(table(rows, [165, 220, 128]))
        for field in group_fields:
            if not field.get("row_schema"):
                continue
            story.extend([p(field.get("label", field["field"]), heading), p(period_text(field), small)])
            for source in field.get("sources", []):
                if source.get("source_name") and source.get("row_number") is not None:
                    story.append(p(f"Source: {source['source_name']}, row {source['row_number']}", small))
            rows = [[p("Source column"), p("Original value"), p("Source unit")]]
            for key, label, value, unit in source_cells(field):
                # NULL, blank and zero remain distinct. Booleans, dates and
                # authority codes are printed as literal source text.
                rows.append([p(f"{label}\n{key}"), p("Empty source cell" if value == "" else value), p(unit or "Not specified", small)])
            story.append(table(rows, [230, 200, 83]))
    ordinary_operations = [operation for operation in snapshot.get("operations", []) if not operation.get("journal_entry")]
    if ordinary_operations:
        story.append(p("Selected farm activities", heading))
        rows = [[p("Activity and date"), p("Recorded work"), p("Field / crop")]]
        for operation in ordinary_operations:
            data = operation["data"]
            detail = []
            if "quantity" in data:
                detail.append(readable(data["quantity"]) + (f" {data['unit']}" if data.get("unit") not in (None, "") else ""))
            if "hours" in data:
                detail.append(f"{readable(data['hours'])} hours")
            if data.get("product"):
                detail.append(str(data["product"]))
            parcel_id = data.get("parcel_id", data.get("field_id"))
            parcel = data.get("physical_group_label") or next((item.get("name") for item in snapshot.get("physical_groups", []) if str(item.get("id")) == str(parcel_id)), data.get("parcel"))
            context = "\n".join(str(item) for item in (parcel, data.get("crop")) if item not in (None, "")) or "Whole farm"
            rows.append([p(f"{data.get('title') or str(data.get('type', 'Farm activity')).replace('_', ' ')}\n{data.get('date') or data.get('period') or 'Date not recorded'}"), p("\n".join(detail) or "Activity recorded"), p(context, small)])
        story.append(table(rows, [165, 220, 128]))
    for journal in snapshot.get("journals", []):
        if _pt_journal(journal):
            def pt_literal(value, style=normal):
                # Visible JSON literals distinguish null, blank, zero and raw
                # whitespace. Single spaces remain word-wrap opportunities;
                # repeated spaces keep their visible width without collapsing.
                text = re.sub(r" {2,}", lambda match: " " + "&#160;" * (len(match.group()) - 1), escape(literal(value)))
                return Paragraph(text, style)

            source = journal["source"]
            entries = journal["entries"]
            for start in range(0, len(entries), 16):
                if start:
                    story.append(PageBreak())
                block = start // 16 + 1
                story.extend([p(f"{journal['title']} — 16-entry block {block}", heading), p(journal["capability_notice"])])
                story.append(p(" · ".join(str(source[key]) for key in ("title", "edition") if source.get(key)), small))
                if source.get("url"):
                    story.append(p(source["url"], small))
                if source.get("sha256"):
                    story.append(p("Retained source SHA-256: " + source["sha256"], small))
                story.extend([p("Nome do produtor/empresa ou entidade autorizada:", heading), pt_literal(journal.get("holder", {}).get("value")), p("Literal answers below use JSON text: null is unavailable, \"\" is blank, and quoted strings retain the supplied text. The selection year is app metadata, not a printed source field.", small)])
                for index, entry in enumerate(entries[start:start + 16], start + 1):
                    story.extend([p(f"Selected row {index} · separately confirmed actual date {entry['actual_date']}", heading), p(f"Source row reference {entry['entry_id']} · source fact revision {entry['source_fact_revision']}", small)])
                    rows = [[p(f"Retained source column\nRow {index} · {entry['actual_date']}"), p("Literal supplied answer"), p("Printed unit")]]
                    for column in journal["columns"]:
                        rows.append([p(column["label"]), pt_literal(entry["values"].get(column["key"])), p(readable(column.get("unit")) if column.get("unit") is not None else "Not specified", small)])
                    story.append(table(rows, [230, 200, 83]))
                    for issue in entry.get("issues", []):
                        story.append(p(issue["message"], small))
            story.extend([p("Obs. — whole document", heading), pt_literal(journal.get("observations_text"))])
            if journal.get("excluded_entries"):
                story.append(p("Source rows not selected for this document", heading))
                for excluded in journal["excluded_entries"]:
                    story.append(p(readable(excluded), small))
            for issue in journal.get("issues", []):
                story.append(p(issue["message"], small))
            continue
        story.extend([p(journal["title"], heading), p(journal["capability_notice"])])
        source = journal["source"]
        story.append(p(" · ".join(str(source[key]) for key in ("title", "edition") if source.get(key)), small))
        if source.get("url"):
            story.append(p(source["url"], small))
        if source.get("sha256"):
            story.append(p("Retained source SHA-256: " + source["sha256"], small))
        holder = journal.get("holder")
        if holder:
            story.extend([p("Recorded holder", heading), p(readable(holder["value"])), p(f"Holder source fact {holder['fact_id']} · revision {holder['fact_revision']}", small)])
        for entry in journal["entries"]:
            story.extend([p(f"Application {entry['operation_id']} · {entry['date']}", heading), p(f"Retained operation revision {entry['operation_revision']}", small)])
            rows = [[p("Record column"), p("Retained original answer"), p("Supplied unit")]]
            for key, label, value, unit in journal_cells(journal, entry):
                rows.append([p(f"{label}\n{key}"), p(journal_value(value)), p(unit if unit not in (None, "") else "Not supplied", small)])
            story.append(table(rows, [230, 200, 83]))
            for issue in entry.get("issues", []):
                story.append(p(issue["message"], small))
        for issue in journal.get("issues", []):
            story.append(p(issue["message"], small))
    story.append(p("Selected supporting documents", heading))
    for number, document in enumerate(snapshot.get("evidence", []), 1):
        story.append(p(f"{number}. {document.get('name') or 'Supporting document'}"))
    if not snapshot.get("evidence"):
        story.append(p("No documents selected for this response."))
    sources = pack.get("sources", pack.get("official_sources", []))
    if sources:
        story.append(p("Format references", heading))
    for source in sources:
        if isinstance(source, dict):
            description = " · ".join(str(item) for item in (source.get("title"), source.get("edition")) if item)
            story.append(p(description or "Official reference", small))
            if source.get("url"):
                story.append(p(source["url"], small))
        else:
            story.append(p(source, small))
    story.extend([Spacer(1, 14), p("Keep this reviewed version with your delivery reference. Exporting a file does not send it to an authority or establish acceptance. Any authority decision is recorded separately.", small)])

    def footer(canvas, doc):
        canvas.setFont(font, 8)
        canvas.drawString(40, 25, f"Report reference {report_id[:8]} · {snapshot['reporting_year']} · Page {doc.page}")

    # DocTemplate passes its own invariant value to the canvas. Setting only
    # a canvas factory default is overridden and leaks download time into bytes.
    SimpleDocTemplate(output, pagesize=A4, leftMargin=40, rightMargin=40, topMargin=38, bottomMargin=42, invariant=1, title=pack.get("title", pack.get("name", "Farm report"))).build(story, onFirstPage=footer, onLaterPages=footer)
    return output.getvalue()
