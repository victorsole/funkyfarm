"""Funding facts, truthful source status and an explicit private follow-up.

HTTP reads and task writes use the real service. Source freshness uses one
generated public-state row under the same restricted tenant transaction as the
API helper, with no publisher request and no existing observation changed.
"""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg

from conftest import checked_database, farm_data
from funkyfarm.db import transaction
from funkyfarm.funding import build_funding_guide, funding_catalogue
from funkyfarm import regulatory_sources
from funkyfarm.security import Session


def test_funding_guide_freshness_and_explicit_follow_up(farmers, monkeypatch):
    owner = farmers("Funding follow-up owner")
    outsider = farmers("Unrelated funding account")
    farm = owner.create("farms", farm_data("Organisation funding review"))
    path = f"/farms/{farm['id']}/funding-guide"
    guide = owner.get(path).json()
    outsider.get(path, expected=404)
    assert guide["farm"]["id"] == farm["id"]
    assert guide["personalised_eligibility"] is False and guide["application_enabled"] is False
    programme, = guide["items"]
    assert programme["call_2026"]["status"] == "closed"
    assert programme["call_2026"]["deadline"] == "2026-04-23"
    assert programme["future_calls"]["status"] == "not_verified"
    assert "deadline" not in programme["future_calls"]
    assert {question["id"] for question in guide["questions"]} == {"organisation", "campaign", "call"}
    assert guide["updates_href"] == f"/app/updates?farm_id={farm['id']}&family=funding"

    installed, = funding_catalogue()["monitoring_sources"]
    exact_url = "https://rea.ec.europa.eu/funding-and-grants/promotion-agricultural-products-0/calls-proposals-promotion-agricultural-products_en"
    assert installed["id"] == "rea-agrip-calls" and installed["url"] == exact_url
    assert installed["workflow_ids"] == ["funding"] and installed["poll_interval_seconds"] == 86400
    actual, = [source for source in regulatory_sources.source_catalog() if source["id"] == installed["id"]]
    assert actual["poll_interval_seconds"] == 86400 and actual["url"] == exact_url
    assert regulatory_sources.allowed_source_url(exact_url)
    for url in (exact_url + "/unreviewed", exact_url + "?other=1", exact_url.replace("https:", "http:"), exact_url.replace("rea.ec.europa.eu", "rea.ec.europa.eu.attacker.invalid")):
        assert not regulatory_sources.allowed_source_url(url)
    public_status, = guide["source_checks"]
    assert public_status["source_id"] == installed["id"] and public_status["poll_interval_seconds"] == 86400

    runtime_url = checked_database("FUNKYFARM_TEST_DATABASE_URL")
    admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    source = {**actual, "id": "acceptance-funding-" + uuid4().hex}
    actor = Session(owner.user_id, owner.workspace_id, "owner", "")
    now = datetime.now(timezone.utc)
    with monkeypatch.context() as scoped:
        scoped.setenv("FUNKYFARM_DATABASE_URL", runtime_url)
        scoped.setattr(regulatory_sources, "source_catalog", lambda: [source])

        def read_status():
            with transaction(actor) as conn:
                value = build_funding_guide(conn, farm["id"])
            assert value["items"][0]["call_2026"]["deadline"] == "2026-04-23"
            assert "deadline" not in value["items"][0]["future_calls"]
            status, = value["source_checks"]
            assert status["source_id"] == source["id"]
            return status

        assert read_status()["freshness"] == "never_checked"
        try:
            with psycopg.connect(admin_url, connect_timeout=5) as conn:
                conn.execute("INSERT INTO funkyfarm.regulatory_source_state(source_id,url,content_hash,last_checked_at,last_successful_at,next_check_at,last_status,last_http_status) VALUES(%s,%s,%s,%s,%s,%s,'unchanged',200)",
                             (source["id"], exact_url, "a" * 64, now, now, now + timedelta(days=1)))
            current = read_status()
            assert current["freshness"] == "current" and current["baseline_exists"] is True
            assert current["last_successful_at"] and current["poll_interval_seconds"] == 86400
            with psycopg.connect(admin_url, connect_timeout=5) as conn:
                conn.execute("UPDATE funkyfarm.regulatory_source_state SET last_successful_at=%s WHERE source_id=%s", (now - timedelta(days=3), source["id"]))
            stale = read_status()
            assert stale["freshness"] == "stale" and stale["baseline_exists"] is True
            with psycopg.connect(admin_url, connect_timeout=5) as conn:
                conn.execute("UPDATE funkyfarm.regulatory_source_state SET failure_count=1,last_status='http_error',last_http_status=202,last_checked_at=%s WHERE source_id=%s", (now, source["id"]))
            failed = read_status()
            assert failed["freshness"] == "failed" and failed["http_status"] == 202
            assert failed["last_successful_at"] == stale["last_successful_at"]
            assert failed["baseline_exists"] is True
        finally:
            with psycopg.connect(admin_url, connect_timeout=5) as conn:
                conn.execute("DELETE FROM funkyfarm.regulatory_source_state WHERE source_id=%s AND url=%s", (source["id"], exact_url))

    assert owner.get("/tasks").json()["total"] == 0
    task = {"data": {"farm_id": farm["id"], "title": "Check agricultural promotion funding", "description": "REA AGRIP: review the organisation eligibility and current official call.", "due_date": "2026-12-01", "status": "open", "notes": "Ask our producer group whether it can apply."}}
    retry = {"Idempotency-Key": "funding-follow-up-" + uuid4().hex}
    saved = owner.post("/tasks", expected=201, headers=retry, json=task).json()
    assert owner.post("/tasks", expected=201, headers=retry, json=task).json() == saved
    assert owner.get(f"/tasks/{saved['id']}").json()["data"] == task["data"]
    assert owner.get("/tasks", params={"farm_id": farm["id"]}).json()["total"] == 1
    outsider.get(f"/tasks/{saved['id']}", expected=404)
    assert owner.get("/reports").json()["total"] == 0
    assert owner.get(f"/farms/{farm['id']}").json() == farm
