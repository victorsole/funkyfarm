"""Bounded source-derived case answers, not an authority decision or submission."""

from copy import deepcopy
from datetime import date
import hashlib
import json
import re
from typing import Literal
from uuid import UUID

from pydantic import Field, field_validator

from .models import ApiError, StrictModel

MAX_ANSWER_ROWS = 512
MAX_ANSWER_BYTES = 384_000


class DeadlineSource(StrictModel):
    kind: Literal["documents", "requests", "reports", "field_change_proposals", "facts", "operations", "checklists", "tasks"]
    id: UUID
    revision: int = Field(ge=1, strict=True)
    role: Literal["original", "notice"]


class CapContext(StrictModel):
    regime: Literal["ams", "other", "animals", "unknown"] = "unknown"
    filed_on: date | None = None
    national_deadline: date | None = None
    national_deadline_source: DeadlineSource | None = None
    first_instalment_on: date | None = None
    check_announced_on: date | None = None
    check_scope: Literal["affected", "unaffected", "unknown"] = "unknown"
    finding_channel: Literal["ams", "administrative", "outside_monitoring", "unknown"] = "unknown"
    non_monitorable_breach: bool | None = Field(default=None, strict=True)
    fictional: bool = Field(default=False, strict=True)

    @field_validator("filed_on", "national_deadline", "first_instalment_on", "check_announced_on", mode="before")
    @classmethod
    def actual_iso_date(cls, value):
        if value is not None and (not isinstance(value, (str, date)) or isinstance(value, str) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
            raise ValueError("Use an actual ISO calendar date or null when it is unknown.")
        return value


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def validate_cap_context(data):
    context = data.get("cap_context") or {}
    pin = context.get("national_deadline_source")
    if pin and pin not in data.get("references", []):
        raise ApiError(422, "case_deadline_source_required", "Select this deadline source as an original or notice in the same case, with its exact revision.")
    for key in ("filed_on", "check_announced_on"):
        if context.get(key) and date.fromisoformat(context[key]) > date.today():
            raise ApiError(422, "case_actual_date", "Use the actual past or current date, or leave this correction date unknown.", {"field": "cap_context." + key})


def correction_guide(item, records):
    from .cap_rules import evaluate_correction

    data = item["data"]
    context = deepcopy(data.get("cap_context") or {})
    evaluated = deepcopy(context)
    issues = []
    pin = context.get("national_deadline_source")
    if pin:
        record = records.get((pin["kind"], pin["id"]))
        if pin not in data.get("references", []) or not record or record["revision"] != pin["revision"]:
            evaluated["national_deadline_source"] = None
            issues.append({"code": "case_deadline_source_changed", "severity": "warning", "message": "The recorded national deadline source is unavailable or changed. Its date is not established by this guide; check the current original notice."})
    return {"case_id": item["id"], "case_revision": item["revision"], "context": context,
        "evaluated_context": evaluated, "original": {"statement": data.get("original_statement"),
            "reference": data.get("original_reference"), "submitted_at": data.get("original_submitted_at"),
            "source_pins": [deepcopy(pin) for pin in data.get("references", []) if pin["role"] == "original"]},
        "evaluation": evaluate_correction(evaluated), "issues": issues,
        "notice": "The original filing details are statements supplied by a person, not verified authority receipt. Unknown national rules and dates remain unknown. Reviewing answers does not send or permit a submission."}


def _parcel(value):
    return {key: deepcopy(value[key]) for key in ("id", "name", "crop", "greenhouse", "geometry", "point", "external_id", "revision") if key in value}


def answer_review(item, farm, records, bindings, content):
    """Derive values only from authorized records already loaded by the caller."""
    data, rows, answer_bytes = item["data"], [], 0

    def add(identifier, label, value, pins, *, unit=None, period=None, boundary=False, previous=None, has_previous=False):
        nonlocal answer_bytes
        if len(rows) >= MAX_ANSWER_ROWS:
            raise ApiError(413, "case_answer_review_too_large", "This selection has too many answers for one focused review. Prepare a narrower case; no answers were silently omitted.")
        row = {"id": identifier, "label": label, "value": deepcopy(value), "unit": deepcopy(unit),
            "period": deepcopy(period), "source_pins": deepcopy(pins), "review_kind": "boundary" if boundary else "answer"}
        if has_previous:
            row["previous_value"] = deepcopy(previous)
        row["row_hash"] = _hash(row)
        answer_bytes += len(json.dumps(row, ensure_ascii=False, allow_nan=False).encode("utf-8"))
        if answer_bytes > MAX_ANSWER_BYTES:
            raise ApiError(413, "case_answer_review_too_large", "These complete source answers exceed one focused review's retained size. Prepare a narrower case; no values were shortened or silently omitted.")
        rows.append(row)

    for key, label in (("title", "Case title"), ("job_type", "Work being prepared"), ("reporting_year", "App selection year"),
                       ("authority", "Recipient named by you"), ("scheme", "Scheme named by you"), ("deadline", "Recorded deadline"),
                       ("original_statement", "What you say you actually filed"), ("original_reference", "Original filing reference"),
                       ("original_submitted_at", "Recorded original filing date"), ("reason", "What needs correcting or answering")):
        if key in data:
            add("case:" + key, label, data.get(key), [])
    if data.get("cap_context") is not None:
        add("case:cap_context", "Correction dates and scope supplied by you", data["cap_context"], [])
    for entry in data.get("items", []):
        value = {key: deepcopy(entry[key]) for key in ("kind", "title", "description", "due_date", "status") if key in entry}
        if isinstance(entry.get("review"), dict):
            value["review_note"] = entry["review"].get("note")
        add("case:item:" + entry["id"], "Requested record or follow-up: " + entry["title"], value,
            [{"kind": "documents", "id": pin["id"], "revision": pin["revision"]} for pin in entry.get("document_pins", [])])
    farm_pin = [{"kind": "farms", "id": farm["id"], "revision": farm["revision"]}]
    for key, label in (("name", "Farm name"), ("country", "Farm country"), ("region", "Farm region")):
        if key in farm["data"]:
            add("farm:" + key, label, farm["data"][key], farm_pin)
    parcels = farm["data"].get("parcels", [])
    if parcels:
        add("farm:boundaries", "Current private farm fields — review the map as a whole", {"parcels": [_parcel(parcel) for parcel in parcels]}, farm_pin, boundary=True)
    seen = set()
    for reference in data.get("references", []):
        key = (reference["kind"], reference["id"])
        if key in seen:
            continue
        seen.add(key)
        record = records.get(key)
        if not record:
            continue  # Existing case checks block unavailable references.
        value = record["data"]
        pin = [{**reference, "revision": record["revision"]}]
        prefix = reference["kind"] + ":" + record["id"]
        if reference["kind"] == "facts":
            add(prefix, str(value.get("label") or value.get("key") or "Selected farm answer"), value.get("value"), pin, unit=value.get("unit"), period=value.get("period"))
        elif reference["kind"] == "field_change_proposals":
            current = value.get("parcels", [value["parcel"]] if value.get("parcel") else [])
            previous = value.get("previous_parcels", [value["previous_parcel"]] if value.get("previous_parcel") else [])
            add(prefix, "Selected private boundary change — compare all before and proposed outlines", {"operation": value.get("operation"), "parcels": [_parcel(parcel) for parcel in current]}, pin,
                boundary=True, previous={"parcels": [_parcel(parcel) for parcel in previous]}, has_previous=bool(previous))
        elif reference["kind"] == "operations":
            # The selected activity can contain country-specific structured
            # answers. Do not silently omit dose, timing or journal fields.
            # Private attachment dependencies remain outside the outward review.
            private = {"sources", "document_id", "source_document_id", "source_documents", "import_id", "import_row_id"}
            add(prefix, str(value.get("title") or "Selected farm activity"), {key: deepcopy(answer) for key, answer in value.items() if key not in private}, pin,
                unit=value.get("unit"), period=value.get("period", value.get("date")))
        elif reference["kind"] == "reports":
            add(prefix, str(value.get("title") or "Selected reviewed report"), {key: deepcopy(value[key]) for key in ("title", "status", "reporting_year", "pack_id", "checksum") if key in value}, pin)
            for index, field in enumerate(value.get("snapshot", {}).get("fields", [])):
                label = str(field.get("label") or field.get("field") or "Retained report answer")
                context = " · ".join(str(field[key]) for key in ("group_label", "entry_id", "actual_date", "physical_group_id") if field.get(key) not in (None, ""))
                add(f"{prefix}:answer:{index}", f"{context} — {label}" if context else label, field.get("value"), pin,
                    unit=field.get("unit"), period=field.get("period"))
        else:
            keys = {"documents": ("filename", "media_type", "sha256"), "requests": ("title", "recipient", "reporting_year", "deadline", "requirements"),
                "tasks": ("title", "description", "due_date", "status", "notes"), "checklists": ("title", "reporting_year", "items")}[reference["kind"]]
            add(prefix, str(value.get("title") or value.get("filename") or reference["kind"]), {key: deepcopy(value[key]) for key in keys if key in value}, pin, period=value.get("period", value.get("date")))
    clean_content = {key: value for key, value in content.items() if key != "answer_review"}
    fingerprint = _hash({"case_id": item["id"], "content": clean_content, "bindings": bindings, "rows": rows})
    saved = data.get("answer_review") or {}
    checks = saved.get("checks", {}) if saved.get("fingerprint") == fingerprint else {}
    for row in rows:
        check = checks.get(row["id"], {})
        row["checked"] = check.get("row_hash") == row["row_hash"]
        if row["checked"]:
            row["check"] = deepcopy(check)
    if len(json.dumps(rows, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_ANSWER_BYTES:
        raise ApiError(413, "case_answer_review_too_large", "These complete source answers exceed one focused review's retained size. Prepare a narrower case; no values were shortened or silently omitted.")
    return {"case_id": item["id"], "case_revision": item["revision"], "fingerprint": fingerprint, "items": rows,
        "total": len(rows), "checked_count": sum(row["checked"] for row in rows), "all_checked": bool(rows) and all(row["checked"] for row in rows),
        "notice": "Check each actual answer and the whole boundary map yourself. These checks confirm only your review of the retained app values, not authority acceptance or permission to send."}


def answer_page(result, limit=5, offset=0):
    # Whole items only, with the same compact binding on every page.
    page = {key: deepcopy(value) for key, value in result.items() if key != "items"}
    items = result["items"][offset:offset + limit]
    page.update(items=deepcopy(items), limit=limit, offset=offset,
        next_offset=offset + len(items) if offset + len(items) < result["total"] else None)
    return page
