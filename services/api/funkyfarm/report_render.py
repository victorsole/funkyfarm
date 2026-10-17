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
    return rows


def csv_bytes(snapshot):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\r\n")
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
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

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
    if snapshot.get("operations"):
        story.append(p("Selected farm activities", heading))
        rows = [[p("Activity and date"), p("Recorded work"), p("Field / crop")]]
        for operation in snapshot["operations"]:
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
