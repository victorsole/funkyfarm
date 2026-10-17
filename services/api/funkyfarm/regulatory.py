"""Scheduled public-source observations with tenant-scoped relevance/read state.

Shared state and events contain only catalogue source IDs, public URLs, dates,
HTTP metadata and hashes. No farm context is sent to publishers or shared tables.
"""

import asyncio
from contextlib import suppress
from datetime import date, datetime, timedelta, timezone
from difflib import SequenceMatcher
import logging
import os
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Query
from pydantic import Field
from psycopg.types.json import Jsonb

from .db import auth_transaction, fetch_record, idempotent, insert_record, json_safe, transaction, update_record
from .models import ApiError, StrictModel
from .regulatory_sources import MAX_SOURCES, SourceObservation, WORKFLOWS, allowed_source_url, fetch_source, source_catalog
from .security import Session, require_roles, require_session

router = APIRouter(prefix="/regulatory", tags=["regulatory source observations"])
logger = logging.getLogger("funkyfarm.regulatory")
NOTICE = "An official page changed, not necessarily a legal rule. Review the source and its applicability with a qualified adviser. No rule, deadline or effective date was automatically updated."


class PreferencesInput(StrictModel):
    farm_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    enabled: bool = True
    families: list[str] = Field(default_factory=list, max_length=6)
    read_event_ids: list[UUID] = Field(default_factory=list, max_length=500)


def worker_enabled():
    return os.environ.get("FUNKYFARM_REGULATORY_MONITOR_ENABLED", "false").lower() == "true"


def _interval():
    try:
        return max(900, min(86400, int(os.environ.get("FUNKYFARM_REGULATORY_POLL_SECONDS", "21600"))))
    except ValueError:
        return 21600


def _source_interval(source):
    return source.get("poll_interval_seconds") or _interval()


def _synchronise(conn, sources):
    for source in sources:
        # URL changes reset the baseline rather than pretending a new page is a rule change.
        conn.execute("INSERT INTO regulatory_source_state(source_id,url,next_check_at) VALUES(%s,%s,now()) "
                     "ON CONFLICT(source_id) DO UPDATE SET url=EXCLUDED.url,etag=NULL,last_modified=NULL,content_hash=NULL,observed_text=NULL,text_truncated=false,last_checked_at=NULL,last_successful_at=NULL,next_check_at=now(),lease_until=NULL,last_status='source_changed',last_http_status=NULL,failure_count=0 "
                     "WHERE regulatory_source_state.url<>EXCLUDED.url", (source["id"], source["url"]))


def _claim_due(conn, sources, limit):
    if not sources:
        return []
    rows = conn.execute("WITH due AS (SELECT source_id FROM regulatory_source_state WHERE source_id=ANY(%s::text[]) AND next_check_at<=now() "
                        "AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_check_at,source_id LIMIT %s FOR UPDATE SKIP LOCKED) "
                        "UPDATE regulatory_source_state s SET lease_until=now()+interval '2 minutes' FROM due WHERE s.source_id=due.source_id RETURNING s.*",
                        ([source["id"] for source in sources], limit)).fetchall()
    return rows


def _retain_observation(conn, source, claimed, observation: SourceObservation):
    row = conn.execute("SELECT * FROM regulatory_source_state WHERE source_id=%s FOR UPDATE", (source["id"],)).fetchone()
    # A later claim or catalogue URL reset must not be overwritten by a slow worker.
    if not row or row["url"] != source["url"] or row["lease_until"] != claimed["lease_until"]:
        return "superseded"
    stamp = datetime.now(timezone.utc)
    content_hash = row["content_hash"]
    good = observation.status == "observed" and observation.content_hash is not None
    unchanged = observation.status == "not_modified" and bool(content_hash)
    if good:
        status = "baseline_created" if not content_hash else "changed" if content_hash != observation.content_hash else "unchanged"
        if status == "changed":
            conn.execute("INSERT INTO regulatory_source_events(id,source_id,source_url,detected_at,previous_hash,current_hash,previous_text,current_text,previous_text_truncated,current_text_truncated,event_type) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'official_page_changed') ON CONFLICT DO NOTHING", (uuid4(), source["id"], source["url"], stamp, content_hash, observation.content_hash, row["observed_text"], observation.readable_text, row["text_truncated"], observation.text_truncated))
        content_hash = observation.content_hash
    else:
        status = "unchanged" if unchanged else "invalid_not_modified" if observation.status == "not_modified" else observation.status
    failures = 0 if good or unchanged else min(row["failure_count"] + 1, 10)
    delay = min(86400, _source_interval(source) * (2 ** min(failures, 4)))
    conn.execute("UPDATE regulatory_source_state SET content_hash=%s,observed_text=%s,text_truncated=%s,etag=%s,last_modified=%s,last_checked_at=%s,last_successful_at=%s,next_check_at=%s,lease_until=NULL,last_status=%s,last_http_status=%s,failure_count=%s WHERE source_id=%s", (
        content_hash, observation.readable_text if good else row["observed_text"], observation.text_truncated if good else row["text_truncated"],
        observation.etag if good or unchanged else row["etag"], observation.last_modified if good or unchanged else row["last_modified"], stamp,
        stamp if good or unchanged else row["last_successful_at"], stamp + timedelta(seconds=delay), status, observation.http_status, failures, source["id"]))
    return status


def poll_due(limit=4, *, sources=None):
    """Worker-only batch; no session, arbitrary URL, tenant, or farm arguments.

    PostgreSQL leases deduplicate concurrent application processes. A crash leaves
    a recoverable lease; no network request is made inside a database transaction.
    """
    # Internal dependency injection supports isolated provider-boundary checks;
    # no route, assistant tool or user input can supply this argument.
    sources = source_catalog() if sources is None else list(sources)
    if len(sources) > MAX_SOURCES or any(not isinstance(source, dict) or not isinstance(source.get("id"), str) or not 1 <= len(source["id"]) <= 160 or not allowed_source_url(source.get("url")) for source in sources):
        raise ValueError("Observer sources must remain bounded and officially allowlisted")
    with auth_transaction() as conn:
        _synchronise(conn, sources)
        claimed = _claim_due(conn, sources, max(1, min(4, int(limit))))
    by_id = {source["id"]: source for source in sources}
    outcomes = []
    for claim in claimed:
        source = by_id[claim["source_id"]]
        # An older hash-only baseline needs one complete successful response;
        # an unverified old attempt cannot establish a success date or text.
        observation = fetch_source(source, claim["etag"] if claim["last_successful_at"] else None, claim["last_modified"] if claim["last_successful_at"] else None)
        with auth_transaction() as conn:
            status = _retain_observation(conn, source, claim, observation)
        outcomes.append({"source_id": source["id"], "status": status})
    return {"checked": len(outcomes), "items": outcomes}


async def _worker():
    while True:
        try:
            # A single bounded batch runs in a thread, never blocking the event loop.
            await asyncio.to_thread(poll_due, 4)
        except asyncio.CancelledError:
            raise
        except Exception:
            # No private context or response content enters these operator logs.
            logger.exception("Regulatory observer batch failed; no legal rules were updated")
        await asyncio.sleep(30)


def start_regulatory_worker():
    return asyncio.create_task(_worker(), name="official-source-observer") if worker_enabled() else None


async def stop_regulatory_worker(task):
    if task is not None:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


def _preferences(conn, farm_id, actor_id):
    row = conn.execute("SELECT id FROM records WHERE kind='regulatory_preferences' AND data->>'farm_id'=%s AND data->>'actor_id'=%s AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1", (str(farm_id), str(actor_id))).fetchone()
    return fetch_record(conn, "regulatory_preferences", row["id"]) if row else None


def _actor(conn):
    return conn.execute("SELECT current_setting('app.user_id') AS actor").fetchone()["actor"]


def _profile_relevance(source, farm, facts, operations):
    """Use the compliance evaluator; uncertainty never hides a source notice."""
    rules = source.get("rules", [])
    if not rules:
        return "country_workflow_match_profile_unreviewed"
    if len(facts) > 10000 or len(operations) > 10000:
        return "possibly_relevant_profile_incomplete"
    try:
        from .compliance import rule_applicability
    except ImportError:
        return "possibly_relevant_profile_incomplete"
    year = farm["data"].get("reporting_year")
    if not isinstance(year, int):
        return "possibly_relevant_profile_incomplete"
    statuses = [rule_applicability(rule, farm, facts, operations, year)["status"] for rule in rules]
    return "profile_match_review_required" if "applies" in statuses else "profile_not_matched" if statuses and all(status == "does_not_apply" for status in statuses) else "possibly_relevant_profile_incomplete"


def _farm_sources(conn, farm, families=()):
    farm_id = farm["id"]
    facts = json_safe(conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE kind='facts' AND data->>'farm_id'=%s AND deleted_at IS NULL LIMIT 10001", (str(farm_id),)).fetchall())
    operations = json_safe(conn.execute("SELECT id,kind,workspace_id,revision,data,created_at,updated_at FROM records WHERE kind='operations' AND data->>'farm_id'=%s AND deleted_at IS NULL LIMIT 10001", (str(farm_id),)).fetchall())
    sources, relevance = [], {}
    for source in source_catalog():
        if source.get("country") not in (None, "EU", farm["data"].get("country")):
            continue
        if source.get("region") and farm["data"].get("region") and source["region"] != farm["data"]["region"]:
            continue
        if families and not set(families) & set(source["workflow_ids"]):
            continue
        relevant = _profile_relevance(source, farm, facts, operations)
        if source.get("region") and not farm["data"].get("region"):
            relevant = "possibly_relevant_region_unknown"
        if relevant != "profile_not_matched":
            sources.append(source)
            relevance[source["id"]] = relevant
    return sources, relevance


def source_checks(conn, sources):
    """Public publisher status only; callers separately authorize farm context."""
    ids = [source["id"] for source in sources]
    states = conn.execute("SELECT source_id,url,content_hash,last_checked_at,last_successful_at,next_check_at,last_status,last_http_status,failure_count FROM regulatory_source_state WHERE source_id=ANY(%s::text[])", (ids,)).fetchall() if ids else []
    current_urls = {source["id"]: source["url"] for source in sources}
    states = [state for state in states if state["url"] == current_urls[state["source_id"]]]
    state_map = {state["source_id"]: state for state in states}
    now = datetime.now(timezone.utc)
    result = []
    for source in sources:
        state = state_map.get(source["id"], {})
        success = state.get("last_successful_at")
        freshness = "failed" if state.get("failure_count", 0) else "never_checked" if not success else "stale" if now - success > timedelta(seconds=_source_interval(source) * 2) else "current"
        result.append({"source_id": source["id"], "title": source["title"], "url": source["url"], "status": state.get("last_status") or "pending_baseline", "http_status": state.get("last_http_status"), "baseline_exists": bool(state.get("content_hash")), "last_checked_at": json_safe(state.get("last_checked_at")), "last_successful_at": json_safe(success), "next_check_at": json_safe(state.get("next_check_at")), "freshness": freshness, "poll_interval_seconds": _source_interval(source)})
    return result


def regulatory_updates(conn, farm_id, limit=50, offset=0, family=None):
    farm = fetch_record(conn, "farms", str(farm_id))
    preference = _preferences(conn, farm_id, _actor(conn))
    prefs = preference["data"] if preference else {"enabled": True, "families": [], "read_event_ids": []}
    sources, relevance = _farm_sources(conn, farm, [family] if family else prefs.get("families", []))
    ids = [source["id"] for source in sources]
    checks = source_checks(conn, sources)
    monitor = {"enabled": worker_enabled(), "source_count": len(sources), "checked_count": sum(bool(row["last_checked_at"]) for row in checks), "baseline_count": sum(row["baseline_exists"] for row in checks), "pending_count": sum(not row["last_checked_at"] for row in checks), "error_count": sum(row["freshness"] == "failed" for row in checks), "current_count": sum(row["freshness"] == "current" for row in checks), "stale_count": sum(row["freshness"] == "stale" for row in checks), "last_checked_at": max((row["last_checked_at"] for row in checks if row["last_checked_at"]), default=None), "last_successful_at": max((row["last_successful_at"] for row in checks if row["last_successful_at"]), default=None), "poll_interval_seconds": _interval(), "meaning": "Success means the public page was retrieved, not that its legal meaning was reviewed. Pinned historical texts do not discover all newly published amendments."}
    result = {"items": [], "total": 0, "unread_count": 0, "limit": limit, "offset": offset, "preferences": {"id": preference["id"] if preference else None, "revision": preference["revision"] if preference else 0, "enabled": prefs["enabled"], "families": prefs.get("families", []), "read_event_ids": prefs.get("read_event_ids", [])}, "monitor": monitor, "source_checks": checks, "notice": NOTICE}
    if not ids or not prefs.get("enabled", True):
        return result
    read_ids = prefs.get("read_event_ids", [])
    pairs = Jsonb([{"source_id": source["id"], "source_url": source["url"]} for source in sources])
    where = "(source_id,source_url) IN (SELECT s.source_id,s.source_url FROM jsonb_to_recordset(%s::jsonb) AS s(source_id text,source_url text))"
    totals = conn.execute(f"SELECT count(*) AS total,count(*) FILTER(WHERE NOT(id::text=ANY(%s::text[]))) AS unread FROM regulatory_source_events WHERE {where}", (read_ids, pairs)).fetchone()
    rows = conn.execute(f"SELECT id,source_id,source_url,detected_at,event_type FROM regulatory_source_events WHERE {where} ORDER BY detected_at DESC,id DESC LIMIT %s OFFSET %s", (pairs, limit, offset)).fetchall()
    source_map = {source["id"]: source for source in sources}
    for row in rows:
        source = source_map[row["source_id"]]
        result["items"].append({**_public_event(row, source, relevance[source["id"]]), "is_read": str(row["id"]) in read_ids})
    reviews = _reviews(conn, farm["id"], [item["id"] for item in result["items"]])
    for item in result["items"]:
        item["review"] = reviews.get(item["id"])
    result.update(total=totals["total"], unread_count=totals["unread"])
    return result


def _public_event(row, source, relevance):
    return {"id": str(row["id"]), "source_id": source["id"], "title": source["title"], "url": source["url"], "country": source["country"], "region": source["region"], "families": source["workflow_ids"], "detected_at": json_safe(row["detected_at"]), "status": "official_page_changed", "effective_date": None, "review_status": "unreviewed_observation", "source_edition": source["source_edition"], "catalog_checked_at": source["catalog_checked_at"], "required_action": "Read what changed, check whether it affects this farm, and save any work you need to do.", "relevance": relevance, "rule_ids": source["rule_ids"], "notice": NOTICE}


def _reviews(conn, farm_id, event_ids):
    if not event_ids:
        return {}
    rows = conn.execute("SELECT id FROM records WHERE kind='regulatory_reviews' AND deleted_at IS NULL AND data->>'farm_id'=%s AND data->>'event_id'=ANY(%s::text[])", (str(farm_id), event_ids)).fetchall()
    reviews = [fetch_record(conn, "regulatory_reviews", row["id"]) for row in rows]
    return {review["data"]["event_id"]: review for review in reviews}


@router.get("/updates")
def updates(farm_id: UUID, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0), family: str | None = Query(None, max_length=32), session: Session = Depends(require_session)):
    if family and family not in WORKFLOWS:
        raise ApiError(422, "invalid_family", "Choose a supported update topic.")
    with transaction(session) as conn:
        return regulatory_updates(conn, farm_id, limit, offset, family)


def _farm_event(conn, farm_id, event_id):
    farm = fetch_record(conn, "farms", str(farm_id))
    sources, relevance = _farm_sources(conn, farm)
    row = conn.execute("SELECT * FROM regulatory_source_events WHERE id=%s", (event_id,)).fetchone()
    source = next((source for source in sources if row and source["id"] == row["source_id"] and source["url"] == row["source_url"]), None)
    if source is None:
        raise ApiError(404, "update_not_found", "This update was not found for the selected farm.")
    return farm, source, row, relevance[source["id"]]


def _changed_passages(before, after):
    if before is None or after is None:
        return []
    # Bounded comparisons of plain publisher text, not executable HTML or a
    # generated interpretation. Paragraph counts and output size are capped.
    left, right = before.splitlines()[:300], after.splitlines()[:300]
    passages, remaining = [], 6000
    for operation, a, b, c, d in SequenceMatcher(None, left, right, autojunk=True).get_opcodes():
        if operation == "equal" or remaining <= 0 or len(passages) >= 8:
            continue
        removed = "\n".join(left[a:b])[:min(1500, remaining)]
        remaining -= len(removed)
        added = "\n".join(right[c:d])[:min(1500, remaining)]
        remaining -= len(added)
        passages.append({"before": removed, "after": added})
    return passages


def update_detail(conn, farm_id, event_id):
    """Read-only scoped helper for the website and bounded assistant tools."""
    farm, source, row, relevance = _farm_event(conn, farm_id, event_id)
    review = _reviews(conn, farm["id"], [str(row["id"])]).get(str(row["id"]))
    task = None
    if review and review["data"].get("task_id"):
        try:
            task = fetch_record(conn, "tasks", review["data"]["task_id"])
        except ApiError as error:
            if error.status != 404:
                raise
    permission = conn.execute("SELECT record_access(%s,'farms',%s::jsonb,true) AS allowed", (farm["id"], Jsonb(farm["data"]))).fetchone()["allowed"]
    return {"farm_id": farm["id"], "farm_name": farm["data"].get("name"), "event": _public_event(row, source, relevance),
            "source_check": source_checks(conn, [source])[0], "review": review, "task": task, "can_review": permission,
            "comparison": {"available": row["previous_text"] is not None and row["current_text"] is not None,
                "passages": _changed_passages(row["previous_text"], row["current_text"]),
                "before": row["previous_text"], "after": row["current_text"],
                "truncated": row["previous_text_truncated"] or row["current_text_truncated"],
                "meaning": "Extracts of the publisher's page, not a legal interpretation. Read the official source for the complete text."}}


@router.get("/updates/{event_id}")
def get_update(event_id: UUID, farm_id: UUID, session: Session = Depends(require_session)):
    with transaction(session) as conn:
        detail = update_detail(conn, farm_id, event_id)
        detail["can_review"] = detail["can_review"] and session.role in ("owner", "adviser")
        return detail


class UpdateReviewInput(StrictModel):
    farm_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    outcome: Literal["needs_action", "not_relevant", "reviewed"]
    note: str = Field(min_length=10, max_length=4000)
    create_follow_up: bool = False
    due_date: date | None = None


@router.post("/updates/{event_id}/review")
def review_update(event_id: UUID, body: UpdateReviewInput, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    if session.credential_scope == "assistant":
        raise ApiError(403, "human_review_required", "Open the update in the farm workspace to record your review.")
    if len(body.note.strip()) < 10:
        raise ApiError(422, "review_note_required", "Explain what you checked and what this farm needs to do.")
    if (body.create_follow_up or body.due_date) and body.outcome != "needs_action":
        raise ApiError(422, "follow_up_requires_action", "Choose work needed before adding a follow-up or its target date.")
    if body.due_date and not body.create_follow_up:
        raise ApiError(422, "follow_up_required", "Choose to create a follow-up before entering its target date.")
    with transaction(session) as conn:
        farm, source, event, _ = _farm_event(conn, body.farm_id, event_id)
        if not conn.execute("SELECT record_access(%s,'farms',%s::jsonb,true) AS allowed", (farm["id"], Jsonb(farm["data"]))).fetchone()["allowed"]:
            raise ApiError(403, "review_permission_required", "Your access to this farm is read-only.")

        def save():
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.workspace_id')||':source-review:'||%s||':'||%s,0))", (farm["id"], str(event_id)))
            old = _reviews(conn, farm["id"], [str(event_id)]).get(str(event_id))
            if (old["revision"] if old else 0) != body.expected_revision:
                raise ApiError(409, "revision_conflict", "Someone changed this review. Read the saved review before trying again.")
            task_id = old["data"].get("task_id") if old else None
            if body.create_follow_up and not task_id:
                from .records import validate_data
                task = insert_record(conn, "tasks", validate_data(conn, "tasks", {"farm_id": farm["id"], "title": ("Review update: " + source["title"])[:200],
                    "description": body.note.strip(), "status": "open", "due_date": body.due_date.isoformat() if body.due_date else None,
                    "notes": "Source: " + source["url"] + "\nPage change recorded: " + event["detected_at"].isoformat() + "\nFarm review: /app/updates/" + str(event_id) + "?farm_id=" + farm["id"] + "\nAny target date is entered by the reviewer, not a newly verified legal deadline."}))
                task_id = task["id"]
            data = {"farm_id": farm["id"], "event_id": str(event_id), "source_id": source["id"], "source_url": source["url"],
                    "outcome": body.outcome, "note": body.note.strip(), "reviewed_by": session.user_id,
                    "reviewed_at": datetime.now(timezone.utc).isoformat(), "task_id": task_id,
                    "meaning": "A farm member's review, not a certified legal interpretation or a change to approved records."}
            review = update_record(conn, "regulatory_reviews", old["id"], body.expected_revision, data) if old else insert_record(conn, "regulatory_reviews", data)
            return {"review": review, "task_id": task_id, "notice": "Review saved. Your farm records, legal checklists and issued paperwork have not been changed."}

        return idempotent(conn, idempotency_key, "regulatory-review:" + str(body.farm_id) + ":" + str(event_id), body.model_dump(mode="json"), save)


@router.post("/preferences")
def preferences(body: PreferencesInput, session: Session = Depends(require_session), idempotency_key: str | None = Header(default=None, alias="Idempotency-Key")):
    require_roles(session, "owner", "adviser")
    if any(family not in WORKFLOWS for family in body.families):
        raise ApiError(422, "invalid_family", "Choose annual, cap, inputs, inspection, sustainability or funding updates.")
    with transaction(session) as conn:
        fetch_record(conn, "farms", str(body.farm_id))
        return idempotent(conn, idempotency_key, "regulatory-preferences:" + str(body.farm_id), body.model_dump(mode="json"), lambda: _save_preferences(conn, body, session))


def _save_preferences(conn, body, session):
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"regulatory-preference:{session.workspace_id}:{session.user_id}:{body.farm_id}",))
    retained = _preferences(conn, body.farm_id, session.user_id)
    if (retained["revision"] if retained else 0) != body.expected_revision:
        raise ApiError(409, "revision_conflict", "Notification preferences changed. Refresh before saving.")
    # A read marker only records reading. It never acknowledges legal compliance.
    read_ids = sorted({str(item) for item in body.read_event_ids})
    new_read_ids = sorted(set(read_ids) - set(retained["data"].get("read_event_ids", []) if retained else []))
    if new_read_ids:
        farm = fetch_record(conn, "farms", str(body.farm_id))
        sources = [source for source in source_catalog() if source.get("country") in (None, "EU", farm["data"].get("country")) and (not source.get("region") or not farm["data"].get("region") or source["region"] == farm["data"]["region"])]
        pairs = Jsonb([{"source_id": source["id"], "source_url": source["url"]} for source in sources])
        available = conn.execute("SELECT id FROM regulatory_source_events WHERE id=ANY(%s::uuid[]) AND (source_id,source_url) IN (SELECT s.source_id,s.source_url FROM jsonb_to_recordset(%s::jsonb) AS s(source_id text,source_url text))", (new_read_ids, pairs)).fetchall()
        if len(available) != len(new_read_ids):
            raise ApiError(422, "unknown_update", "A selected source observation is not available for this farm's jurisdiction.")
    data = {"farm_id": str(body.farm_id), "actor_id": session.user_id, "enabled": body.enabled, "families": sorted(set(body.families)), "read_event_ids": read_ids, "channel": "in_app_only", "meaning": "Read state only, not legal review or compliance approval."}
    return update_record(conn, "regulatory_preferences", retained["id"], body.expected_revision, data) if retained else insert_record(conn, "regulatory_preferences", data)
