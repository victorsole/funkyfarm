"""One HTTP journey through a large adviser client and narrowed farm access."""

from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import psycopg
from psycopg.types.json import Jsonb

from conftest import checked_database, fact_data, farm_data


def test_adviser_pages_searches_and_reviews_only_currently_permitted_farms(farmers):
    owner = farmers("Adviser tools farm owner")
    adviser = farmers("Adviser tools independent adviser")
    outsider = farmers("Adviser tools unrelated owner")
    target = owner.create("farms", farm_data("ZZZ oldest review farm"))
    foreign = outsider.create("farms", farm_data("Private unrelated farm"))

    # Bulk fixtures belong only to this registered test identity. The existing
    # farmers fixture removes its generated workspaces, never an existing farm.
    bulk = [(uuid4(), farm_data(f"Farm {number:03d}")) for number in range(104)]
    admin_url = checked_database("FUNKYFARM_TEST_ADMIN_DATABASE_URL")
    with psycopg.connect(admin_url, connect_timeout=5) as connection:
        assert connection.execute(
            "SELECT w.id FROM funkyfarm.workspaces w JOIN funkyfarm.users u ON u.id=w.owner_id "
            "WHERE w.id=%s AND u.id=%s AND u.email=%s",
            (UUID(owner.workspace_id), UUID(owner.user_id), owner.email),
        ).fetchone() == (UUID(owner.workspace_id),)
        connection.execute("SELECT set_config('app.user_id',%s,true),set_config('app.workspace_id',%s,true)",
                           (owner.user_id, owner.workspace_id))
        with connection.cursor() as cursor:
            cursor.executemany(
                "INSERT INTO funkyfarm.records(id,workspace_id,kind,data) VALUES(%s,%s,'farms',%s)",
                [(identifier, UUID(owner.workspace_id), Jsonb(data)) for identifier, data in bulk],
            )
            assert cursor.rowcount == 104

    today = datetime.now(timezone.utc).date()
    def iso(days):
        return (today + timedelta(days=days)).isoformat()
    owner.create("facts", fact_data(target["id"], period=str(today.year)))
    owner.create("operations", {"farm_id": target["id"], "title": "Notebook work to check", "type": "work",
                                "date": iso(0), "quantity": 2, "unit": "hours"})
    owner.create("purchases", {"farm_id": target["id"], "title": "Purchase to check", "date": iso(0),
                               "amount": 12.5, "currency": "EUR"})
    sale_data = {"farm_id": target["id"], "title": "Harvest sale to check", "date": iso(-1), "category": "produce",
                 "quantity": 5, "unit": "kg", "amount": 20, "currency": "EUR", "buyer": "Test buyer"}
    owner.create("sales", sale_data)
    owner.create("sales", {**sale_data, "farm_id": str(bulk[0][0]), "title": "Other farm sale"})

    tasks = []
    for title, days, status in [("Overdue task", -2, "open"), ("Task due today", 0, "open"),
                                ("Task at thirty days", 30, "in_progress"), ("Later task", 31, "open"),
                                ("Undated task", None, "open"), ("Finished old task", -3, "done"),
                                ("Cancelled old task", -4, "cancelled")]:
        tasks.append(owner.create("tasks", {"farm_id": target["id"], "title": title, "status": status,
                                            **({"due_date": iso(days)} if days is not None else {})}))
    requests = []
    for title, days in [("Overdue paperwork", -1), ("Undated paperwork", None)]:
        requests.append(owner.create("requests", {"farm_id": target["id"], "title": title, "recipient": "Test agency",
                                                   "country": "DE", "reporting_year": today.year,
                                                   "pack_id": "generic", **({"deadline": iso(days)} if days is not None else {})}))
    cases = []
    for title, days in [("Upcoming inspection", 5), ("Undated inspection", None)]:
        cases.append(owner.post("/cases", expected=201, json={"farm_id": target["id"], "title": title,
                         "job_type": "inspection", "reporting_year": today.year,
                         **({"deadline": iso(days)} if days is not None else {})}).json())

    invitation = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser",
        "farm_ids": None, "permissions": ["read", "review"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": invitation["token"]})
    params = {"workspace_id": owner.workspace_id}
    detail_path = f"/adviser/farms/{target['id']}"

    # A direct link works before loading any directory page, including an older
    # farm omitted from the legacy first-100 workspace snapshot.
    detail = adviser.get(detail_path, params=params).json()
    assert detail["farm"]["id"] == target["id"]
    assert detail["review_counts"] == {"facts": 1, "operations": 1, "purchases": 1, "sales": 1}
    assert {key: detail["schedule"][key] for key in ("overdue", "upcoming", "undated")} == {
        "overdue": 2, "upcoming": 3, "undated": 3}
    assert detail["schedule"]["today"] == iso(0) and detail["schedule"]["through"] == iso(30)
    assert [item["recorded_date"] for item in detail["schedule"]["items"]] == sorted(
        item["recorded_date"] for item in detail["schedule"]["items"])
    assert not {tasks[-1]["id"], tasks[-2]["id"]} & {item["id"] for item in detail["schedule"]["items"]}
    assert detail["case_counts"] == {"draft": 2}
    assert [detail[kind]["total"] for kind in ("tasks", "requests", "admin_cases")] == [7, 2, 2]

    clients = adviser.get("/adviser/clients", params={"limit": 1}).json()
    other_clients = adviser.get("/adviser/clients", params={"limit": 1, "offset": 1}).json()
    assert clients["total"] == other_clients["total"] == 2
    assert {item["id"] for item in clients["items"] + other_clients["items"]} == {owner.workspace_id, adviser.workspace_id}
    first = adviser.get("/adviser/farms", params={**params, "limit": 25}).json()
    tail = adviser.get("/adviser/farms", params={**params, "limit": 25, "offset": 100}).json()
    assert first["total"] == tail["total"] == 105
    assert len(first["items"]) == 25 and len(tail["items"]) == 5
    assert target["id"] not in {farm["id"] for farm in first["items"]}
    assert target["id"] in {farm["id"] for farm in tail["items"]}
    found = adviser.get("/adviser/farms", params={**params, "search": "  OLDEST REVIEW  "}).json()
    assert found["total"] == 1 and found["items"][0]["id"] == target["id"]
    assert adviser.get("/adviser/farms", params={**params, "search": "%"}).json()["total"] == 0
    assert adviser.get("/adviser/farms", params={**params, "search": "BAVARIA"}).json()["total"] == 105
    adviser.get("/adviser/farms", params={**params, "limit": 51}, expected=422)
    adviser.get("/adviser/farms", params={**params, "offset": -1}, expected=422)

    page = adviser.get(detail_path, params={**params, "limit": 1}).json()
    next_page = adviser.get(detail_path, params={**params, "limit": 1, "tasks_offset": 1,
                                               "requests_offset": 1, "cases_offset": 1}).json()
    for kind in ("tasks", "requests", "admin_cases"):
        assert len(page[kind]["items"]) == len(next_page[kind]["items"]) == 1
        assert page[kind]["items"][0]["id"] != next_page[kind]["items"][0]["id"]
        assert next_page[kind]["offset"] == 1 and next_page[kind]["total"] == detail[kind]["total"]
    adviser.get(f"/adviser/farms/{foreign['id']}", params=params, expected=404)
    adviser.get("/adviser/farms", params={"workspace_id": outsider.workspace_id}, expected=404)
    adviser.get(f"/adviser/farms/{foreign['id']}", params={"workspace_id": outsider.workspace_id}, expected=404)

    # Revocation and a replacement read-only grant must change both listing and
    # direct-link access, not recover the earlier whole-workspace view.
    owner.post(f"/invitations/{invitation['invitation']['id']}/revoke")
    adviser.get(detail_path, params=params, expected=404)
    narrow = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser",
        "farm_ids": [target["id"]], "permissions": ["read"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": narrow["token"]})
    limited = adviser.get("/adviser/farms", params=params).json()
    assert limited["total"] == 1 and limited["items"][0]["id"] == target["id"]
    assert limited["workspace"]["permissions"] == ["read"]
    assert adviser.get(detail_path, params=params).json()["review_counts"]["sales"] == 1
    adviser.get(f"/adviser/farms/{bulk[0][0]}", params=params, expected=404)
    assert adviser.get("/adviser/farms", params={**params, "search": "Farm 000"}).json()["total"] == 0
    owner.post(f"/invitations/{narrow['invitation']['id']}/revoke")
    assert owner.workspace_id not in {item["id"] for item in adviser.get("/adviser/clients").json()["items"]}
