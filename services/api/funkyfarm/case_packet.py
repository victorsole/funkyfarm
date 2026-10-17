"""A private folder of reviewed selections and their retained original files."""

import asyncio
from copy import deepcopy
import hashlib
from html import escape
import json
import stat
import tempfile
import threading
import time
from uuid import UUID
import zipfile

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask
from starlette.concurrency import run_in_threadpool

from .admin_cases import MAX_DEPENDENCIES, NOTICE, _case, _content, _current_review, _human
from .db import fetch_record, json_safe, transaction
from .documents import _claim_local_job, _open_original, _release_local_job
from .fields import render_proposal_export
from .models import ApiError
from .report_render import readable
from .reporting import _source_refs, digest, render_report_download
from .security import Session, require_session

router = APIRouter(prefix="/cases", tags=["prepared folders"])
MAX_PACKET_BYTES = 128 * 1024 * 1024
MAX_PACKET_FILES = 512
MAX_RENDER_SOURCE_BYTES = 8 * 1024 * 1024
MAX_RETAINED_INPUT_BYTES = 32 * 1024 * 1024
MAX_PREPARE_SECONDS = 90
SOURCE_KINDS = {"farms", "documents", "requests", "reports", "field_change_proposals",
    "facts", "operations", "purchases", "sales", "checklists", "tasks", "field_imports"}
JOB_NAMES = {"fields": "Field change", "correction": "Correction", "inspection": "Inspection"}
ROLE_NAMES = {"original": "Original record", "notice": "Letter or notice", "change": "Proposed change",
    "response": "Prepared answer", "evidence": "Supporting record"}
ITEM_NAMES = {"open": "Not finished", "in_progress": "In progress", "resolved": "Completed with supporting documents", "cancelled": "Set aside"}


def _unavailable():
    return ApiError(409, "packet_source_unavailable", "A reviewed record or original file is unavailable. Restore it or reopen and review a different selection. No incomplete folder was downloaded.")


def _retained(conn, pin, farm_id, *, historical):
    kind, identifier, revision = pin.get("kind"), pin.get("id"), pin.get("revision")
    if kind not in SOURCE_KINDS or type(revision) is not int or revision < 1:
        raise _unavailable()
    current = fetch_record(conn, kind, identifier)
    if (kind == "farms" and current["id"] != farm_id
            or kind != "farms" and current["data"].get("farm_id") != farm_id):
        raise _unavailable()
    if current["revision"] != revision:
        if not historical:
            raise ApiError(409, "packet_source_changed", "A reviewed record changed. Reopen and review the current case before downloading.")
        row = conn.execute("SELECT data FROM record_history WHERE record_id=%s AND kind=%s AND revision=%s",
            (UUID(current["id"]), kind, revision)).fetchone()
        if row is None:
            raise _unavailable()
        current = {**current, "revision": revision, "data": deepcopy(json_safe(row["data"]))}
    if kind != "farms" and current["data"].get("farm_id") != farm_id:
        raise _unavailable()
    if digest(current["data"]) != pin.get("checksum"):
        raise ApiError(409, "packet_source_integrity", "A retained record does not match its reviewed version. No folder was downloaded.")
    return current


def _selection(conn, case_id, revision, fingerprint, *, historical):
    item = _case(conn, case_id)
    event = None
    if historical:
        rows = conn.execute("SELECT id,data FROM records WHERE kind='admin_case_events' AND deleted_at IS NULL "
            "AND data->>'case_id'=%s AND data->>'farm_id'=%s AND data->>'action'='sent' "
            "AND data->'sealed_bundle'->>'case_revision'=%s ORDER BY id LIMIT 2",
            (item["id"], item["data"]["farm_id"], str(revision))).fetchall()
        if len(rows) != 1:
            raise ApiError(404, "packet_sent_version_missing", "This exact recorded sending was not found through your current access.")
        event = json_safe(rows[0])
        seal = event["data"].get("sealed_bundle") or {}
        content, review = deepcopy(seal.get("content") or {}), deepcopy(seal.get("review") or {})
        if seal.get("case_revision") != revision:
            raise _unavailable()
    else:
        if item["revision"] != revision or item["data"].get("status") != "ready_to_send":
            raise ApiError(409, "packet_case_changed", "This is no longer the reviewed current preparation. Reload the case and its downloads.")
        content, review = _content(item["data"]), deepcopy(item["data"].get("review") or {})
    if review.get("fingerprint") != fingerprint or review.get("content_hash") != digest(content):
        raise ApiError(409, "packet_review_changed", "This download does not match the reviewed selection. Reload the current handoff or exact sending history.")
    if content.get("farm_id") != item["data"]["farm_id"]:
        raise _unavailable()
    return {"case_id": item["id"], "case_revision": revision, "content": content, "review": review,
        "origin": "sealed_sent_bundle" if historical else "current_review", "event": event}


def _records(conn, selection, *, historical, check):
    pins = selection["review"].get("referenced_revisions") or []
    if not pins or len(pins) > MAX_DEPENDENCIES:
        raise _unavailable()
    farm_id = selection["content"]["farm_id"]
    total = 0
    # Inspect scalar sizes before loading the JSON bodies. This also budgets
    # private validation dependencies, not only the files eventually exported.
    for pin in pins:
        check()
        if pin.get("kind") not in SOURCE_KINDS or type(pin.get("revision")) is not int or pin["revision"] < 1:
            raise _unavailable()
        row = conn.execute("SELECT kind,revision,data->>'farm_id' AS farm_id, "
            "CASE WHEN revision=%s THEN octet_length(data::text) ELSE "
            "(SELECT octet_length(h.data::text) FROM record_history h WHERE h.record_id=records.id AND h.kind=records.kind AND h.revision=%s) END AS bytes "
            "FROM records WHERE kind=%s AND id=%s AND deleted_at IS NULL",
            (pin["revision"], pin["revision"], pin["kind"], UUID(pin["id"]))).fetchone()
        if row is None or row["bytes"] is None or pin["kind"] == "farms" and pin["id"] != farm_id or pin["kind"] != "farms" and row["farm_id"] != farm_id:
            raise _unavailable()
        if not historical and row["revision"] != pin["revision"]:
            raise ApiError(409, "packet_source_changed", "A reviewed record changed. Reopen and review the current case before downloading.")
        total += row["bytes"]
        if row["bytes"] > MAX_RENDER_SOURCE_BYTES or total > MAX_RETAINED_INPUT_BYTES:
            raise ApiError(413, "packet_sources_too_large", "These reviewed records are too large for one folder. Prepare smaller cases or download the individual files. Nothing was left out or sent.")
    records = {}
    for pin in pins:
        check()
        key = (pin.get("kind"), pin.get("id"))
        if key in records:
            raise _unavailable()
        records[key] = _retained(conn, pin, farm_id, historical=historical)
    if ("farms", farm_id) not in records:
        raise _unavailable()
    for ref in selection["content"].get("references", []):
        record = records.get((ref["kind"], ref["id"]))
        if record is None or record["revision"] != ref["revision"]:
            raise _unavailable()
    for item in selection["content"].get("items", []):
        for pin in item.get("document_pins", []):
            record = records.get(("documents", pin["id"]))
            if record is None or record["revision"] != pin["revision"]:
                raise _unavailable()
    return records


def _outward_documents(selection, records):
    """A private validation source is not permission to disclose its original."""
    content = selection["content"]
    identifiers = {ref["id"] for ref in content.get("references", []) if ref["kind"] == "documents"}
    identifiers.update(pin["id"] for item in content.get("items", []) for pin in item.get("document_pins", []))
    for reference in content.get("references", []):
        if reference["kind"] == "reports":
            report = records[("reports", reference["id"])]
            identifiers.update(document["id"] for document in report["data"]["snapshot"].get("evidence", []))
    if any(("documents", identifier) not in records for identifier in identifiers):
        raise ApiError(409, "packet_attachment_unavailable", "A selected report attachment is not available on this same farm. Link and review its original explicitly before preparing the folder. No attachment was silently left out.")
    return identifiers


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False).encode("utf-8")


def _title(record):
    data = record["data"]
    return str(data.get("title") or data.get("label") or data.get("name") or data.get("filename")
        or (data.get("snapshot", {}).get("pack", {}).get("title") if record["kind"] == "reports" else None)
        or (data.get("parcel", {}).get("name") if record["kind"] == "field_change_proposals" else None)
        or record["kind"].replace("_", " "))


def _record_text(record):
    # These are only explicitly selected, ordinary farm records, never a raw
    # collection export or an authentication/connection record.
    lines = [_title(record), "", f"Saved version: {record['revision']}", ""]
    for key, value in record["data"].items():
        if key not in {"farm_id", "review", "sources", "source_documents", "saved_records"}:
            lines.append(f"{key.replace('_', ' ').capitalize()}: {readable(value)}")
    return "\n".join(lines).encode("utf-8")


def _outward_record(record, documents, selected):
    result = {key: deepcopy(record[key]) for key in ("id", "kind", "revision", "data")}
    value = result["data"]
    if "sources" in value:
        sources = [source for source in value["sources"] if isinstance(source, dict)
            and (not source.get("record_id") or source["record_id"] in documents or any(identifier == source["record_id"] for _, identifier in selected))]
        value["sources"] = _source_refs({"sources": sources}, documents, {identifier: kind for kind, identifier in selected})
    for key in ("document_id", "source_document_id"):
        if value.get(key) not in documents:
            value.pop(key, None)
    if "document_ids" in value:
        value["document_ids"] = [identifier for identifier in value["document_ids"] if identifier in documents]
    if "source_documents" in value:
        value["source_documents"] = [source for source in value["source_documents"] if source.get("document_id") in documents]
    for key in ("document_review", "saved_records"):
        value.pop(key, None)
    return result


class Folder:
    def __init__(self, archive):
        self.archive, self.files, self.bytes = archive, [], 0

    def _entry(self, path, size):
        if len(self.files) >= MAX_PACKET_FILES or self.bytes + size > MAX_PACKET_BYTES:
            raise ApiError(413, "packet_too_large", "This selection is too large for one 128 MiB folder. Prepare smaller cases or download its individual files. No partial folder was downloaded.")
        self.bytes += size
        entry = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = (stat.S_IFREG | 0o600) << 16
        return entry

    def add(self, path, content, label, media_type, source=None):
        self.archive.writestr(self._entry(path, len(content)), content)
        file = {"path": path, "label": label, "media_type": media_type, "size_bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest()}
        if source:
            file["source"] = {key: source[key] for key in ("kind", "id", "revision")}
        self.files.append(file)

    def original(self, session, record, check):
        data = record["data"]
        extension = {"application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "text/plain": "txt"}.get(data.get("media_type"))
        if extension is None or type(data.get("size_bytes")) is not int or data["size_bytes"] <= 0:
            raise _unavailable()
        path = f"originals/{record['id']}-v{record['revision']}.{extension}"
        handle, _ = _open_original(session, record)
        with handle:
            entry = self._entry(path, data["size_bytes"])
            checksum, size = hashlib.sha256(), 0
            with self.archive.open(entry, "w") as target:
                while chunk := handle.read(64 * 1024):
                    check()
                    size += len(chunk)
                    if size > data["size_bytes"]:
                        raise _unavailable()
                    checksum.update(chunk)
                    target.write(chunk)
            if size != data["size_bytes"] or checksum.hexdigest() != data.get("sha256"):
                raise _unavailable()
        self.files.append({"path": path, "label": _title(record), "media_type": data["media_type"], "size_bytes": size,
            "sha256": checksum.hexdigest(), "source": {key: record[key] for key in ("kind", "id", "revision")}})


def _indexes(selection, farm, files, notes):
    data = selection["content"]
    heading = f"{JOB_NAMES[data['job_type']]} folder: {data['title']}"
    state = ("Historical selection recorded as sent by a person. This is not a fresh check of current records or verified authority acceptance."
        if selection["origin"] == "sealed_sent_bundle" else "Reviewed preparation. Nothing has been sent.")
    pairs = [("Farm", farm.get("name")), ("Country", farm.get("country")), ("Region", farm.get("region")),
        ("Reporting year", data.get("reporting_year")), ("Authority named by the farmer", data.get("authority")),
        ("Scheme named by the farmer", data.get("scheme")), ("Recorded deadline", data.get("deadline")),
        ("Original reference", data.get("original_reference")), ("Recorded original submission date", data.get("original_submitted_at")),
        ("Reason and changes", data.get("reason")), ("Reviewed on", selection["review"].get("at"))]
    lines = [heading, "", state, NOTICE, "", "Open index.html for links to the files. Keep the whole extracted folder together.",
        "Attachments are the documents selected in this case, its completed items and its approved reports. Other private source files are not included.", ""]
    lines.extend(f"{label}: {readable(value)}" for label, value in pairs)
    if event := selection.get("event"):
        pairs.extend((label, event["data"].get(key)) for key, label in (("date", "Person-recorded sending date"), ("reference", "Person-recorded sending reference")))
        lines.extend(f"{label}: {readable(value)}" for label, value in pairs[-2:])
    rows = "".join(f"<dt>{escape(label)}</dt><dd>{escape(readable(value))}</dd>" for label, value in pairs)
    item_html = []
    if data.get("items"):
        lines.extend(("", "Requested records and follow-up"))
    for item in data.get("items", []):
        item_lines = [str(item["title"]), ITEM_NAMES.get(item["status"], item["status"])]
        if item.get("description"):
            item_lines.append(item["description"])
        if item.get("due_date"):
            item_lines.append("Recorded due date: " + item["due_date"])
        if note := (item.get("review") or {}).get("note"):
            item_lines.append("Review note: " + note)
        attached = [file for file in files if (file.get("source") or {}).get("kind") == "documents"
            and any(pin["id"] == file["source"]["id"] and pin["revision"] == file["source"]["revision"] for pin in item.get("document_pins", []))]
        links = "".join(f'<li><a href="{escape(file["path"], quote=True)}">{escape(file["label"])}</a></li>' for file in attached)
        item_html.append("<li><p>" + "<br>".join(escape(value) for value in item_lines) + "</p>" + ("<ul>" + links + "</ul>" if links else "") + "</li>")
        lines.extend(("", *item_lines, *("Supporting file: " + file["path"] for file in attached)))
    lines.extend(("", "Included files"))
    files_html = []
    for file in files:
        lines.append(file["label"] + ": " + file["path"])
        files_html.append(f'<li><a href="{escape(file["path"], quote=True)}">{escape(file["label"])}</a> <span>({file["size_bytes"]:,} bytes)</span></li>')
    if notes:
        lines.extend(("", "Notes", *notes))
    notes_html = "".join("<li>" + escape(note) + "</li>" for note in notes)
    html = ('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
        f'<title>{escape(heading)}</title><style>body{{font:16px/1.6 system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;color:#173c2d}}'
        'h1{line-height:1.2}dt{font-weight:700;margin-top:12px}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}li{margin:12px 0;overflow-wrap:anywhere}'
        'p{white-space:pre-wrap}a{color:#174d73}span{color:#555}@media print{body{margin:0;max-width:none}a{color:inherit}}</style>'
        f'<h1>{escape(heading)}</h1><p>{escape(state)}</p><p>{escape(NOTICE)}</p>'
        '<p>Keep the whole extracted folder together. The links below open its included files. This page does not contact any service.</p>'
        '<p>Attachments are the documents selected in this case, its completed items and its approved reports. Other private source files are not included.</p>'
        f'<dl>{rows}</dl>' + ('<h2>Requested records and follow-up</h2><ol>' + "".join(item_html) + '</ol>' if item_html else '')
        + '<h2>Included files</h2><ol>' + "".join(files_html) + '</ol>' + ('<h2>Notes</h2><ul>' + notes_html + '</ul>' if notes else '')
        + '<p>File details and reviewed versions are retained in manifest.json. They do not certify legal completeness or authority acceptance.</p></html>')
    return html.encode("utf-8"), "\n".join(lines).encode("utf-8")


def _report_budget(value):
    pending, nodes, text_bytes = [(value, 0)], 0, 0
    while pending:
        item, depth = pending.pop()
        nodes += 1
        if nodes > 50_000 or depth > 32:
            raise ApiError(413, "packet_report_too_large", "This report is too complex for the combined folder. Download its individual files or prepare a smaller response.")
        if isinstance(item, (dict, list)):
            child_count = len(item) * (2 if isinstance(item, dict) else 1)
            if child_count > 50_000 - nodes - len(pending):
                raise ApiError(413, "packet_report_too_large", "This report is too complex for the combined folder. Download its individual files or prepare a smaller response.")
            children = (child for pair in item.items() for child in pair) if isinstance(item, dict) else item
            pending.extend((child, depth + 1) for child in children)
        elif isinstance(item, str):
            size = len(item.encode("utf-8"))
            text_bytes += size
            if size > 64_000 or text_bytes > 1024 * 1024:
                raise ApiError(413, "packet_report_too_large", "This report contains too much text for the combined folder. Download its individual files or prepare a smaller response.")


def _build(spool, session, selection, records, check):
    data, notes = selection["content"], []
    outward_documents = _outward_documents(selection, records)
    outward_keys = {("farms", data["farm_id"])}
    with zipfile.ZipFile(spool, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=False) as archive:
        folder = Folder(archive)
        selected = {(ref["kind"], ref["id"]) for ref in data.get("references", [])}
        for key, record in sorted(records.items()):
            check()
            kind, identifier = key
            if kind == "documents":
                if identifier in outward_documents:
                    folder.original(session, record, check)
                    outward_keys.add(key)
                continue
            if key not in selected:
                continue
            outward_keys.add(key)
            roles = list(dict.fromkeys(ROLE_NAMES[ref["role"]] for ref in data["references"] if (ref["kind"], ref["id"]) == key))
            label = ", ".join(roles) + ": " + _title(record)
            if len(_json(record["data"])) > MAX_RENDER_SOURCE_BYTES:
                raise ApiError(413, "packet_record_too_large", "A selected record is too large for this folder. Download its individual files or prepare a smaller case. No partial folder was downloaded.")
            stem = f"{identifier}-v{record['revision']}"
            if kind == "reports":
                _report_budget(record["data"]["snapshot"])
                for format in ("pdf", "json", "xlsx"):
                    check()
                    response = render_report_download(record, format, require_issued=True)
                    check()
                    folder.add(f"reports/{stem}.{format}", response.body, f"{label} ({format.upper()})", response.media_type, record)
            elif kind == "field_change_proposals":
                for format, extension in (("geojson", "geojson"), ("correction", "json"), ("kml", "kml")):
                    try:
                        response = render_proposal_export(record, format)
                    except ApiError as exc:
                        if format != "kml" or exc.code != "boundary_required":
                            raise
                        notes.append(f"KML was not included for {_title(record)}: a valid outline is needed for every field. The retained GeoJSON and correction record remain included.")
                        continue
                    folder.add(f"fields/{stem}.{extension}", response.body, f"{label} ({format.upper()})", response.media_type, record)
            elif kind in {"requests", "facts", "operations", "checklists", "tasks"}:
                outward = _outward_record(record, outward_documents, selected)
                folder.add(f"records/{kind}-{stem}.txt", _record_text(outward), label, "text/plain; charset=utf-8", record)
                folder.add(f"records/{kind}-{stem}.json", _json(outward),
                    f"{label} (saved values)", "application/json", record)
        farm = records[("farms", data["farm_id"])]["data"]
        if data.get("focused_review_required") or any(data.get(key) is not None for key in ("cap_context", "original_statement", "answer_review")):
            folder.add("case-context.json", _json({"case_id": selection["case_id"], "case_revision": selection["case_revision"],
                "content": data, "notice": NOTICE}), "Retained case context and explicitly checked answers", "application/json")
        html, text = _indexes(selection, farm, folder.files, notes)
        check()
        folder.add("index.html", html, "Open this folder", "text/html; charset=utf-8")
        folder.add("index.txt", text, "Folder summary", "text/plain; charset=utf-8")
        manifest = {"version": 1, "case_id": selection["case_id"], "case_revision": selection["case_revision"],
            "reference_fingerprint": selection["review"]["fingerprint"], "origin": selection["origin"],
            "review": {key: selection["review"].get(key) for key in ("at", "actor_id")}, "notice": NOTICE,
            "source_records": [pin for pin in selection["review"]["referenced_revisions"] if (pin["kind"], pin["id"]) in outward_keys], "files": folder.files,
            "notes": notes, "manifest_scope": "The file list covers every other archive member, not manifest.json itself."}
        folder.add("manifest.json", _json(manifest), "Saved file details", "application/json")
    size = spool.tell()
    if not 0 < size <= MAX_PACKET_BYTES:
        raise ApiError(413, "packet_too_large", "This folder exceeds the 128 MiB download limit. Use smaller cases or individual downloads. No partial folder was downloaded.")
    spool.seek(0)
    checksum = hashlib.sha256()
    while chunk := spool.read(64 * 1024):
        check()
        checksum.update(chunk)
    spool.seek(0)
    return size, checksum.hexdigest()


@router.get("/{case_id}/packet")
async def packet(case_id: UUID, request: Request,
        reference_fingerprint: str = Query(pattern="^[0-9a-f]{64}$"),
        expected_revision: int | None = Query(None, ge=1), retained_revision: int | None = Query(None, ge=1),
        session: Session = Depends(require_session)):
    _human(session)
    if (expected_revision is None) == (retained_revision is None):
        raise ApiError(422, "packet_version_required", "Choose exactly one reviewed current version or one historical recorded sending.")
    if any(key not in {"expected_revision", "retained_revision", "reference_fingerprint"} or len(request.query_params.getlist(key)) != 1 for key in request.query_params):
        raise ApiError(422, "packet_query_invalid", "Use the exact reviewed folder link, without repeated or extra parameters.")
    historical, revision = retained_revision is not None, retained_revision if retained_revision is not None else expected_revision
    _claim_local_job(session)
    spool, released = None, False
    cancelled, started = threading.Event(), time.monotonic()

    def check():
        if cancelled.is_set():
            raise ApiError(408, "packet_cancelled", "Folder preparation was cancelled. No file was sent.")
        if time.monotonic() - started > MAX_PREPARE_SECONDS:
            raise ApiError(408, "packet_preparation_timeout", "Folder preparation took too long. Prepare a smaller case or download its individual files.")

    def cleanup():
        nonlocal released
        if not released:
            released = True
            if spool is not None:
                spool.close()
            _release_local_job(session)

    def prepare():
        nonlocal spool
        try:
            check()
            with transaction(session) as conn:
                selection = _selection(conn, case_id, revision, reference_fingerprint, historical=historical)
                records = _records(conn, selection, historical=historical, check=check)
                if not historical:
                    _current_review(conn, _case(conn, case_id))
            check()
            spool = tempfile.SpooledTemporaryFile(max_size=1024 * 1024, mode="w+b")
            size, checksum = _build(spool, session, selection, records, check)
            # Recheck permission and the exact selection before returning bytes.
            with transaction(session) as conn:
                latest = _selection(conn, case_id, revision, reference_fingerprint, historical=historical)
                _records(conn, latest, historical=historical, check=check)
                if not historical:
                    _current_review(conn, _case(conn, case_id))
            check()
            return selection, size, checksum
        except BaseException:
            cleanup()
            raise

    worker = asyncio.create_task(run_in_threadpool(prepare))

    def abandoned(done):
        try:
            done.result()
        except BaseException:
            pass
        cleanup()

    try:
        while not worker.done():
            await asyncio.wait({worker}, timeout=0.25)
            if await request.is_disconnected():
                cancelled.set()
        selection, size, checksum = await asyncio.shield(worker)
        check()
    except BaseException:
        cancelled.set()
        # A running report render cannot be interrupted mid-library call. It
        # checks cancellation on return and owns cleanup until the worker ends.
        worker.add_done_callback(abandoned)
        raise

    def chunks():
        try:
            while chunk := spool.read(64 * 1024):
                yield chunk
        finally:
            cleanup()

    return StreamingResponse(chunks(), media_type="application/zip", background=BackgroundTask(cleanup), headers={
        "Content-Disposition": f'attachment; filename="prepared-{selection["content"]["job_type"]}-{case_id}-v{revision}.zip"',
        "Content-Length": str(size), "Cache-Control": "private, no-store, max-age=0, no-transform", "Pragma": "no-cache",
        "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox", "X-Case-Packet-SHA256": checksum,
        "X-Case-Review-Fingerprint": reference_fingerprint,
    })
