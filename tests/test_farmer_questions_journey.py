"""One real-service journey: delegated question, farmer answer and honest Home."""

from datetime import date, timedelta
from uuid import uuid4

from conftest import farm_data, human_browser


def test_adviser_question_answer_deadlines_and_scoped_task_pages(farmers, service_url):
    owner = farmers("Farmer answering a delegated question")
    adviser = farmers("Adviser asking for missing records")
    reader = farmers("Read-only adviser")
    outsider = farmers("Unrelated farmer")
    today = date.today()
    yesterday = (today - timedelta(days=1)).isoformat()
    farm = owner.create("farms", {**farm_data("Question holding"), "farm_type": "arable", "reporting_year": today.year})
    private_farm = owner.create("farms", farm_data("Not delegated"))
    private_task = owner.create("tasks", {"farm_id": private_farm["id"], "title": "Other farm's overdue question",
                                           "due_date": yesterday, "status": "open"})
    past_request = owner.create("requests", {
        "farm_id": farm["id"], "title": "Existing overdue authority request", "recipient": "Fictional office",
        "country": "DE", "reporting_year": today.year, "deadline": (today - timedelta(days=2)).isoformat(),
        "pack_id": "farm-evidence", "requirements": [], "status": "draft",
    })
    selected = {"X-Workspace-ID": owner.workspace_id}
    for person, permissions in ((adviser, ["read", "review"]), (reader, ["read"])):
        invitation = owner.post("/invitations", expected=201, json={
            "email": person.email, "role": "adviser", "farm_ids": [farm["id"]],
            "permissions": permissions, "expires_in_days": 1,
        }).json()
        person.post("/invitations/accept", json={"token": invitation["token"]})

    def request(client, method, path, *, expected=200, **kwargs):
        response = client.request(method, path, **kwargs)
        assert response.status_code == expected, f"{method} {path}: {response.status_code} {response.text[:1200]}"
        return response.json()

    with human_browser(owner, service_url) as farmer, human_browser(adviser, service_url) as delegated:
        delegated.headers.update(selected)

        def ask(index, due):
            return request(delegated, "POST", "/adviser/ask-farmer", expected=201,
                headers={"Idempotency-Key": f"farmer-question-{uuid4().hex}"}, json={
                    "farm_id": farm["id"], "title": f"Check notebook entry {index}",
                    "description": f"Tell me the actual application date and evidence for entry {index}.", "due_date": due,
                })

        overdue = ask(0, yesterday)
        due_today = ask(1, today.isoformat())
        originals = {item["id"]: dict(item["data"]) for item in (overdue, due_today)}
        assert overdue["workspace_id"] == owner.workspace_id
        assert overdue["data"]["asked_by"] == adviser.user_id
        assert overdue["data"]["purpose"] == "missing_information"
        assert overdue["data"]["assignee"] == "farmer"
        assert not overdue["data"].get("document_id") and not overdue["data"].get("request_id")
        assert request(farmer, "GET", f"/tasks/{overdue['id']}")["data"] == overdue["data"]

        home_path = f"/workflow/home?farm_id={farm['id']}&year={today.year}"
        initial = request(farmer, "GET", home_path)
        assert initial["summary"]["open_tasks"] == 2
        assert initial["summary"]["overdue_tasks"] == 1
        assert initial["summary"]["due_today_tasks"] == 1
        task_actions = [item for item in initial["next_actions"] if item["kind"] == "task"]
        assert {item["href"] for item in task_actions} == {f"/app/tasks/{overdue['id']}", f"/app/tasks/{due_today['id']}"}
        assert all(item["priority"] == "high" for item in task_actions)
        request_index = next(index for index, item in enumerate(initial["next_actions"]) if item.get("record_id") == past_request["id"])
        assert all(request_index < initial["next_actions"].index(item) for item in task_actions)
        task_dates = {item["href"]: item for item in initial["deadlines"] if item["href"].startswith("/app/tasks/")}
        assert task_dates[f"/app/tasks/{overdue['id']}"]["deadline"] == yesterday
        assert task_dates[f"/app/tasks/{overdue['id']}"]["overdue"] is True
        assert task_dates[f"/app/tasks/{due_today['id']}"]["deadline"] == today.isoformat()
        assert task_dates[f"/app/tasks/{due_today['id']}"]["overdue"] is False

        questions = [overdue, due_today] + [ask(index, yesterday) for index in range(2, 26)]
        question_ids = {item["id"] for item in questions}
        bounded = request(farmer, "GET", home_path)
        assert {key: bounded["summary"][key] for key in (
            "open_tasks", "dated_tasks", "overdue_tasks", "due_today_tasks", "upcoming_task_deadlines"
        )} == {"open_tasks": 26, "dated_tasks": 26, "overdue_tasks": 25, "due_today_tasks": 1, "upcoming_task_deadlines": 1}
        assert bounded["task_preview"] == {
            "total": 26, "dated_total": 26, "overdue_total": 25, "due_today_total": 1, "upcoming_total": 1,
            "actions_returned": 5, "deadlines_returned": 20, "actions_truncated": True, "deadlines_truncated": True,
            "href": f"/app/tasks?farm_id={farm['id']}",
        }
        assert len([item for item in bounded["next_actions"] if item["kind"] == "task"]) == 5
        assert len([item for item in bounded["deadlines"] if item["href"].startswith("/app/tasks/")]) == 20
        assert private_task["id"] not in str(bounded)

        task_path = f"/tasks/{overdue['id']}"
        # Keep the actual question immutable; the answer has its own notes field.
        for patch in ({"title": "Rewritten question"}, {"description": "Erase the original request"}, {"assignee": "adviser"}):
            request(farmer, "PATCH", task_path, expected=422, json={"expected_revision": overdue["revision"], "data": patch})
        for status in ("done", "cancelled"):
            request(farmer, "PATCH", task_path, expected=422, json={
                "expected_revision": overdue["revision"], "data": {"status": status, "notes": "   "},
            })
        iso = today.isocalendar()
        for invalid_date in (today.strftime("%Y%m%d"), f"{iso.year}-W{iso.week:02d}-{iso.weekday}"):
            request(farmer, "PATCH", task_path, expected=422, json={
                "expected_revision": overdue["revision"], "data": {"due_date": invalid_date},
            })
        request(farmer, "PATCH", task_path, expected=422, json={
            "expected_revision": overdue["revision"], "data": {"notes": "x" * 4001},
        })
        unchanged = request(farmer, "GET", task_path)
        assert unchanged["revision"] == overdue["revision"] and unchanged["data"] == originals[overdue["id"]]
        answer = "Notebook checked: " + "é" * (4000 - len("Notebook checked: "))
        progress = request(farmer, "PATCH", task_path, json={
            "expected_revision": overdue["revision"], "data": {"status": "in_progress", "notes": answer},
        })
        assert progress["data"]["notes"] == answer and len(progress["data"]["notes"]) == 4000
        request(farmer, "PATCH", task_path, expected=409, json={
            "expected_revision": overdue["revision"], "data": {"notes": "Stale screen must not overwrite the answer"},
        })
        retained = request(farmer, "GET", task_path)
        assert retained["revision"] == progress["revision"] and retained["data"]["notes"] == answer
        done = request(farmer, "PATCH", task_path, json={"expected_revision": progress["revision"], "data": {"status": "done"}})
        cancelled = request(farmer, "PATCH", f"/tasks/{due_today['id']}", json={
            "expected_revision": due_today["revision"],
            "data": {"status": "cancelled", "notes": "I cannot supply that entry; the notebook page is missing."},
        })
        for closed in (done, cancelled):
            for key, value in originals[closed["id"]].items():
                if key not in {"status", "notes"}:
                    assert closed["data"][key] == value
            readback = request(delegated, "GET", f"/tasks/{closed['id']}")
            assert readback["workspace_id"] == owner.workspace_id and readback["data"] == closed["data"]

        active_path = f"/tasks?farm_id={farm['id']}&task_state=active&limit=20"
        first = request(farmer, "GET", active_path + "&offset=0")
        second = request(farmer, "GET", active_path + "&offset=20")
        end = request(farmer, "GET", active_path + "&offset=24")
        active_ids = question_ids - {done["id"], cancelled["id"]}
        assert first["total"] == second["total"] == end["total"] == 24
        assert len(first["items"]) == 20 and len(second["items"]) == 4 and end["items"] == []
        assert {item["id"] for item in first["items"]}.isdisjoint({item["id"] for item in second["items"]})
        assert {item["id"] for item in first["items"] + second["items"]} == active_ids
        all_path = f"/tasks?farm_id={farm['id']}&task_state=all&limit=20"
        all_first = request(farmer, "GET", all_path + "&offset=0")
        all_second = request(farmer, "GET", all_path + "&offset=20")
        assert all_first["total"] == all_second["total"] == 26
        assert len(all_first["items"]) == 20 and len(all_second["items"]) == 6
        assert {item["id"] for item in all_first["items"] + all_second["items"]} == question_ids
        request(farmer, "GET", f"/tasks?farm_id={farm['id']}&task_state=unknown", expected=422)
        final_home = request(farmer, "GET", home_path)
        assert final_home["summary"]["open_tasks"] == 24
        assert final_home["summary"]["overdue_tasks"] == 24
        assert final_home["summary"]["due_today_tasks"] == 0
        assert final_home["summary"]["upcoming_task_deadlines"] == 0

    # The adviser's personal workspace never becomes the farmer's workspace.
    assert adviser.get("/auth/session").json()["workspace"]["id"] == adviser.workspace_id
    adviser.get(f"/tasks/{done['id']}", expected=404)
    with human_browser(reader, service_url) as readonly:
        readonly.headers.update(selected)
        assert request(readonly, "GET", f"/tasks/{done['id']}")["data"]["notes"] == answer
        denied = readonly.patch(f"/tasks/{done['id']}", json={"expected_revision": done["revision"], "data": {"notes": "Unauthorized answer"}})
        assert denied.status_code in (403, 404), denied.text
        denied_question = readonly.post("/adviser/ask-farmer", json={
            "farm_id": farm["id"], "title": "Not delegated", "description": "Read-only permission cannot ask for work.",
        })
        assert denied_question.status_code in (403, 404), denied_question.text
    with human_browser(outsider, service_url) as unrelated:
        denied = unrelated.get(f"/tasks/{done['id']}")
        assert denied.status_code == 404 and answer not in denied.text
        assert request(unrelated, "GET", "/tasks?task_state=all")["total"] == 0
        assert unrelated.get(f"/tasks?farm_id={farm['id']}&task_state=active").status_code == 404
        forged = unrelated.patch(f"/tasks/{done['id']}", headers=selected,
            json={"expected_revision": done["revision"], "data": {"notes": "Forged workspace answer"}})
        assert forged.status_code in (401, 403, 404), forged.text
    assert owner.get(f"/tasks/{done['id']}").json()["data"]["notes"] == answer
