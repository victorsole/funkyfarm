"""Scope cases 8, 19, 27: selective consent, revocation and separate storage."""

from conftest import fact_data, farm_data
from uuid import uuid4


def test_adviser_grant_and_revocation_leave_private_workspaces_separate(farmers, community_reviewer):
    owner = farmers("Delegating farmer")
    adviser = farmers("Independent adviser")
    allowed = owner.create("farms", farm_data("Shared only by grant"))
    private = owner.create("farms", farm_data("Unshared holding"))
    adviser_farm = adviser.create("farms", farm_data("Adviser's own farm"))
    allowed_fact = owner.create("facts", fact_data(allowed["id"]))
    private_fact = owner.create("facts", fact_data(private["id"]))

    adviser.get(f"/farms/{allowed['id']}", expected=404)
    invitation = owner.post("/invitations", json={
        "email": adviser.email, "role": "adviser", "farm_ids": [allowed["id"]],
        "permissions": ["read", "review"], "expires_in_days": 1,
    }, expected=201).json()
    assert "token_hash" not in invitation["invitation"]["data"]
    accepted = adviser.post("/invitations/accept", json={"token": invitation["token"]}).json()
    assert accepted["workspace_id"] == owner.workspace_id
    assert adviser.get("/auth/session").json()["workspace"]["id"] == adviser.workspace_id
    assert {item["id"] for item in adviser.get("/farms").json()["items"]} == {adviser_farm["id"]}

    selected = {"X-Workspace-ID": owner.workspace_id}
    assert adviser.get(f"/farms/{allowed['id']}", headers=selected).json()["id"] == allowed["id"]
    assert {item["id"] for item in adviser.get("/farms", headers=selected).json()["items"]} == {allowed["id"]}
    adviser.get(f"/farms/{private['id']}", headers=selected, expected=404)
    adviser.get(f"/facts/{private_fact['id']}", headers=selected, expected=404)
    assert {item["id"] for item in adviser.get("/facts", headers=selected).json()["items"]} == {allowed_fact["id"]}
    reviewed = adviser.post(f"/facts/{allowed_fact['id']}/review", headers=selected, json={
        "expected_revision": allowed_fact["revision"], "decision": "confirmed", "note": "Review explicitly delegated for this farm.",
    }).json()
    assert reviewed["data"]["reviewed_by"] == adviser.user_id
    old_retry_key = "delegated-task-" + uuid4().hex
    old_task_body = {"data": {"farm_id": allowed["id"], "title": "Private old-grant task " + uuid4().hex}}
    old_task = adviser.post("/tasks", headers={**selected, "Idempotency-Key": old_retry_key}, json=old_task_body, expected=201).json()
    overview = adviser.get("/adviser/overview").json()
    assert allowed["id"] in str(overview) and private["id"] not in str(overview)
    asked = adviser.post("/adviser/ask-farmer", headers=selected, expected=201, json={
        "farm_id": allowed["id"], "title": "Please check your field notebook",
        "description": "Confirm the actual date rather than borrowing the receipt date.",
    }).json()
    assert asked["data"]["assignee"] == "farmer" and asked["data"]["status"] == "open"
    assert owner.get(f"/tasks/{asked['id']}").json()["id"] == asked["id"]
    adviser.post("/invitations", headers=selected, json={
        "email": owner.email, "role": "adviser", "farm_ids": None, "permissions": ["read"], "expires_in_days": 1,
    }, expected=403)

    owner.post(f"/invitations/{invitation['invitation']['id']}/revoke")
    revoked = adviser.client.get(f"/farms/{allowed['id']}", headers=selected)
    assert revoked.status_code in (401, 403, 404)
    denied_write = adviser.client.post(f"/facts/{allowed_fact['id']}/review", headers=selected, json={
        "expected_revision": reviewed["revision"], "decision": "rejected", "note": "Revoked access must not mutate history.",
    })
    assert denied_write.status_code in (401, 403, 404)
    assert adviser.client.post("/invitations/accept", json={"token": invitation["token"]}).status_code in (403, 404)
    assert owner.get(f"/facts/{allowed_fact['id']}").json()["data"]["review_status"] == "confirmed"
    assert adviser.get(f"/farms/{adviser_farm['id']}").json()["data"]["name"] == "Adviser's own farm"
    assert owner.get(f"/farms/{private['id']}").json()["data"]["name"] == "Unshared holding"

    # A new grant to farm B must not revive cached responses from farm A.
    replacement = owner.post("/invitations", json={
        "email": adviser.email, "role": "adviser", "farm_ids": [private["id"]],
        "permissions": ["read", "review"], "expires_in_days": 1,
    }, expected=201).json()
    adviser.post("/invitations/accept", json={"token": replacement["token"]})
    assert adviser.get(f"/farms/{private['id']}", headers=selected).json()["id"] == private["id"]
    adviser.get(f"/farms/{allowed['id']}", headers=selected, expected=404)
    replay = adviser.client.post("/tasks", headers={**selected, "Idempotency-Key": old_retry_key}, json=old_task_body)
    assert replay.status_code in (403, 404, 409), replay.text
    assert old_task["id"] not in replay.text and old_task_body["data"]["title"] not in replay.text
    assert {item["id"] for item in owner.get("/tasks").json()["items"]} == {old_task["id"], asked["id"]}
    owner.post(f"/invitations/{replacement['invitation']['id']}/revoke")

    broad = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser", "farm_ids": None, "permissions": ["read", "review"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": broad["token"]})
    narrow = owner.post("/invitations", expected=201, json={"email": adviser.email, "role": "adviser", "farm_ids": [allowed["id"]], "permissions": ["read"], "expires_in_days": 1}).json()
    adviser.post("/invitations/accept", json={"token": narrow["token"]}, expected=409)
    assert {item["id"] for item in adviser.get("/farms", headers=selected).json()["items"]} == {allowed["id"], private["id"]}
    owner.post(f"/invitations/{narrow['invitation']['id']}/revoke")
    assert adviser.get(f"/farms/{private['id']}", headers=selected).json()["id"] == private["id"]
    owner.post(f"/invitations/{broad['invitation']['id']}/revoke")

    draft = owner.post("/knowledge", json={"title": "Private draft", "body": "This must remain unpublished.", "topic": "evidence", "publish": False}, expected=201).json()
    adviser.get(f"/knowledge/{draft['id']}", expected=404)
    publish_private = community_reviewer.client.post(f"/knowledge/{draft['id']}/moderate", json={"status": "published", "reason": "Moderator must not override an author's private choice."})
    assert publish_private.status_code in (403, 404)
    adviser.get(f"/knowledge/{draft['id']}", expected=404)
    published = owner.post("/knowledge", json={"title": "Authored public test question", "body": "How can a farmer prepare evidence?", "topic": "evidence", "publish": True}, expected=201).json()
    assert adviser.get(f"/knowledge/{published['id']}").json()["question"]["id"] == published["id"]
    assert allowed["id"] not in str(adviser.get("/knowledge").json())
    community_reviewer.post(f"/knowledge/{published['id']}/moderate", json={"status": "hidden", "reason": "Authored moderation regression fixture."})
    adviser.get(f"/knowledge/{published['id']}", expected=404)
    withdrawn = owner.post(f"/knowledge/{published['id']}/withdraw").json()
    assert withdrawn["status"] == "withdrawn"
    resurrect = community_reviewer.client.post(f"/knowledge/{published['id']}/moderate", json={"status": "published", "reason": "Moderator must not override explicit withdrawal."})
    assert resurrect.status_code in (403, 404)
    adviser.get(f"/knowledge/{published['id']}", expected=404)
