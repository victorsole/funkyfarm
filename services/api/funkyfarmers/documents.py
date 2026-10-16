"""Private originals, bounded local extraction, and explicitly reviewed requests."""

from __future__ import annotations

from datetime import date, datetime, timezone
import asyncio
from email import policy
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading
from typing import Any, Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import Field, ValidationError
from starlette.concurrency import run_in_threadpool

from .db import fetch_record, idempotent, insert_record, json_safe, list_records, transaction, update_record
from .extraction import MAX_TEXT_CHARACTERS, ExtractionFailure, bounded_extraction, bounded_validation
from .models import ApiError, StrictModel, UpdateRecord
from .records import validate_data
from .reporting import _pack_year_matches, get_pack
from .security import Session, require_session


MAX_UPLOAD_BYTES = 12 * 1024 * 1024
MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES + 64 * 1024
WORKSPACE_STORAGE_BYTES = 256 * 1024 * 1024
WORKSPACE_DOCUMENT_LIMIT = 500
LOCAL_JOBS = threading.BoundedSemaphore(2)
JOB_WORKSPACES: set[str] = set()
JOB_WORKSPACES_LOCK = threading.Lock()
EU_COUNTRIES = frozenset("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split())


def _private_response(response: Response):
    response.headers["Cache-Control"] = "private, no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"


router = APIRouter(prefix="/documents", tags=["documents"], dependencies=[Depends(_private_response)])


class ExtractionInput(StrictModel):
    text: str | None = Field(default=None, max_length=MAX_TEXT_CHARACTERS)
    document_type: Literal["receipt", "letter", "notebook", "unknown"] | None = None
    expected_revision: int | None = Field(default=None, ge=1)


class DocumentRecordInput(StrictModel):
    expected_revision: int = Field(ge=1)
    kind: Literal["purchases", "sales", "operations", "tasks", "facts"]
    data: dict[str, Any]
    selected_proposal_ids: list[str] = Field(default_factory=list, max_length=50)
    acknowledged_issue_codes: list[str] = Field(default_factory=list, max_length=100)
    check_token: str | None = Field(default=None, max_length=64)


class CollectionInput(StrictModel):
    request_id: str
    expected_revision: int = Field(ge=1)
    document_ids: list[str] = Field(min_length=1, max_length=50)


def _claim_local_job(session: Session):
    with JOB_WORKSPACES_LOCK:
        workspace_id = str(session.workspace_id)
        if workspace_id in JOB_WORKSPACES:
            raise ApiError(429, "workspace_processing_busy", "Another document is being uploaded or processed in this workspace. Retry shortly.")
        if not LOCAL_JOBS.acquire(blocking=False):
            raise ApiError(429, "processing_busy", "Local document processing is busy. Retry shortly.")
        JOB_WORKSPACES.add(workspace_id)


def _release_local_job(session: Session):
    with JOB_WORKSPACES_LOCK:
        JOB_WORKSPACES.discard(str(session.workspace_id))
        LOCAL_JOBS.release()


async def _bounded_body(request: Request, maximum: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
        except ValueError:
            raise ApiError(400, "invalid_content_length", "The request size header is invalid.") from None
        if length < 0 or length > maximum:
            raise ApiError(413, "document_too_large", "This upload exceeds the allowed request size.")
    content = bytearray()
    try:
        async with asyncio.timeout(30):
            async for chunk in request.stream():
                if len(content) + len(chunk) > maximum:
                    raise ApiError(413, "document_too_large", "This upload exceeds the allowed request size.")
                content.extend(chunk)
    except TimeoutError:
        raise ApiError(408, "upload_timeout", "The upload was interrupted or too slow. Retry the saved file.") from None
    return bytes(content)


def _uuid(value: str, label: str = "record") -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise ApiError(400, "invalid_id", f"Choose a valid {label}.") from None


def _filename(value: str | None) -> str:
    name = (value or "document").replace("\\", "/").split("/")[-1]
    name = "".join(char for char in name if ord(char) >= 32 and ord(char) != 127).strip(" .")
    return name[:180] or "document"


def _multipart(content: bytes, content_type: str) -> tuple[bytes, str, str, str | None]:
    if "\r" in content_type or "\n" in content_type or len(content_type) > 512:
        raise ApiError(400, "invalid_multipart", "The upload content type is invalid.")
    message = BytesParser(policy=policy.default).parsebytes(
        ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode("ascii", "strict") + content
    )
    boundary = message.get_boundary()
    if message.get_content_type() != "multipart/form-data" or not boundary or len(boundary) > 200 or not message.is_multipart():
        raise ApiError(400, "invalid_multipart", "Send one file using multipart/form-data.")
    if message.defects:
        raise ApiError(400, "invalid_multipart", "The multipart upload is incomplete or malformed.")
    parts = list(message.iter_parts())
    if not 1 <= len(parts) <= 2:
        raise ApiError(400, "invalid_multipart", "Send one file and, optionally, a farm identifier.")
    upload = None
    farm_id = None
    seen = set()
    for part in parts:
        name = part.get_param("name", header="content-disposition")
        if part.get_content_disposition() != "form-data" or name not in {"file", "farm_id"} or name in seen or part.is_multipart() or part.defects:
            raise ApiError(400, "invalid_multipart", "The upload fields are invalid or repeated.")
        seen.add(name)
        encoding = (part.get("Content-Transfer-Encoding") or "binary").lower()
        if encoding not in {"binary", "8bit", "7bit"}:
            raise ApiError(400, "invalid_multipart", "Encoded multipart file transfers are not supported.")
        payload = part.get_payload(decode=True)
        if not isinstance(payload, bytes):
            raise ApiError(400, "invalid_multipart", "The uploaded field could not be read.")
        if name == "file":
            if not part.get_filename():
                raise ApiError(400, "missing_file", "Choose a file to upload.")
            if not payload or len(payload) > MAX_UPLOAD_BYTES:
                raise ApiError(413, "document_too_large", "Choose a nonempty file no larger than 12 MiB.")
            upload = (payload, part.get_content_type(), _filename(part.get_filename()))
        else:
            if len(payload) > 64:
                raise ApiError(400, "invalid_id", "Choose a valid farm.")
            try:
                supplied = payload.decode("utf-8").strip()
            except UnicodeDecodeError:
                raise ApiError(400, "invalid_id", "Choose a valid farm.") from None
            farm_id = _uuid(supplied, "farm") if supplied else None
    if upload is None:
        raise ApiError(400, "missing_file", "Choose a file to upload.")
    return (*upload, farm_id)


def _storage_root() -> Path:
    configured = os.environ.get("FUNKYFARMERS_STORAGE_ROOT") or os.environ.get("FF_STORAGE_ROOT")
    root = Path(configured) if configured else Path.cwd() / "runtime" / "private-documents"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root.resolve(strict=True)


def _original_path(session: Session, document_id: str, create: bool = False) -> Path:
    root = _storage_root()
    workspace = root / _uuid(session.workspace_id, "workspace")
    document = workspace / _uuid(document_id, "document")
    for directory in (workspace, document):
        if directory.is_symlink():
            raise ApiError(500, "storage_unavailable", "Private document storage needs operator attention.")
        if create:
            directory.mkdir(mode=0o700, exist_ok=True)
        if directory.exists() and (not directory.is_dir() or not directory.resolve(strict=True).is_relative_to(root)):
            raise ApiError(500, "storage_unavailable", "Private document storage needs operator attention.")
    return document / "original"


def _atomic_original(path: Path, content: bytes):
    if path.exists() or path.is_symlink():
        raise ApiError(409, "original_exists", "This original is already stored and cannot be replaced.")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", prefix=".upload-", dir=path.parent, delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o400)
        # A fresh random document identifier owns this destination; no replace route exists.
        os.replace(temporary, path)
        temporary = None
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _remove_uncommitted(path: Path):
    if path.exists() and not path.is_symlink():
        os.chmod(path, 0o600)
        path.unlink()
    try:
        path.parent.rmdir()
    except OSError:
        pass


def _open_original(session: Session, record: dict):
    path = _original_path(session, record["id"])
    if path.is_symlink():
        raise ApiError(500, "original_unavailable", "The original is unavailable. Ask the operator to restore it from backup.")
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        handle = os.fdopen(descriptor, "rb")
    except OSError:
        raise ApiError(404, "original_unavailable", "The original is unavailable. Ask the operator to restore it from backup.") from None
    try:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size != record["data"].get("size_bytes") or info.st_size > MAX_UPLOAD_BYTES:
            raise ApiError(500, "original_integrity_failed", "The stored original failed its integrity check. Ask the operator to restore it.")
        digest = hashlib.sha256()
        while chunk := handle.read(64 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != record["data"].get("sha256"):
            raise ApiError(500, "original_integrity_failed", "The stored original failed its integrity check. Ask the operator to restore it.")
        handle.seek(0)
        return handle, path
    except BaseException:
        handle.close()
        raise


def _workspace_lock(conn, session: Session, scope: str = "documents"):
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:{scope}",))


def _physical_usage(session: Session) -> tuple[int, int]:
    """Count private orphan files too, so interrupted commits cannot evade quotas."""
    workspace = _storage_root() / _uuid(session.workspace_id, "workspace")
    if not workspace.exists():
        return 0, 0
    if workspace.is_symlink() or not workspace.resolve().is_relative_to(_storage_root()):
        raise ApiError(500, "storage_unavailable", "Private storage needs operator attention.")
    count = total = 0
    with os.scandir(workspace) as directories:
        for directory in directories:
            if directory.is_symlink() or not directory.is_dir(follow_symlinks=False):
                raise ApiError(500, "storage_unavailable", "Private storage needs operator attention.")
            count += 1
            if count >= WORKSPACE_DOCUMENT_LIMIT:
                return count, total
            with os.scandir(directory.path) as files:
                for entry in files:
                    if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                        raise ApiError(500, "storage_unavailable", "Private storage needs operator attention.")
                    total += entry.stat(follow_symlinks=False).st_size
                    if total >= WORKSPACE_STORAGE_BYTES:
                        return count, total
    return count, total


def _save_document(session: Session, content: bytes, media_type: str, filename: str,
                   farm_id: str | None, retry_key: str | None):
    try:
        checked_type, properties = bounded_validation(content, media_type)
    except ExtractionFailure as exc:
        status = 503 if exc.code.endswith("unavailable") else 415
        raise ApiError(status, exc.code, exc.message) from None
    digest = hashlib.sha256(content).hexdigest()
    written = []
    commit_pending = False
    try:
        with transaction(session) as conn:
            _workspace_lock(conn, session)
            if farm_id:
                fetch_record(conn, "farms", farm_id)

            def save():
                duplicate = conn.execute("SELECT id FROM records WHERE kind='documents' AND deleted_at IS NULL AND data->>'sha256'=%s LIMIT 1", (digest,)).fetchone()
                if duplicate:
                    record = fetch_record(conn, "documents", duplicate["id"])
                    if farm_id and record["data"].get("farm_id") != farm_id:
                        raise ApiError(409, "duplicate_farm_conflict", "This file is already in your workspace with another farm link. Open the existing document to review it.", {"document_id": record["id"]})
                    return {**record, "duplicate": True}
                quota = conn.execute("SELECT count(*) AS count,COALESCE(sum((data->>'size_bytes')::bigint),0) AS bytes FROM records WHERE kind='documents' AND deleted_at IS NULL").fetchone()
                physical_count, physical_bytes = _physical_usage(session)
                if max(quota["count"], physical_count) >= WORKSPACE_DOCUMENT_LIMIT or max(quota["bytes"], physical_bytes) + len(content) > WORKSPACE_STORAGE_BYTES:
                    raise ApiError(413, "workspace_storage_limit", "This workspace has reached its document storage limit. Ask the operator to export or remove old records.", {"max_documents": WORKSPACE_DOCUMENT_LIMIT, "max_bytes": WORKSPACE_STORAGE_BYTES})
                data = {"filename": filename, "media_type": checked_type, "size_bytes": len(content),
                        "sha256": digest, "farm_id": farm_id, "extraction": None,
                        "review_status": "unreviewed", "uploaded_by": str(session.user_id), **properties}
                record = insert_record(conn, "documents", data)
                path = _original_path(session, record["id"], create=True)
                written.append(path)
                _atomic_original(path, content)
                return record

            result = idempotent(conn, retry_key, "document-upload", {"sha256": digest, "filename": filename, "farm_id": farm_id, "media_type": checked_type}, save)
            commit_pending = True
        return result
    except BaseException:
        # A failed commit acknowledgement may still mean PostgreSQL committed.
        # Retain the private original in that case; it remains counted by quota.
        if not commit_pending:
            for path in written:
                _remove_uncommitted(path)
        raise


@router.post("", status_code=201)
async def upload_document(request: Request, session: Session = Depends(require_session),
                          idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    _claim_local_job(session)
    try:
        content = await _bounded_body(request, MAX_MULTIPART_BYTES)
        try:
            file_content, media_type, filename, farm_id = _multipart(content, request.headers.get("content-type", ""))
        except (UnicodeEncodeError, ValueError, LookupError, RecursionError):
            raise ApiError(400, "invalid_multipart", "The multipart upload could not be read.") from None
        return await run_in_threadpool(_save_document, session, file_content, media_type, filename, farm_id, idempotency_key)
    finally:
        _release_local_job(session)


@router.get("")
def documents(limit: int = Query(default=50, ge=1, le=100), offset: int = Query(default=0, ge=0),
              farm_id: str | None = None, q: str | None = Query(default=None, max_length=200),
              document_type: Literal["receipt", "letter", "notebook", "unknown"] | None = None,
              session: Session = Depends(require_session)):
    with transaction(session) as conn:
        if farm_id:
            farm_id = _uuid(farm_id, "farm")
            fetch_record(conn, "farms", farm_id)
        if (not q or not q.strip()) and not document_type:
            page = list_records(conn, "documents", limit, offset, farm_id)
        else:
            where = "kind='documents' AND deleted_at IS NULL"
            parameters = []
            if q and q.strip():
                query = q.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                where += " AND (concat_ws(' ',data->>'filename',data->>'title',data->>'notes',data->>'search_text') ILIKE %s ESCAPE '\\')"
                parameters.append("%" + query + "%")
            if farm_id:
                where += " AND data->>'farm_id'=%s"
                parameters.append(farm_id)
            if document_type:
                where += " AND COALESCE(data->>'document_type',data->'extraction'->>'document_type','unknown')=%s"
                parameters.append(document_type)
            total = conn.execute(f"SELECT count(*) AS count FROM records WHERE {where}", parameters).fetchone()["count"]
            rows = conn.execute(f"SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE {where} ORDER BY updated_at DESC,id LIMIT %s OFFSET %s", [*parameters, limit, offset]).fetchall()
            page = {"items": json_safe(rows), "total": total, "limit": limit, "offset": offset}
        # Source text belongs on the detail screen, not every library row.
        page["items"] = [{**item, "data": {**{key: value for key, value in item["data"].items() if key != "search_text"}, "extraction": _extraction_summary(item["data"].get("extraction"))}} for item in page["items"]]
        return page


def _extraction_summary(extraction):
    if not extraction:
        return None
    return {key: extraction[key] for key in ("status", "adapter", "document_type", "review_status", "transaction_direction", "failure") if key in extraction}


@router.get("/{document_id}")
def document(document_id: str, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        return fetch_record(conn, "documents", document_id)


@router.patch("/{document_id}")
def describe_document(document_id: str, body: UpdateRecord, session: Session = Depends(require_session)):
    allowed = {"title", "notes", "farm_id", "document_type"}
    if set(body.data) - allowed:
        raise ApiError(422, "immutable_original", "Only the document name, notes, type and farm link can be edited. The original stays unchanged.")
    with transaction(session) as conn:
        current = fetch_record(conn, "documents", document_id)
        data = {**current["data"], **body.data}
        for key, maximum in (("title", 240), ("notes", 4000)):
            if key in body.data and (not isinstance(body.data[key], str) or len(body.data[key]) > maximum):
                raise ApiError(422, "invalid_description", f"Enter a short document {key}.")
        if "document_type" in body.data and body.data["document_type"] not in ("receipt", "letter", "notebook", "unknown"):
            raise ApiError(422, "invalid_document_type", "Choose a receipt, letter, notebook page, or leave the type undecided.")
        if body.data.get("farm_id"):
            data["farm_id"] = _uuid(body.data["farm_id"], "farm")
            fetch_record(conn, "farms", data["farm_id"])
        if current["data"].get("farm_id") and data.get("farm_id") != current["data"]["farm_id"]:
            raise ApiError(409, "farm_link_retained", "This document is already linked to a farm. Keep that link so its saved records retain their source.")
        return update_record(conn, "documents", current["id"], body.expected_revision, data)


@router.post("/collection")
def collect_documents(body: CollectionInput, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        request_record = fetch_record(conn, "requests", body.request_id)
        data = request_record["data"]
        if data.get("status", "draft") not in ("draft", "review", "waiting"):
            raise ApiError(409, "request_already_issued", "Create a correction request before changing documents for an issued response.")
        document_ids = sorted(set(_uuid(value, "document") for value in body.document_ids))
        for identifier in document_ids:
            current = fetch_record(conn, "documents", identifier)
            if current["data"].get("farm_id") not in (None, data.get("farm_id")):
                raise ApiError(422, "farm_mismatch", "Every selected document must belong to this request's farm, or have no farm link yet.")
            if not current["data"].get("farm_id"):
                update_record(conn, "documents", current["id"], current["revision"], {**current["data"], "farm_id": data["farm_id"],
                              "request_ids": list(dict.fromkeys([*current["data"].get("request_ids", []), request_record["id"]]))})
        combined = list(dict.fromkeys([*data.get("document_ids", []), *([data["document_id"]] if data.get("document_id") else []), *document_ids]))
        if len(combined) > 100:
            raise ApiError(422, "too_many_documents", "Keep a request collection to 100 documents or fewer.")
        sources = []
        for identifier in combined:
            current = fetch_record(conn, "documents", identifier)
            sources.append({"document_id": identifier, "sha256": current["data"]["sha256"]})
        updated = {**data, "document_ids": combined, "source_documents": sources,
                   "documents_collected_by": str(session.user_id), "documents_collected_at": datetime.now(timezone.utc).isoformat()}
        return update_record(conn, "requests", request_record["id"], body.expected_revision, updated)


@router.post("/{document_id}/records", status_code=201)
def record_from_document(document_id: str, body: DocumentRecordInput,
                          session: Session = Depends(require_session),
                          idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    with transaction(session) as conn:
        _workspace_lock(conn, session)

        def create():
            current = fetch_record(conn, "documents", document_id)
            if current["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "The document changed. Reload it and compare your entries before saving.", {"current_revision": current["revision"]})
            original_handle, _ = _open_original(session, current)
            original_handle.close()
            farm_id = _uuid(body.data.get("farm_id"), "farm")
            if current["data"].get("farm_id") not in (None, farm_id):
                raise ApiError(422, "farm_mismatch", "Use the farm already linked to this document.")
            if body.kind != "tasks":
                conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{session.workspace_id}:reconciliation:{farm_id}",))
            extraction = current["data"].get("extraction") or {}
            if body.kind == "operations" and (current["data"].get("document_type") == "receipt" or extraction.get("document_type") == "receipt"):
                raise ApiError(422, "receipt_is_not_work", "Choose whether this document supports a purchase or a sale. To record actual work, add a dated notebook page or work record that describes what happened.")
            available = {proposal.get("id"): proposal for proposal in extraction.get("fields", []) if proposal.get("id")}
            selected = list(dict.fromkeys(body.selected_proposal_ids))
            if any(identifier not in available for identifier in selected):
                raise ApiError(409, "suggestions_changed", "Some suggestions changed. Reload the document and review them again.")
            source_base = {"kind": "document", "document_id": current["id"], "sha256": current["data"]["sha256"]}
            sources = [{**source_base, **source, "proposal_id": identifier} for identifier in selected for source in available[identifier].get("sources", [])]
            sources = sources or [{**source_base, "location": "Manually read from the original; no exact line was claimed."}]
            if len(sources) > 100:
                raise ApiError(422, "too_many_sources", "Choose fewer suggestions for this record.")
            entered = {**body.data, "farm_id": farm_id}
            if body.kind != "facts":
                entered["document_id"] = current["id"]
            if body.kind != "tasks":
                entered["sources"] = sources
            if body.kind == "tasks":
                checked = validate_data(conn, body.kind, entered)
                checks = {"can_save": True, "normalized_data": checked, "issues": [], "requires_acknowledgement": []}
            else:
                from .workflows import check_capture
                checks = check_capture(conn, body.kind, entered)
            if not checks.get("can_save", False):
                raise ApiError(422, "capture_needs_review", "Check the highlighted details before saving this record.", {"issues": checks.get("issues", [])})
            required_acknowledgements = checks.get("requires_acknowledgement", [])
            if required_acknowledgements and body.check_token != checks.get("check_token"):
                raise ApiError(409, "capture_checks_changed", "Read the current checks before keeping these entries.", checks)
            missing_acknowledgements = [issue for issue in checks.get("issues", []) if issue.get("code") in required_acknowledgements and issue.get("code") not in body.acknowledged_issue_codes]
            if missing_acknowledgements:
                raise ApiError(422, "capture_warning_review", "Read the warnings and choose whether to keep these entries.", checks)
            checked = validate_data(conn, body.kind, checks.get("normalized_data", entered))
            reviewed = {**checked, "document_review": {"document_id": current["id"], "document_revision": current["revision"],
                                                       "selected_proposal_ids": selected, "sources": sources,
                                                       "entered_by": str(session.user_id), "entered_at": datetime.now(timezone.utc).isoformat(),
                                                       "acknowledged_issue_codes": body.acknowledged_issue_codes, "issues": checks.get("issues", [])}}
            # The actor chooses purchase versus sale. A financial record never
            # creates a farm operation or an animal movement.
            saved = insert_record(conn, body.kind, reviewed)
            links = [*current["data"].get("saved_records", []), {"kind": body.kind, "id": saved["id"]}]
            updated = {**current["data"], "farm_id": farm_id, "saved_records": links}
            update_record(conn, "documents", current["id"], current["revision"], updated)
            return saved

        return idempotent(conn, idempotency_key, f"document-record:{document_id}", body.model_dump(), create)


@router.get("/{document_id}/file")
def original(document_id: str, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        record = fetch_record(conn, "documents", document_id)
        handle, _ = _open_original(session, record)

    def chunks():
        try:
            while value := handle.read(64 * 1024):
                yield value
        finally:
            handle.close()

    extension = {"application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "text/plain": ".txt"}.get(record["data"]["media_type"], "")
    return StreamingResponse(chunks(), media_type="application/octet-stream", headers={
        "Content-Disposition": f"attachment; filename=\"original{extension}\"; filename*=UTF-8''{quote(_filename(record['data']['filename']), safe='')}",
        "Content-Length": str(record["data"]["size_bytes"]), "Cache-Control": "private, no-store, max-age=0",
        "Pragma": "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
    })


def _extract_document(session: Session, document_id: str, body: ExtractionInput):
    _claim_local_job(session)
    try:
        with transaction(session) as conn:
            # One job per workspace; another farmer's requests do not wait for this lock.
            available = conn.execute("SELECT pg_try_advisory_xact_lock(hashtextextended(%s,0)) AS acquired", (f"{session.workspace_id}:extraction",)).fetchone()["acquired"]
            if not available:
                raise ApiError(429, "workspace_processing_busy", "Another document is being processed in this workspace. Retry shortly.")
            record = fetch_record(conn, "documents", document_id)
            if body.expected_revision is not None and record["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "This document changed. Reload it before extraction.", {"current_revision": record["revision"]})
            input_hash = hashlib.sha256(json.dumps({"original_sha256": record["data"]["sha256"],
                                                    "text": body.text, "document_type": body.document_type,
                                                    "extractor_version": 3}, sort_keys=True).encode()).hexdigest()
            if record["data"].get("extraction_input_sha256") == input_hash and (record["data"].get("extraction") or {}).get("status") == "proposed":
                return record
            handle, path = _open_original(session, record)
            with handle:
                content = handle.read(MAX_UPLOAD_BYTES + 1)
            extraction = bounded_extraction(content, record["data"]["media_type"], path, record["id"], body.text, body.document_type)
            search_text = "\n".join(line["text"] for page in extraction.get("pages", []) for line in page.get("lines", []))[:100_000]
            data = {**record["data"], "extraction": extraction, "extraction_input_sha256": input_hash,
                    "document_type": extraction.get("document_type", "unknown"), "search_text": search_text}
            return update_record(conn, "documents", record["id"], record["revision"], data)
    finally:
        _release_local_job(session)


@router.post("/{document_id}/extract")
async def extract_document(document_id: str, request: Request, session: Session = Depends(require_session)):
    content = await _bounded_body(request, MAX_TEXT_CHARACTERS * 4 + 4096)
    try:
        body = ExtractionInput.model_validate(json.loads(content) if content else {})
    except (ValueError, ValidationError):
        raise ApiError(400, "invalid_extraction_input", "Supply optional manual text, a document type, and the saved revision.") from None
    return await run_in_threadpool(_extract_document, session, document_id, body)


def _request_data(data: dict) -> dict:
    allowed = {"farm_id", "title", "recipient", "country", "region", "reporting_year", "deadline", "pack_id", "requirements", "status"}
    if set(data) - allowed:
        raise ApiError(400, "invalid_request", "The reviewed request contains unsupported fields.")
    result = dict(data)
    result["farm_id"] = _uuid(result.get("farm_id"), "farm")
    for key, maximum in (("title", 240), ("recipient", 240), ("pack_id", 180)):
        value = result.get(key)
        if not isinstance(value, str) or not value.strip() or len(value) > maximum:
            raise ApiError(400, "missing_reviewed_value", f"Enter and review the request {key.replace('_', ' ')}.")
        result[key] = value.strip()
    if not isinstance(result.get("country"), str) or result["country"] not in EU_COUNTRIES:
        raise ApiError(400, "invalid_country", "Choose the request's EU country explicitly.")
    year = result.get("reporting_year")
    if type(year) is not int or not 1900 <= year <= 2100:
        raise ApiError(400, "invalid_reporting_year", "Enter the reviewed reporting year.")
    if result.get("region") is not None and (not isinstance(result["region"], str) or len(result["region"]) > 120):
        raise ApiError(400, "invalid_region", "Enter a region no longer than 120 characters.")
    if "deadline" not in result:
        raise ApiError(400, "missing_reviewed_deadline", "Confirm a deadline date, or explicitly leave it unknown using null.")
    if result["deadline"] is not None:
        value = result["deadline"]
        try:
            if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                raise ValueError
            date.fromisoformat(value)
        except ValueError:
            raise ApiError(400, "invalid_deadline", "Enter a reviewed deadline as YYYY-MM-DD, or leave it unknown.") from None
    requirements = result.setdefault("requirements", [])
    try:
        requirements_size = len(json.dumps(requirements, ensure_ascii=False, allow_nan=False))
    except (ValueError, TypeError):
        raise ApiError(400, "invalid_requirements", "Use ordinary JSON values for reviewed requirements.") from None
    if not isinstance(requirements, list) or len(requirements) > 100 or requirements_size > 40_000:
        raise ApiError(400, "invalid_requirements", "Review a list of at most 100 requirements.")
    if any(not isinstance(item, dict) or not isinstance(item.get("key"), str) or not isinstance(item.get("label"), str) for item in requirements):
        raise ApiError(400, "invalid_requirements", "Each reviewed requirement needs a key and label.")
    if result.get("status", "draft") != "draft":
        raise ApiError(400, "draft_required", "A reviewed document creates a draft request first.")
    result["status"] = "draft"
    return result


@router.post("/{document_id}/request", status_code=201)
def request_from_document(document_id: str, body: UpdateRecord,
                          session: Session = Depends(require_session),
                          idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    data = _request_data(body.data)
    with transaction(session) as conn:
        _workspace_lock(conn, session)

        def create():
            document = fetch_record(conn, "documents", document_id)
            if document["revision"] != body.expected_revision:
                raise ApiError(409, "revision_conflict", "This document changed. Reload it and review your request again.", {"current_revision": document["revision"]})
            original_handle, _ = _open_original(session, document)
            original_handle.close()
            fetch_record(conn, "farms", data["farm_id"])
            if document["data"].get("farm_id") not in {None, data["farm_id"]}:
                raise ApiError(409, "farm_mismatch", "Choose the farm linked to this document.")
            # Values come only from the explicit reviewed body, including nullable deadline.
            validated = validate_data(conn, "requests", {**data, "document_id": document["id"]})
            pack = get_pack(data["pack_id"])
            if pack.get("country") not in (None, data["country"]) or not _pack_year_matches(pack, data["reporting_year"]):
                raise ApiError(400, "pack_mismatch", "Choose a reporting pack for this request's country and reporting year.")
            reviewed = {**validated, "source_document_id": document["id"],
                        "source_documents": [{"document_id": document["id"], "sha256": document["data"]["sha256"], "revision": document["revision"]}],
                        "reviewed_by": str(session.user_id), "reviewed_at": datetime.now(timezone.utc).isoformat()}
            request_record = insert_record(conn, "requests", reviewed)
            updated = {**document["data"], "farm_id": data["farm_id"], "request_ids": [*document["data"].get("request_ids", []), request_record["id"]]}
            update_record(conn, "documents", document["id"], document["revision"], updated)
            return request_record

        return idempotent(conn, idempotency_key, f"document-request:{_uuid(document_id, 'document')}",
                          {"expected_revision": body.expected_revision, "data": data}, create)
