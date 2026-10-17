"""Explicit fictional training workspaces. Starting again never erases history."""

from collections import Counter
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Response
from psycopg import Error as DatabaseError
from pydantic import Field

from .admin_cases import AddItem, CreateCase, _audit, _checks, _save, create_case_draft
from .db import fetch_record, insert_record, transaction, update_record
from .documents import _atomic_original, _original_path, _remove_uncommitted
from .extraction import validate_original
from .fields import Proposal, create_proposal_in_transaction, validate_geometry
from .models import ApiError, StrictModel
from .records import COLLECTIONS, validate_data
from .reporting import CreateReport, _prepare
from .security import Session, require_roles, require_session


router = APIRouter(prefix="/examples/workspace", tags=["fictional demo workspaces"])
FIXTURE_ID = "lpis-correction-2026-v1"
FIXTURE_PATH = Path(__file__).resolve().parents[3] / "shared" / "demo-scenarios.json"
NOTICE = "Demo workspace. Your sample records are saved here. Starting again keeps this workspace and opens a new one."
KINDS = COLLECTIONS | {"document", "documents", "admin_cases", "field_change_proposals", "reports"}


class StartDemo(StrictModel):
    fixture_id: str = Field(min_length=1, max_length=100)
    acknowledged: bool = Field(strict=True)


class StartAgain(StrictModel):
    expected_revision: int = Field(ge=1, strict=True)
    acknowledged: bool = Field(strict=True)


def _fail(message, code="demo_fixture_invalid", status=422):
    raise ApiError(status, code, message)


def _human(session, *, owner=False):
    if session.credential_scope != "interactive":
        _fail("Open the signed-in application to use fictional workspaces.", "interactive_session_required", 403)
    if owner:
        require_roles(session, "owner")


def _key(value):
    if value is None:
        _fail("Keep a stable Idempotency-Key so retrying cannot create another workspace.", "idempotency_key_required", 400)
    if not 16 <= len(value) <= 200 or any(not 33 <= ord(char) <= 126 for char in value):
        _fail("Use 16 to 200 printable characters for the retry key.", "invalid_idempotency_key", 400)
    return value


def _fixture(identifier):
    if identifier != FIXTURE_ID:
        _fail("This fictional fixture is not available.", "demo_fixture_not_found", 404)
    if not FIXTURE_PATH.is_file() or FIXTURE_PATH.stat().st_size > 1_000_000:
        _fail("The fictional training fixture is unavailable.", "demo_fixture_unavailable", 503)
    raw = FIXTURE_PATH.read_bytes()
    try:
        fixture = json.loads(raw.decode("utf-8-sig"))
    except (ValueError, UnicodeError):
        _fail("The fictional training fixture could not be read.", "demo_fixture_unavailable", 503)
    scenarios = fixture.get("scenarios", [])
    expected_count = fixture.get("expected_record_count")
    if fixture.get("fixture_id") != identifier or type(fixture.get("version")) is not int or fixture["version"] not in {1, 2, 3} or fixture.get("campaign_year") != 2026 or len(scenarios) != 7 or type(expected_count) is not int or not 20 <= expected_count <= 50:
        _fail("The saved fictional fixture has an unsupported version.", "demo_fixture_unavailable", 503)
    records, aliases = [], set()
    for scenario in scenarios:
        if not isinstance(scenario, dict) or not isinstance(scenario.get("records"), list) or not 1 <= len(scenario["records"]) <= 20:
            _fail("Each training scenario must contain one to twenty authored records.")
        scenario["id"] = scenario.get("key")
        scenario["description"] = scenario.get("summary", "")
        if not isinstance(scenario["id"], str) or not scenario["id"]:
            _fail("Each training scenario needs its stable fixture key.")
        for record in scenario["records"]:
            alias = record.get("alias")
            if not isinstance(alias, str) or not 1 <= len(alias) <= 100 or alias in aliases or record.get("kind") not in KINDS or not isinstance(record.get("data"), dict) or not isinstance(record.get("links", {}), dict):
                _fail("Training record aliases, kinds and links must be distinct and explicit.")
            aliases.add(alias)
            records.append({**deepcopy(record), "scenario_id": scenario["id"]})
    if len(records) != expected_count:
        _fail("The authored business-record count does not match this fixture's explicit total.")
    if sum(record["kind"] in {"document", "documents"} for record in records) > 8:
        _fail("This example can include at most eight small authored text originals.")
    return fixture, records, hashlib.sha256(raw).hexdigest()


def _workspace(conn, identifier):
    memberships = conn.execute("SELECT * FROM workspace_list()").fetchall()
    row = next((item for item in memberships if str(item["id"]) == str(identifier)), None)
    if row is None:
        _fail("This workspace is not available through your actual membership.", "workspace_access_denied", 403)
    return {"id": str(row["id"]), "name": row["name"], "role": row["role"]}


def _reserve(conn, identifier, key):
    try:
        return str(conn.execute("SELECT create_demo_workspace(%s,%s) AS id", (identifier, key)).fetchone()["id"])
    except DatabaseError as exc:
        if exc.sqlstate == "P0001" and exc.diag.message_primary == "demo_workspace_limit":
            _fail("This account has twenty retained fictional runs. Existing examples remain available; no history was removed.", "demo_workspace_limit", 429)
        if exc.sqlstate == "P0001" and exc.diag.message_primary == "idempotency_conflict":
            _fail("This retry key was already used for a different example request.", "idempotency_conflict", 409)
        if exc.sqlstate == "42501":
            _fail("Creating a fictional workspace requires your actual interactive owner access.", "role_required", 403)
        raise


def _dependencies(record):
    result = set()
    for key, value in record.get("links", {}).items():
        if key.endswith("_alias") and isinstance(value, str) and key != "parcel_alias":
            result.add(value)
        elif key in {"fact_aliases", "document_aliases", "operation_aliases", "sources_aliases"}:
            result.update(value)
        elif key == "references_aliases":
            result.update(item["alias"] for item in value)
        elif key == "source_aliases":
            result.update(item["alias"] for item in value)
    return result


def _farm(records, links):
    farm = records.get(links.get("farm_alias"))
    if farm is None or farm["kind"] != "farms":
        _fail("Each linked training record needs its actual authored farm.")
    return farm


def _insert(conn, session, definition, records, parcel_ids, written):
    kind, data, links = definition["kind"], deepcopy(definition["data"]), definition.get("links", {})
    if kind == "farms":
        for parcel in data.get("parcels", []):
            alias = parcel.pop("alias", None)
            if not alias or (definition["alias"], alias) in parcel_ids:
                _fail("Each authored field needs its distinct fixture-only alias.")
            parcel["id"] = str(uuid4())
            parcel_ids[definition["alias"], alias] = parcel["id"]
            parcel["revision"], parcel["active"] = 1, True
            if parcel.get("geometry") is not None:
                parcel["geometry"] = validate_geometry(parcel["geometry"])
        data.setdefault("origin", "fictional_demo")
        data["notes"] = (data.get("notes", "") + "\n" + NOTICE).strip()
        return insert_record(conn, kind, validate_data(conn, kind, data))
    farm = _farm(records, links)
    data["farm_id"] = farm["id"]
    for link, field in (("document_alias", "document_id"), ("request_alias", "request_id"), ("checklist_alias", "checklist_id")):
        if links.get(link):
            data[field] = records[links[link]]["id"]
    if links.get("parcel_alias"):
        parcel_id = parcel_ids.get((links["farm_alias"], links["parcel_alias"]))
        if not parcel_id:
            _fail("This proposed field's fixture alias is unavailable.")
        if kind != "field_change_proposals":
            data["parcel_id"] = parcel_id
    if links.get("sources_aliases"):
        data["sources"] = [{"document_id": records[alias]["id"], "document_revision": records[alias]["revision"]} for alias in links["sources_aliases"]]
    if links.get("source_aliases"):
        sources = []
        for pin in links["source_aliases"]:
            source = records[pin["alias"]]
            if source["kind"] != "documents" or source["data"].get("farm_id") != farm["id"] or not isinstance(pin.get("locator"), str):
                _fail("Each authored source pin needs its actual same-farm document and literal location.")
            sources.append({"document_id": source["id"], "document_revision": source["revision"], "location": pin["locator"], "source_kind": "document"})
        data["sources"] = sources
    if kind in {"document", "documents"}:
        text, filename = data.get("authored_text"), data.get("filename")
        if not isinstance(text, str) or not 1 <= len(text.encode("utf-8")) <= 16_384 or not isinstance(filename, str) or not (filename.startswith("FICTIONAL") or text.startswith("DEMO RECORD")) or len(filename) > 180 or "/" in filename or "\\" in filename or data.get("mime_type") != "text/plain":
            _fail("Example originals must be labelled demo records and use small UTF-8 plain-text files.")
        content = text.encode("utf-8")
        media_type, properties = validate_original(content, "text/plain")
        document = insert_record(conn, "documents", {"farm_id": farm["id"], "filename": filename, "media_type": media_type, "size_bytes": len(content),
            "sha256": hashlib.sha256(content).hexdigest(), "extraction": None, "review_status": "unreviewed", "uploaded_by": session.user_id, **properties})
        path = _original_path(session, document["id"], create=True)
        written.append(path)
        _atomic_original(path, content)
        return document
    if kind == "field_change_proposals":
        data.pop("farm_id")
        if links.get("parcel_alias"):
            data["parcel"]["id"] = parcel_id
        return create_proposal_in_transaction(conn, farm["id"], Proposal(expected_revision=farm["revision"], **data), session)
    if kind == "admin_cases":
        data["references"] = [{"kind": records[reference["alias"]]["kind"], "id": records[reference["alias"]]["id"],
            "revision": records[reference["alias"]]["revision"], "role": reference["role"]} for reference in links.get("references_aliases", [])]
        case = create_case_draft(conn, session, CreateCase(**data))
        for entry in links.get("items", []):
            checked = AddItem(expected_revision=case["revision"], **entry)
            item = {"id": str(uuid4()), **checked.model_dump(mode="json", exclude={"expected_revision"}), "status": "open", "document_pins": []}
            case = _save(conn, case, {**case["data"], "items": [*case["data"]["items"], item], "review": None})
            _audit(conn, case, session, "item_added", item=item)
        return case
    if kind == "reports":
        data["fact_ids"] = [records[alias]["id"] for alias in links.get("fact_aliases", [])]
        data["selected_document_ids"] = [records[alias]["id"] for alias in links.get("document_aliases", [])]
        data["operation_ids"] = [records[alias]["id"] for alias in links.get("operation_aliases", [])]
        return insert_record(conn, "reports", _prepare(conn, CreateReport(**data), session))
    if kind in {"facts", "operations", "purchases", "sales"}:
        if data.get("review_status", "proposed") != "proposed":
            _fail("Training values must start as proposals, never automatic confirmations.")
        data["review_status"] = "proposed"
    return insert_record(conn, kind, validate_data(conn, kind, data))


def _href(kind, identifier, farm_id):
    if kind == "farms":
        return f"/app/fields/{identifier}"
    if kind == "field_change_proposals":
        return f"/app/fields/{farm_id}?proposal_id={identifier}#boundaries-{farm_id}"
    paths = {"admin_cases": "cases", "documents": "documents", "reports": "reports", "requests": "paperwork", "tasks": "tasks"}
    if kind in paths:
        return f"/app/{paths[kind]}/{identifier}"
    if kind == "checklists":
        return f"/app/checks?farm_id={farm_id}"
    return f"/app/record-work?farm_id={farm_id}"


def _view(conn, run_id, session):
    run = fetch_record(conn, "demo_runs", str(run_id))
    data = run["data"]
    if data.get("status") != "ready" or data.get("fixture_id") != FIXTURE_ID:
        _fail("This fictional run is not ready. Retry its original creation request.", "demo_run_unavailable", 409)
    manifest = data.get("records", [])
    if not isinstance(manifest, list) or len(manifest) > 200:
        _fail("The retained fictional run manifest is unavailable.", "demo_run_unavailable", 409)
    ids = [entry["id"] for entry in manifest]
    rows = conn.execute("SELECT id,kind,revision,data->>'farm_id' AS farm_id,coalesce(data->>'title',data->>'name',data->>'label',data->>'filename',kind) AS label,"
        "coalesce(data->>'status',data->>'review_status') AS status FROM records WHERE id=ANY(%s::uuid[]) AND deleted_at IS NULL ORDER BY created_at,id", (ids,)).fetchall()
    visible = {str(row["id"]): row for row in rows}
    retained_by_id = {entry["id"]: entry for entry in manifest}
    summaries = [{"id": str(row["id"]), "kind": row["kind"], "revision": row["revision"], "label": row["label"], "status": row["status"],
        "alias": retained_by_id[str(row["id"])].get("alias"), "scenario_id": retained_by_id[str(row["id"])].get("scenario_id"),
        "farm_id": str(row["id"]) if row["kind"] == "farms" else row["farm_id"], "href": _href(row["kind"], str(row["id"]), row["farm_id"])} for row in rows]
    scenarios = []
    for scenario in data.get("scenarios", []):
        own = [item for item in manifest if item.get("scenario_id") == scenario["id"] and item["id"] in visible]
        if not own:
            continue
        cases, correction_case_ids = [], set()
        for item in own:
            if item["kind"] == "admin_cases":
                case = fetch_record(conn, "admin_cases", item["id"])
                if case["data"].get("job_type") == "correction":
                    correction_case_ids.add(case["id"])
                checked = _checks(conn, case)[0]
                cases.append({"id": case["id"], "revision": case["revision"], "status": case["data"]["status"], "checks": checked,
                    "items": [{key: deepcopy(entry.get(key)) for key in ("id", "kind", "title", "status")} for entry in case["data"]["items"]]})
        starts = [{"title": visible[item["id"]]["label"], "href": _href(item["kind"], item["id"], visible[item["id"]]["farm_id"])}
            for item in own if item["kind"] in {"farms", "admin_cases", "field_change_proposals", "requests"}]
        primary_kind = "farms" if scenario.get("start_page") == "parcels" else "admin_cases"
        primary = next((item for item in own if item["kind"] == primary_kind), own[0])
        primary_start = {"title": visible[primary["id"]]["label"], "href": _href(primary["kind"], primary["id"], visible[primary["id"]]["farm_id"])}
        if scenario.get("start_page") == "parcels" and primary["kind"] == "farms":
            primary_start["href"] = f"/app/fields/{primary['id']}/check?expected_farm_revision={visible[primary['id']]['revision']}&reporting_year=2026"
        elif scenario.get("start_page") == "correction" and primary["id"] in correction_case_ids:
            primary_start["href"] = f"/app/cases/{primary['id']}/correction"
        total_items = sum(len(case["items"]) for case in cases)
        resolved = sum(item["status"] == "resolved" for case in cases for item in case["items"])
        scenarios.append({**scenario, "record_ids": [item["id"] for item in own], "starts": starts, "primary_start": primary_start, "cases": cases,
            "progress": {"total_items": total_items, "resolved_items": resolved, "open_items": sum(item["status"] not in {"resolved", "cancelled"} for case in cases for item in case["items"]),
                "can_review": bool(cases) and all(case["checks"]["can_review"] for case in cases), "notice": "Current app preparation only, not eligibility, official LPIS or verified filing."}})
    count = Counter(row["kind"] for row in rows)
    workspace = _workspace(conn, session.workspace_id)
    return {"run_id": run["id"], "revision": run["revision"], "workspace": workspace, "fixture_id": data["fixture_id"], "fixture_version": data["fixture_version"],
        "fixture_hash": data["fixture_hash"], "notice": NOTICE, "farm_ids": [str(row["id"]) for row in rows if row["kind"] == "farms"],
        "record_count": len(rows), "fixture_record_count": sum(entry["kind"] not in {"admin_case_events", "demo_runs"} for entry in manifest), "inventory": [{"kind": kind, "count": amount} for kind, amount in sorted(count.items())],
        "scenarios": scenarios, "records": summaries, "role": {"actual": workspace["role"], "preview": False},
        "previous_run_id": data.get("previous_run_id") if workspace["role"] == "owner" else None,
        "source_workspace_id": data.get("source_workspace_id") if workspace["role"] == "owner" else None}


def _start(body, key, session, *, previous_run_id=None):
    _human(session, owner=True)
    if body.acknowledged is not True:
        _fail("Acknowledge that this creates a separate fictional training workspace.", "demo_acknowledgement_required")
    key = _key(key)
    written, commit_pending = [], False
    try:
        with transaction(session) as conn:
            previous = fetch_record(conn, "demo_runs", str(previous_run_id)) if previous_run_id else None
            identifier = previous["data"]["fixture_id"] if previous else body.fixture_id
            fixture, definitions, checksum = _fixture(identifier)
            workspace_id = _reserve(conn, identifier, key)
            workspace = _workspace(conn, workspace_id)
            if workspace["role"] != "owner":
                _fail("The returned example workspace does not have your real owner membership.", "workspace_access_denied", 403)
            conn.execute("SELECT set_config('app.workspace_id',%s,true)", (workspace_id,))
            if not conn.execute("SELECT has_membership() AS allowed").fetchone()["allowed"]:
                _fail("The example workspace membership could not be verified.", "workspace_access_denied", 403)
            scoped = replace(session, workspace_id=workspace_id)
            reservations = conn.execute("SELECT id FROM records WHERE kind='demo_runs' AND deleted_at IS NULL ORDER BY id LIMIT 2").fetchall()
            if len(reservations) != 1:
                _fail("The example workspace reservation is unavailable.", "demo_run_unavailable", 409)
            run = fetch_record(conn, "demo_runs", reservations[0]["id"])
            if run["data"].get("created_by") != session.user_id or run["data"].get("fixture_id") != identifier or run["data"].get("request_key_hash") != hashlib.sha256(key.encode()).hexdigest():
                _fail("This retry key belongs to another example request.", "idempotency_conflict", 409)
            if run["data"].get("status") == "ready":
                if run["data"].get("previous_run_id") != (str(previous_run_id) if previous_run_id else None) or previous and run["data"].get("previous_run_revision") != body.expected_revision:
                    _fail("This retry key was used for another start request.", "idempotency_conflict", 409)
                response = _view(conn, run["id"], scoped)
            else:
                if run["data"].get("status") != "reserved":
                    _fail("This example reservation has an unsupported state.", "demo_run_unavailable", 409)
                if previous and previous["revision"] != body.expected_revision:
                    _fail("Reload the example before starting a separate new run.", "revision_conflict", 409)
                records, parcels, pending = {}, {}, list(definitions)
                while pending:
                    ready = [item for item in pending if _dependencies(item) <= records.keys()]
                    if not ready:
                        _fail("The authored fixture has unresolved or circular record links.")
                    for definition in ready:
                        records[definition["alias"]] = _insert(conn, scoped, definition, records, parcels, written)
                        pending.remove(definition)
                farm_ids = [item["id"] for item in records.values() if item["kind"] == "farms"]
                if not farm_ids:
                    _fail("The training fixture needs its own fictional farm.")
                manifest = [{"id": records[item["alias"]]["id"], "kind": records[item["alias"]]["kind"], "alias": item["alias"], "scenario_id": item["scenario_id"]} for item in definitions]
                manifest.append({"id": run["id"], "kind": "demo_runs", "alias": "demo-run", "scenario_id": None})
                events = conn.execute("SELECT id,kind,data->>'case_id' AS case_id FROM records WHERE kind='admin_case_events' AND deleted_at IS NULL ORDER BY created_at,id LIMIT 101").fetchall()
                if len(events) > 100:
                    _fail("This fictional fixture created too many audit events.")
                case_scenarios = {entry["id"]: entry["scenario_id"] for entry in manifest if entry["kind"] == "admin_cases"}
                manifest.extend({"id": str(event["id"]), "kind": event["kind"], "scenario_id": case_scenarios[event["case_id"]]} for event in events if event["case_id"] in case_scenarios)
                data = {**run["data"], "farm_id": farm_ids[0], "status": "ready", "fixture_version": fixture["version"], "fixture_hash": checksum,
                    "previous_run_id": str(previous_run_id) if previous_run_id else None, "previous_run_revision": previous["revision"] if previous else None,
                    "records": manifest, "scenarios": [{key: deepcopy(scenario[key]) for key in ("id", "key", "title", "description", "summary", "country", "region", "farmer_goal", "adviser_goal", "start_page", "expected_actions") if key in scenario} for scenario in fixture["scenarios"]],
                    "notice": NOTICE, "seeded_at": datetime.now(timezone.utc).isoformat()}
                run = update_record(conn, "demo_runs", run["id"], run["revision"], data)
                response = _view(conn, run["id"], scoped)
            commit_pending = True
        return response
    except BaseException:
        # As with ordinary uploads, an uncertain commit acknowledgement must
        # retain its original rather than deleting a possibly committed file.
        if not commit_pending:
            for path in written:
                _remove_uncommitted(path)
        raise


@router.post("", status_code=201)
def start_demo(body: StartDemo, response: Response, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    response.headers["Cache-Control"] = "private, no-store"
    return _start(body, idempotency_key, session)


@router.get("/{run_id}")
def demo_detail(run_id: UUID, response: Response, session: Session = Depends(require_session)):
    _human(session)
    response.headers["Cache-Control"] = "private, no-store"
    with transaction(session) as conn:
        return _view(conn, run_id, session)


@router.post("/{run_id}/start-again", status_code=201)
def start_again(run_id: UUID, body: StartAgain, response: Response, idempotency_key: str | None = Header(None), session: Session = Depends(require_session)):
    response.headers["Cache-Control"] = "private, no-store"
    return _start(body, idempotency_key, session, previous_run_id=run_id)
