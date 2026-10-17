"""One real-service journey for task answers and farm-scoped source documents."""

from conftest import farm_data, human_browser


def test_task_answer_documents_preserve_origin_and_access(farmers, service_url):
    owner = farmers("Farmer attaching a task document")
    adviser = farmers("Adviser reviewing a task answer")
    viewer = farmers("Read-only task helper")
    outsider = farmers("Unrelated document owner")
    farm = owner.create("farms", farm_data("Task evidence holding"))
    other_farm = owner.create("farms", farm_data("Different holding"))
    outsider_farm = outsider.create("farms", farm_data("Private unrelated holding"))

    def upload(person, name, farm_id=None):
        original = f"Authored test original: {name}. No real farm data.\n".encode()
        saved = person.post("/documents", expected=201,
            files={"file": (name + ".txt", original, "text/plain")},
            data={"farm_id": farm_id} if farm_id else {}).json()
        return saved, original

    notice, notice_bytes = upload(owner, "original-notice", farm["id"])
    source, source_bytes = upload(owner, "supporting-receipt", farm["id"])
    wrong_farm, _ = upload(owner, "other-holding-receipt", other_farm["id"])
    unassigned, _ = upload(owner, "not-assigned-to-a-farm")
    private_source, _ = upload(outsider, "private-receipt", outsider_farm["id"])
    task = owner.create("tasks", {
        "farm_id": farm["id"], "title": "Check the date on the receipt",
        "description": "Read the original notice and attach the supporting receipt.",
        "document_id": notice["id"], "status": "open",
    })
    path = f"/tasks/{task['id']}"
    assert "evidence_documents" not in task["data"]

    for person, permissions in ((adviser, ["read", "review"]), (viewer, ["read"])):
        invitation = owner.post("/invitations", expected=201, json={
            "email": person.email, "role": "adviser", "farm_ids": [farm["id"]],
            "permissions": permissions, "expires_in_days": 1,
        }).json()
        person.post("/invitations/accept", json={"token": invitation["token"]})

    def selected(document):
        return {"document_id": document["id"], "document_revision": document["revision"]}

    # Legacy task updates remain valid without introducing attachment fields.
    progress = owner.patch(path, json={"expected_revision": task["revision"],
        "data": {"notes": "I found the receipt.", "status": "in_progress"}}).json()
    assert "evidence_documents" not in progress["data"]

    malformed = (
        None, {}, [source["id"]], [{"document_id": "bad-id", "document_revision": 1}],
        [{"document_id": source["id"], "document_revision": True}],
        [{"document_id": source["id"], "document_revision": 0}],
        [{"document_id": source["id"], "document_revision": "1"}],
        [{**selected(source), "approved": True}],
        [selected(source), selected(source)], [selected(source)] * 21,
        [selected(wrong_farm)], [selected(unassigned)],
    )
    for value in malformed:
        owner.patch(path, expected=422, json={"expected_revision": progress["revision"],
            "data": {"evidence_documents": value}})
    owner.patch(path, expected=404, json={"expected_revision": progress["revision"],
        "data": {"evidence_documents": [selected(private_source)]}})
    assert owner.get(path).json() == progress

    with human_browser(adviser, service_url) as delegated:
        delegated.headers.update({"X-Workspace-ID": owner.workspace_id})
        answer = delegated.patch(path, json={"expected_revision": progress["revision"],
            "data": {"notes": "The receipt confirms the date. Please see the attached original.",
                     "status": "done", "evidence_documents": [selected(source)]}})
        assert answer.status_code == 200, answer.text
        saved = answer.json()
        assert saved["data"]["evidence_documents"] == [selected(source)]
        assert saved["data"]["document_id"] == notice["id"]
        assert saved["data"]["status"] == "done"
        assert owner.get(path).json() == saved
        assert delegated.get(f"/documents/{source['id']}/file").content == source_bytes
        assert delegated.get(f"/documents/{wrong_farm['id']}").status_code == 404

    # Answer attachments cannot replace or erase the original notice.
    for replacement in (source["id"], None):
        owner.patch(path, expected=422, json={"expected_revision": saved["revision"],
            "data": {"document_id": replacement}})
    owner.patch(path, expected=409, json={"expected_revision": progress["revision"],
        "data": {"notes": "An outdated page must not erase the answer."}})

    renamed = owner.patch(f"/documents/{source['id']}", json={
        "expected_revision": source["revision"], "data": {"title": "Receipt checked against notebook"},
    }).json()
    assert renamed["revision"] > source["revision"]
    stale = owner.patch(path, expected=409, json={"expected_revision": saved["revision"],
        "data": {"notes": "Do not silently approve a changed document."}}).json()
    assert stale["error"]["code"] == "task_evidence_changed"
    assert owner.get(path).json() == saved
    current = owner.patch(path, json={"expected_revision": saved["revision"],
        "data": {"evidence_documents": [selected(renamed)]}}).json()
    assert current["data"]["notes"] == saved["data"]["notes"]
    assert current["data"]["document_id"] == notice["id"]
    assert current["data"]["evidence_documents"] == [selected(renamed)]
    assert owner.get(f"/documents/{notice['id']}/file").content == notice_bytes
    assert owner.get(f"/documents/{source['id']}/file").content == source_bytes

    with human_browser(viewer, service_url) as readonly:
        readonly.headers.update({"X-Workspace-ID": owner.workspace_id})
        assert readonly.get(path).json()["data"] == current["data"]
        assert readonly.get(f"/documents/{source['id']}/file").content == source_bytes
        denied = readonly.patch(path, json={"expected_revision": current["revision"],
            "data": {"notes": "Unauthorized answer", "evidence_documents": []}})
        assert denied.status_code == 403, denied.text
    outsider.get(path, expected=404)
    assert owner.get(path).json() == current
