"""Local extraction suggestions. Source text never becomes a confirmed farm fact."""

from __future__ import annotations

from datetime import datetime, timezone
from io import BytesIO
import os
import multiprocessing
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import warnings


MAX_PAGES = 25
MAX_TEXT_CHARACTERS = 250_000
MAX_LINES = 5_000
MAX_LINE_CHARACTERS = 4_000
MAX_IMAGE_PIXELS = 25_000_000


def _limit_worker_memory() -> None:
    """Apply a memory ceiling to this disposable local parser/OCR worker."""
    maximum = 512 * 1024 * 1024
    if os.name != "nt":
        import resource
        os.setsid()
        resource.setrlimit(resource.RLIMIT_AS, (maximum, maximum))
        resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
        return
    import ctypes
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BasicLimits), ("IoInfo", IoCounters),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x100 | 0x2000  # memory ceiling; kill descendants when worker exits
    limits.ProcessMemoryLimit = maximum
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise RuntimeError("The local parser memory limit could not be applied.")
    # Keep the handle open for the lifetime of this disposable worker.


def _process_worker(connection, mode: str, args: tuple) -> None:
    try:
        _limit_worker_memory()
        result = validate_original(*args) if mode == "validate" else extract_proposals(*args)
        connection.send((True, result))
    except ExtractionFailure as exc:
        connection.send((False, {"code": exc.code, "message": exc.message}))
    except BaseException:
        connection.send((False, {"code": "local_processing_failed", "message": "Local processing could not finish within its resource limits. Use manual text or a smaller file."}))
    finally:
        connection.close()


def _bounded_process(mode: str, args: tuple, timeout: int):
    context = multiprocessing.get_context("spawn")
    receiving, sending = context.Pipe(duplex=False)
    process = context.Process(target=_process_worker, args=(sending, mode, args), daemon=True)
    try:
        try:
            process.start()
        except (OSError, RuntimeError):
            raise ExtractionFailure("processing_unavailable", "The local processing worker could not start. Enter manual text or ask the operator to check the installation.") from None
        sending.close()
        if not receiving.poll(timeout):
            raise ExtractionFailure("processing_timeout", "Local processing took too long. Enter manual text or choose a smaller document.")
        try:
            success, result = receiving.recv()
        except (EOFError, OSError):
            raise ExtractionFailure("local_processing_failed", "Local processing reached its resource limit. Enter manual text or choose a smaller document.") from None
        if not success:
            raise ExtractionFailure(result["code"], result["message"])
        return result
    finally:
        receiving.close()
        sending.close()
        if process.pid:
            if process.is_alive():
                if os.name != "nt":
                    import signal
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        process.terminate()
                else:
                    process.terminate()
            process.join(timeout=2)
            if process.is_alive():
                process.kill()
                process.join(timeout=2)


def bounded_validation(content: bytes, declared_type: str) -> tuple[str, dict]:
    media_type = declared_type.lower().split(";", 1)[0].strip()
    if media_type == "text/plain" or (media_type == "application/octet-stream" and not content.startswith((b"%PDF-", b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff"))):
        return validate_original(content, declared_type)
    return _bounded_process("validate", (content, declared_type), 15)


def bounded_extraction(content: bytes, media_type: str, original_path: Path,
                       document_id: str, manual_text: str | None = None,
                       document_type: str | None = None) -> dict:
    # Bounded UTF-8/manual text needs no external parser or child process.
    if manual_text is not None or media_type == "text/plain":
        return extract_proposals(content, media_type, original_path, document_id, manual_text, document_type)
    try:
        return _bounded_process("extract", (content, media_type, original_path, document_id, manual_text, document_type), 55)
    except ExtractionFailure as exc:
        return {"status": "needs_manual_input", "adapter": "local", "document_type": document_type or "unknown",
                "pages": [], "fields": [], "review_status": "proposed", "warnings": [],
                "uncertain_fields": [{"key": "document", "reason": exc.message}],
                "failure": {"code": exc.code, "message": exc.message}}


class ExtractionFailure(Exception):
    """An honest, user-actionable local processing failure."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def validate_original(content: bytes, declared_type: str) -> tuple[str, dict]:
    """Check bytes against the claimed supported media type before retaining them."""
    declared_type = declared_type.lower().split(";", 1)[0].strip()
    if declared_type == "application/octet-stream":
        declared_type = ("application/pdf" if content.startswith(b"%PDF-") else
                         "image/png" if content.startswith(b"\x89PNG\r\n\x1a\n") else
                         "image/jpeg" if content.startswith(b"\xff\xd8\xff") else "text/plain")
    if declared_type == "text/plain":
        try:
            value = content.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise ExtractionFailure("invalid_text", "Plain text must use UTF-8 encoding.") from None
        if not value.strip() or any(ord(c) < 32 and c not in "\r\n\t\f" for c in value):
            raise ExtractionFailure("invalid_text", "Provide readable plain text without binary control characters.")
        if len(value) > MAX_TEXT_CHARACTERS:
            raise ExtractionFailure("text_too_large", "Split this text into documents of at most 250,000 characters.")
        if value.count("\f") + 1 > MAX_PAGES:
            raise ExtractionFailure("too_many_pages", "A document may contain at most 25 pages.")
        return "text/plain", {"page_count": value.count("\f") + 1}
    if declared_type == "application/pdf":
        if not content.startswith(b"%PDF-") or b"%%EOF" not in content[-2048:]:
            raise ExtractionFailure("invalid_pdf", "This file does not contain a complete PDF document.")
        try:
            from pypdf import PdfReader
        except ImportError:
            raise ExtractionFailure("pdf_unavailable", "PDF reading is unavailable here. Add readable text or an image, or ask the workspace owner for help.") from None
        try:
            reader = PdfReader(BytesIO(content), strict=True)
            if reader.is_encrypted:
                raise ExtractionFailure("encrypted_pdf", "Unlock this PDF before uploading it.")
            count = len(reader.pages)
            if not 1 <= count <= MAX_PAGES:
                raise ExtractionFailure("too_many_pages", "A PDF must contain between 1 and 25 pages.")
            for page in reader.pages:
                box = page.mediabox
                if not 0 < float(box.width) <= 14_400 or not 0 < float(box.height) <= 14_400:
                    raise ExtractionFailure("invalid_pdf", "This PDF has an unsupported page size.")
            return declared_type, {"page_count": count}
        except ExtractionFailure:
            raise
        except Exception:
            raise ExtractionFailure("invalid_pdf", "This PDF could not be read. Export a fresh copy or use manual text.") from None
    if declared_type in {"image/png", "image/jpeg"}:
        try:
            from PIL import Image
        except ImportError:
            raise ExtractionFailure("image_unavailable", "Image reading is unavailable here. Add readable text or ask the workspace owner for help.") from None
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(content)) as image:
                    expected = "PNG" if declared_type == "image/png" else "JPEG"
                    if image.format != expected:
                        raise ExtractionFailure("media_mismatch", "The file contents do not match its declared image type.")
                    width, height = image.size
                    if width < 1 or height < 1 or width * height > MAX_IMAGE_PIXELS:
                        raise ExtractionFailure("image_too_large", "Choose an image with at most 25 million pixels.")
                    if getattr(image, "n_frames", 1) != 1:
                        raise ExtractionFailure("animated_image", "Upload a still image or a multi-page PDF.")
                    image.verify()
                    return declared_type, {"page_count": 1, "width": width, "height": height}
        except ExtractionFailure:
            raise
        except Exception:
            raise ExtractionFailure("invalid_image", "This image could not be verified. Export it again as PNG or JPEG.") from None
    raise ExtractionFailure("unsupported_media", "Choose PDF, PNG, JPEG, or UTF-8 plain text.")


def _limited_read(path: Path, maximum: int = MAX_TEXT_CHARACTERS * 4) -> str:
    with path.open("rb") as handle:
        content = handle.read(maximum + 1)
    if len(content) > maximum:
        raise ExtractionFailure("extraction_too_large", "The extracted text exceeds the processing limit. Enter the relevant text manually.")
    return content.decode("utf-8", errors="replace")


def _run_local(command: list[str], seconds: int = 35) -> None:
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=seconds, check=False,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired:
        raise ExtractionFailure("ocr_timeout", "Local OCR took too long. Add a clearer image or enter the relevant text manually.") from None
    except OSError:
        raise ExtractionFailure("ocr_unavailable", "The configured local OCR tool could not start. Enter the relevant text manually.") from None
    if result.returncode:
        raise ExtractionFailure("ocr_failed", "Local OCR could not read this document. Enter the relevant text manually.")


def _ocr_image(path: Path, temporary: Path, page: int) -> str:
    executable = shutil.which("tesseract")
    if not executable:
        raise ExtractionFailure("ocr_unavailable", "Local OCR is not installed. Enter a transcription to continue.")
    output = temporary / f"page-{page}"
    # No remote processor is called. Tesseract uses its installed language data.
    _run_local([executable, str(path), str(output), "--psm", "3"])
    return _limited_read(output.with_suffix(".txt"))


def _read_pages(content: bytes, media_type: str, original_path: Path,
                manual_text: str | None) -> tuple[list[str], str, list[str]]:
    if manual_text is not None:
        return manual_text.split("\f"), "manual_transcription", [
            "Source locations refer to the supplied transcription. Compare it with the unchanged original before confirming values."
        ]
    if media_type == "text/plain":
        return content.decode("utf-8-sig").split("\f"), "utf8_text", []
    if media_type == "application/pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(BytesIO(content), strict=True)
            if reader.is_encrypted or not 1 <= len(reader.pages) <= MAX_PAGES:
                raise ExtractionFailure("pdf_unreadable", "Use an unlocked PDF of at most 25 pages, or enter manual text.")
            pages = []
            for page in reader.pages:
                # Avoid expanding exceptionally large content streams for extraction.
                contents = page.get("/Contents")
                streams = contents.get_object() if contents is not None else []
                streams = streams if isinstance(streams, list) else [streams]
                for stream in streams:
                    stream = stream.get_object()
                    if hasattr(stream, "get") and stream.get("/Length", 0) > 2_000_000:
                        raise ExtractionFailure("pdf_stream_too_large", "This PDF page is too complex for local extraction. Enter the relevant text manually.")
                pages.append(page.extract_text() or "")
                if sum(map(len, pages)) > MAX_TEXT_CHARACTERS:
                    raise ExtractionFailure("extraction_too_large", "The extracted text exceeds the processing limit. Enter only the relevant text manually.")
        except ExtractionFailure:
            raise
        except Exception:
            raise ExtractionFailure("pdf_extraction_failed", "PDF text could not be extracted. Enter the relevant text manually.") from None
        if all(page.strip() for page in pages):
            return pages, "pdf_text", []
        # Mixed/scanned PDFs retain each original page number during local OCR.
        rasterizer = shutil.which("pdftoppm")
        if not rasterizer or not shutil.which("tesseract"):
            return pages, "pdf_text", [
                "Some pages contain no readable text. Enter the text you can read from those pages to continue."
            ]
        with tempfile.TemporaryDirectory(prefix="ff-ocr-") as directory:
            temporary = Path(directory)
            for index, text in enumerate(pages):
                if text.strip():
                    continue
                page_number = index + 1
                stem = temporary / f"scan-{page_number}"
                _run_local([rasterizer, "-f", str(page_number), "-l", str(page_number),
                            "-scale-to", "2400", "-singlefile", "-png", str(original_path), str(stem)])
                pages[index] = _ocr_image(stem.with_suffix(".png"), temporary, page_number)
            return pages, "pdf_text_and_local_ocr", ["OCR text may contain mistakes. Compare every suggested value with its source."]
    if media_type in {"image/png", "image/jpeg"}:
        with tempfile.TemporaryDirectory(prefix="ff-ocr-") as directory:
            return [_ocr_image(original_path, Path(directory), 1)], "local_tesseract", [
                "OCR text may contain mistakes. Compare every suggested value with its source."
            ]
    raise ExtractionFailure("unsupported_media", "Enter a manual transcription for this document.")


def extract_proposals(content: bytes, media_type: str, original_path: Path,
                      document_id: str, manual_text: str | None = None,
                      document_type: str | None = None) -> dict:
    """Return bounded, source-linked proposals; never infer an effective legal date."""
    warnings_list: list[str] = []
    try:
        pages, adapter, warnings_list = _read_pages(content, media_type, original_path, manual_text)
        if len(pages) > MAX_PAGES or sum(map(len, pages)) > MAX_TEXT_CHARACTERS:
            raise ExtractionFailure("extraction_too_large", "Use at most 25 pages and 250,000 characters per extraction.")
        indexed = []
        lines = []
        for page_number, text in enumerate(pages, start=1):
            page_lines = []
            for line_number, line in enumerate(text.splitlines(), start=1):
                if len(line) > MAX_LINE_CHARACTERS or len(lines) >= MAX_LINES:
                    raise ExtractionFailure("extraction_too_large", "This text has too many or overly long lines. Enter the relevant passage manually.")
                if any(ord(c) < 32 and c not in "\t" for c in line):
                    raise ExtractionFailure("invalid_text", "The extracted text contains unreadable control characters. Enter a manual transcription.")
                source = {"document_id": document_id, "source_kind": adapter,
                          "page": page_number, "line_start": line_number,
                          "line_end": line_number, "quote": line}
                page_lines.append({"line": line_number, "text": line})
                lines.append((line, source))
            indexed.append({"page": page_number, "lines": page_lines})
        visible = [(line, source) for line, source in lines if line.strip()]
        if not visible:
            return {"status": "needs_manual_input", "adapter": adapter, "document_type": document_type or "unknown",
                    "pages": indexed, "fields": [], "uncertain_fields": [{"key": "document", "reason": "No readable text was found."}],
                    "warnings": warnings_list, "review_status": "proposed"}
        combined = "\n".join(line for line, _ in visible).lower()
        receipt_markers = re.search(r"\b(invoice|receipt|rechnung|quittung|factuur|facture|tva|vat|mwst)\b", combined)
        kind = document_type if document_type and document_type != "unknown" else ("receipt" if receipt_markers else "unknown")
        fields = []
        uncertain = []

        def suggest(key: str, label: str, value, source: dict):
            identifier = hashlib.sha256(json.dumps([document_id, key, value, source], sort_keys=True).encode()).hexdigest()[:24]
            fields.append({"id": identifier, "key": key, "label": label, "value": value, "review_status": "proposed",
                           "confidence": "uncertain", "sources": [source]})

        first_line, first_source = visible[0]
        suggest("title", "Document title", first_line.strip(), first_source)
        patterns = {
            "date_text": ("Printed date", r"(?:date|datum|dated)\s*[:\-]\s*(.+)"),
            "reference": ("Printed reference", r"(?:reference|ref\.?|invoice\s*(?:no\.?|number)|rechnungsnummer|factuurnummer)\s*[:#\-]\s*(.+)"),
        }
        if kind == "receipt":
            patterns.update({
                "merchant": ("Supplier", r"(?:supplier|merchant|vendor|lieferant|fournisseur|leverancier)\s*[:\-]\s*(.+)"),
                "buyer": ("Buyer or customer named in the document", r"(?:buyer|customer|sold\s+to|bill\s+to|k[aä]ufer|kunde|acheteur|client|koper|klant)\s*[:\-]\s*(.+)"),
                "total_text": ("Printed total", r"(?:grand\s+total|total(?:\s+(?:due|ttc))?|gesamt(?:betrag)?|totaal)\s*[:\-]?\s*((?:[-+]?\d|€|£|EUR|USD).*)"),
                "tax_text": ("Supplied tax", r"(?:vat|mwst\.?|tva|btw|tax)\s*[:\-]?\s*((?:[-+]?\d|€|£|EUR|USD).*)"),
                "tax_rate_text": ("Printed tax rate", r"(?:vat\s+rate|tax\s+rate|mwst\.?\s*satz|steuersatz|taux\s+(?:de\s+)?tva|btw[-\s]?tarief)\s*[:\-]\s*(.+)"),
                "quantity_text": ("Printed quantity", r"(?:quantity|qty\.?|menge|quantit[eé]|aantal)\s*[:\-]\s*(.+)"),
                "unit_text": ("Printed unit", r"(?:unit|einheit|unit[eé]|eenheid)\s*[:\-]\s*(.+)"),
            })
        elif kind == "letter":
            patterns.update({
                "recipient": ("Where an answer should be sent", r"(?:reply\s+to|send\s+(?:the\s+)?(?:response|answer)\s+to|antwort\s+an|r[eé]pondre\s+[aà]|antwoord\s+naar)\s*[:\-]\s*(.+)"),
                "addressee_text": ("Who the letter is addressed to", r"(?:recipient|addressed\s+to|empf[aä]nger|destinataire|ontvanger)\s*[:\-]\s*(.+)"),
                "deadline_text": ("Printed deadline, requires review", r"(?:deadline|due\s+by|reply\s+by|frist|date\s+limite|uiterlijk)\s*[:\-]?\s*(.+)"),
                "reporting_period_text": ("Printed reporting period", r"(?:reporting\s+(?:period|year)|berichts(?:jahr|zeitraum)|p[eé]riode|verslagjaar)\s*[:\-]\s*(.+)"),
            })
        elif kind == "notebook":
            patterns.update({
                "operation_type": ("Recorded work", r"(?:activity|operation|work|t[aä]tigkeit|arbeit|activit[eé]|werk)\s*[:\-]\s*(.+)"),
                "product": ("Recorded product", r"(?:product|produkt|produit|middel)\s*[:\-]\s*(.+)"),
                "parcel": ("Recorded field or parcel", r"(?:parcel|field|schlag|parcelle|perceel)\s*[:\-]\s*(.+)"),
                "quantity_text": ("Recorded quantity", r"(?:quantity|qty\.?|menge|quantit[eé]|aantal)\s*[:\-]\s*(.+)"),
                "unit_text": ("Recorded unit", r"(?:unit|einheit|unit[eé]|eenheid)\s*[:\-]\s*(.+)"),
                "hours_text": ("Recorded work hours", r"(?:hours|stunden|heures|uren)\s*[:\-]\s*(.+)"),
            })
        for key, (label, pattern) in patterns.items():
            matches = []
            for line, source in visible:
                match = re.search(r"\b" + pattern, line, re.IGNORECASE)
                if match:
                    matches.append((match.group(1).strip(), source))
            for value, source in matches[:20]:
                suggest(key, label, value, source)
            if not matches:
                uncertain.append({"key": key, "reason": "No explicitly labelled value was readable. Enter or confirm it manually."})
            elif len({value for value, _ in matches}) > 1:
                uncertain.append({"key": key, "reason": "Several different printed values were found. Select the applicable one explicitly."})
        if kind == "receipt":
            currencies = [(line, source) for line, source in visible if re.search(r"\b(?:EUR|USD|GBP|CHF|PLN|SEK|DKK|CZK|HUF|RON|BGN)\b|€|£", line)]
            for line, source in currencies[:10]:
                for currency in sorted(set(re.findall(r"\b(?:EUR|USD|GBP|CHF|PLN|SEK|DKK|CZK|HUF|RON|BGN)\b|€|£", line))):
                    suggest("currency_text", "Printed currency", currency, source)
            if not currencies:
                uncertain.append({"key": "currency_text", "reason": "No currency was readable; none has been assumed."})
            uncertain.append({"key": "category", "reason": "Choose a ledger category after reviewing what the document describes."})
            uncertain.append({"key": "transaction_direction", "reason": "Choose explicitly whether you bought something or sold something. An invoice heading or printed buyer and supplier names do not establish its direction for this farm."})
            warnings_list.append("Choose whether this document supports a purchase or a sale before saving a financial record. Tax amounts and rates are printed suggestions; nothing has been calculated.")
        if kind == "letter":
            for line, source in visible:
                if re.search(r"\b(?:please\s+(?:provide|submit|send|correct)|required\s+documents|bitte\s+(?:reichen|senden|korrigieren)|veuillez|gelieve)\b", line, re.IGNORECASE):
                    suggest("requirement_text", "Printed requested action", line.strip(), source)
                    if sum(field["key"] == "requirement_text" for field in fields) >= 50:
                        break
            uncertain.append({"key": "legal_deadline", "reason": "No legal or calculated deadline is established by extraction. Confirm the applicable date manually using reviewed guidance."})
        return {"status": "proposed", "adapter": adapter, "document_type": kind,
                "pages": indexed, "fields": fields, "uncertain_fields": uncertain,
                "warnings": warnings_list, "review_status": "proposed",
                **({"transaction_direction": "unreviewed"} if kind == "receipt" else {}),
                "extracted_at": datetime.now(timezone.utc).isoformat()}
    except ExtractionFailure as exc:
        return {"status": "needs_manual_input", "adapter": "manual_transcription" if manual_text is not None else "local",
                "document_type": document_type or "unknown", "pages": [], "fields": [],
                "uncertain_fields": [{"key": "document", "reason": exc.message}],
                "warnings": warnings_list, "review_status": "proposed",
                "failure": {"code": exc.code, "message": exc.message}}
