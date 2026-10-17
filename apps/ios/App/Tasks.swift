import SwiftUI

private enum TaskReplyData {
    static let statuses = ["open", "in_progress", "done", "cancelled"]
    static func normalized(_ record: RecordItem) throws -> RecordItem {
        if let value = record.data["status"], value != .null {
            guard case .string(let status) = value, statuses.contains(status) else { throw ServiceError(status: 0, message: "A task has an unsupported recorded state. It was not assumed to be open or complete. Reload or ask the workspace owner to correct it.") }
            return record
        }
        // Home treats only an absent or JSON-null legacy state as open.
        var data = record.data; data["status"] = .string("open")
        return RecordItem(id: record.id, kind: record.kind, revision: record.revision, workspace_id: record.workspace_id, data: data, created_at: record.created_at, updated_at: record.updated_at, journal_issues: record.journal_issues, active: record.active, confirmed_successor_id: record.confirmed_successor_id)
    }
    static func label(_ value: String) -> String { ["open": "Open", "in_progress": "In progress", "done": "Done — recorded by a person", "cancelled": "Cancelled"][value] ?? value }
    static func question(_ record: RecordItem) -> JSONValue { .object(record.data.filter { ["title", "description", "assignee", "purpose", "asked_by", "asked_at", "request_id", "document_id", "farm_id"].contains($0.key) }) }
    static func notes(_ record: RecordItem) -> String { guard case .string(let text)? = record.data["notes"] else { return "" }; return text }
    static func grant(_ value: JSONValue, workspaceID: String) throws -> JSONValue {
        guard case .array(let rows)? = value.object["items"], let membership = rows.map(\.object).first(where: { $0["id"] == .string(workspaceID) }), let role = membership["role"]?.text, ["owner", "adviser", "worker"].contains(role), case .array(let permissions)? = membership["permissions"], permissions.allSatisfy({ if case .string = $0 { return true }; return false }), let farms = membership["farm_ids"] else { throw ServiceError(status: 403, message: "The current workspace grant could not be established. Reload before replying.") }
        if farms != .null { guard case .array(let ids) = farms, ids.allSatisfy({ UUID(uuidString: $0.text) != nil }) else { throw ServiceError(status: 0, message: "The farm grant could not be read completely.") } }
        return .object(["workspace_id": .string(workspaceID), "role": .string(role), "permissions": .array(permissions), "farm_ids": farms])
    }
    static func allows(_ grant: JSONValue, farmID: String, writing: Bool) -> Bool {
        let data = grant.object
        guard data["farm_ids"] == .null || (data["farm_ids"]?.array ?? []).contains(.string(farmID)) else { return false }
        return !writing || data["role"] == .string("owner") || (data["permissions"]?.array ?? []).contains(.string("review"))
    }
}

struct AdviserQuestionListView: View {
    var body: some View { NativeTaskListView(questionsOnly: true) }
}

struct NativeTaskListView: View {
    @EnvironmentObject private var store: AppStore
    let questionsOnly: Bool
    let showChecklists: Bool
    @State private var farmID: String
    @State private var rows: [RecordItem] = []
    @State private var total = 0
    @State private var offset = 0
    @State private var loaded = false
    @State private var busy = false
    @State private var requestID = UUID()
    @State private var problem: String?
    init(initialFarmID: String? = nil, questionsOnly: Bool = false, showChecklists: Bool = false) {
        self.questionsOnly = questionsOnly; self.showChecklists = showChecklists
        _farmID = State(initialValue: initialFarmID ?? "")
    }
    private var visibleRows: [RecordItem] { questionsOnly ? rows.filter { $0.value("purpose") == "missing_information" } : rows }
    private var cached: [RecordItem] { store.records("tasks").filter { (!questionsOnly || $0.value("purpose") == "missing_information") && (farmID.isEmpty || $0.value("farm_id") == farmID) } }
    var body: some View {
        List {
            Section {
                Picker("Farm filter", selection: $farmID) {
                    Text("All farms I can access").tag("")
                    if !farmID.isEmpty, store.record("farms", farmID) == nil { Text("Farm requested by this link — service access check required").tag(farmID) }
                    ForEach(store.records("farms")) { Text($0.title).tag($0.id) }
                }.disabled(busy)
                Text(questionsOnly ? "Open a question to read what your adviser asked, save your reply and explicitly record when you have finished. Replying does not confirm a farm fact or approve a report." : "This paged list includes every recorded task state for the selected farm filter, not only the bounded unfinished-task preview on Home. Open a task to read its question, notes and actual state.")
                Button("Reload this task page") { Task { await load(offset) } }.disabled(busy || !store.sessionVerified)
            }
            if showChecklists { SyncBanner() }
            Section(questionsOnly ? "Questions on this loaded task page" : "All tasks on this server page") {
                if loaded {
                    if questionsOnly { Text("\(visibleRows.count) adviser questions on this page of \(rows.count) task records. Other task pages may contain more questions.").font(.footnote) }
                    if visibleRows.isEmpty { Text(questionsOnly ? "No adviser question was returned on this task page. This is not a claim that the whole workspace has none." : "The service returned no tasks for this page and farm filter.") }
                    ForEach(visibleRows) { item in NavigationLink { TaskAnswerView(taskID: item.id) } label: { VStack(alignment: .leading) { Text(item.title); Text(TaskReplyData.label(item.state)).font(.caption); if let date = item.data["due_date"], date != .null { Text("Recorded due date: " + date.text).font(.caption) } } } }
                    Text("Task records \(rows.isEmpty ? offset : offset + 1)–\(offset + rows.count) of \(total)").font(.footnote)
                    HStack { Button("Previous task page") { Task { await load(max(0, offset - 20)) } }.disabled(busy || offset == 0); Spacer(); Button("Next task page") { Task { await load(offset + rows.count) } }.disabled(busy || rows.isEmpty || offset + rows.count >= total) }
                } else {
                    Notice("The current task page has not loaded. Saved records below are device copies, not a complete list.", warning: true)
                    if offset > 0 { Button("Return to the first server page") { Task { await load(0) } }.disabled(busy || !store.sessionVerified) }
                    ForEach(cached) { task in NavigationLink(task.title + " · device copy") { TaskAnswerView(taskID: task.id) } }
                }
            }
            if showChecklists {
                Section("Saved checklists for this farm filter") {
                    let checklists = store.records("checklists").filter { farmID.isEmpty || $0.value("farm_id") == farmID }
                    if checklists.isEmpty { Text("No checklists are cached for this filter. This does not establish their absence from the service.") }
                    ForEach(checklists) { checklist in NavigationLink { FarmChecklistView(initial: checklist) } label: { RecordRow(item: checklist) } }
                    Notice("Checklist entries remain saved device copies here. The task list above loads actual server pages independently.")
                }
            }
            if busy { ProgressView("Loading this authorized task page…") }
            if !store.sessionVerified { Notice("Reconnect to read current questions or send your saved reply. Private reply drafts remain on this device.", warning: true) }
            if let problem { Notice(problem, warning: true) }
        }.navigationTitle(questionsOnly ? "Questions from my adviser" : showChecklists ? "Tasks and checklists" : "All tasks").task(id: farmID) { await load(0) }
            .refreshable { if showChecklists { await store.verifyAndRefresh() }; await load(offset) }
            .onChange(of: store.sessionVerified) { verified in if !verified { invalidate() } }
            .onChange(of: store.account?.scope) { _ in invalidate() }
            .onDisappear { requestID = UUID() }
    }
    private func invalidate() { requestID = UUID(); loaded = false; busy = false; rows = [] }
    private func load(_ requested: Int) async {
        let stamp = UUID(), scope = store.account?.scope, selectedFarm = farmID; requestID = stamp; busy = true; loaded = false; rows = []; offset = requested; problem = nil
        defer { if stamp == requestID { busy = false } }
        do {
            guard selectedFarm.isEmpty || UUID(uuidString: selectedFarm) != nil else { throw ServiceError(status: 0, message: "The requested farm filter is invalid. It was not replaced with all farms; choose a permitted farm explicitly.") }
            let value = try await store.scopedValue("/tasks?limit=20&offset=\(requested)" + (selectedFarm.isEmpty ? "" : "&farm_id=\(selectedFarm)"))
            let page = try JSONDecoder().decode(RecordPage.self, from: JSONEncoder().encode(value))
            guard stamp == requestID, scope == store.account?.scope, store.sessionVerified, !Task.isCancelled else { return }
            guard value.object["offset"] == .number(Double(requested)), value.object["limit"] == .number(20), page.items.count <= 20, page.total >= requested + page.items.count, !page.items.isEmpty || requested == page.total, page.items.allSatisfy({ $0.kind == "tasks" && $0.workspace_id == store.account?.workspace.id && (selectedFarm.isEmpty || $0.value("farm_id") == selectedFarm) }) else { throw ServiceError(status: 0, message: "The complete task page did not match this workspace and farm filter.") }
            rows = try page.items.map(TaskReplyData.normalized); total = page.total; loaded = true
        } catch { if stamp == requestID { problem = SourceText.error(error) } }
    }
}

struct TaskAnswerView: View {
    @EnvironmentObject private var store: AppStore
    let taskID: String
    @State private var current: RecordItem?
    @State private var grant: JSONValue?
    @State private var accountScope: String?
    @State private var notes = ""
    @State private var status = "open"
    @State private var expectedRevision = 0
    @State private var originalQuestion: JSONValue?
    @State private var completionReviewed = false
    @State private var compared = false
    @State private var pending: [String: JSONValue]?
    @State private var retryKey = UUID().uuidString
    @State private var knownRejected = false
    @State private var loadedDraft = false
    @State private var fresh = false
    @State private var busy = false
    @State private var confirmation = false
    @State private var requestID = UUID()
    @State private var operationTask: Task<Void, Never>?
    @State private var problem: String?
    @State private var savedNotice: String?
    private var formKey: String { "task-answer:" + taskID }
    private var currentGrantAllowsWrite: Bool { guard fresh, store.sessionVerified, accountScope == store.account?.scope, let current, let grant else { return false }; return TaskReplyData.allows(grant, farmID: current.value("farm_id"), writing: true) }
    private var conflict: Bool { current.map { $0.revision != expectedRevision } ?? false }
    private var answerRequired: Bool { current?.value("purpose") == "missing_information" && ["done", "cancelled"].contains(status) }
    private var data: [String: JSONValue] { ["notes": .string(notes), "status": .string(status)] }
    private var hasChanges: Bool { guard let current else { return false }; return notes != TaskReplyData.notes(current) || status != current.state }
    private var competingDraft: Bool { store.disk.queue.contains { $0.path == "/tasks/\(taskID)" } }
    private var canSave: Bool { loadedDraft && currentGrantAllowsWrite && !busy && !competingDraft && (pending != nil || (!conflict && hasChanges && TaskReplyData.statuses.contains(status) && notes.unicodeScalars.count <= 4000 && (!answerRequired || !notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && (status != "done" || completionReviewed))) }
    var body: some View {
        Form {
            if let current {
                Section(current.value("purpose") == "missing_information" ? "The original adviser question" : "The recorded task") {
                    Text(current.title).font(.title3.bold()).textSelection(.enabled)
                    if let description = current.data["description"], description != .null { Text(description.text).textSelection(.enabled) }
                    LabeledContent("Current recorded state", value: TaskReplyData.label(current.state))
                    LabeledContent("Current task revision", value: String(current.revision))
                    if let date = current.data["due_date"], date != .null { LabeledContent("Recorded due date", value: date.text) }
                    if let asked = current.data["asked_at"], asked != .null { LabeledContent("Asked at", value: asked.text) }
                    if let askedBy = current.data["asked_by"], askedBy != .null { LabeledContent("Asked by — recorded account", value: askedBy.text).font(.caption) }
                    Text("The question is read-only here. Saving a reply changes only your notes and the explicit task state.").font(.footnote)
                    relatedLinks(current)
                }
                Section("The reply currently saved in this workspace") {
                    Text(TaskReplyData.notes(current).isEmpty ? "No answer notes are recorded." : TaskReplyData.notes(current)).textSelection(.enabled)
                    if !fresh { Notice("Current authorization has not been established. Reload before changing this task.", warning: true) }
                    else if !currentGrantAllowsWrite { Notice("Your current grant is read-only for this task. You may read the question, but reply saving and completion are disabled.", warning: true) }
                    Button("Reload current question, notes and grant for comparison") { loadCurrent() }.disabled(busy || !store.sessionVerified)
                }
                Section("My answer and explicit task state") {
                    TextField("My answer to the question / what I actually did", text: $notes, axis: .vertical).lineLimit(5...14)
                    Picker("State I am recording", selection: $status) { ForEach(TaskReplyData.statuses, id: \.self) { Text(TaskReplyData.label($0)).tag($0) } }
                    if status == "done" { Toggle("I checked my answer and explicitly record this task as done", isOn: $completionReviewed) }
                    if answerRequired, notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { Notice(status == "cancelled" ? "Explain why this adviser question is being cancelled. An empty cancellation does not close the question." : "Answer the adviser question in the notes before marking it done. An empty completion is not a reply.", warning: true) }
                    if notes.unicodeScalars.count > 4000 { Notice("Keep this reply within 4,000 characters. Retain longer evidence in the related document workflow.", warning: true) }
                    LabeledContent("My draft's guarded task revision", value: String(expectedRevision))
                }.disabled(busy || pending != nil || !loadedDraft || (fresh && !currentGrantAllowsWrite))
                if conflict || knownRejected { comparisonSection(current) }
                Section {
                    Button(pending == nil ? (status == "done" ? "Save my reply and record done" : "Save my reply and task state") : "Retry the exact saved update") { confirmation = true }.buttonStyle(.borderedProminent).disabled(!canSave)
                    Button("Keep my unfinished reply privately on this device") { do { try persist(); savedNotice = "The reply draft is protected on this device. It has not changed the service task." } catch { problem = SourceText.error(error) } }.disabled(busy || !loadedDraft || accountScope != store.account?.scope)
                    if pending != nil { Notice("The last request may already have succeeded. Its exact body and retry key are retained; a retry never silently adopts another revision. Reload the task to inspect the actual saved reply.", warning: true) }
                    if let savedNotice { Notice(savedNotice) }
                    Notice("Task completion records a person's action. It does not confirm a farm fact, approve a report, submit a response or establish authority acceptance.")
                }
                if competingDraft { Section { Notice("An older task update is already in the device outbox. Review it before sending a second update; it has not been overwritten.", warning: true); NavigationLink("Review existing device drafts") { OutboxView() } } }
            } else { Section { Notice("The exact task has not loaded. Missing task data is not treated as an answered question.", warning: true); Button("Load the current task") { loadCurrent() }.disabled(busy || !store.sessionVerified) } }
            if busy { Section { ProgressView("Checking or saving this exact task…"); Button("Cancel") { cancel() } } }
            if !store.sessionVerified { Section { Notice("Reconnect before reading the current question or saving its reply. Protected device drafts are not completed automatically.", warning: true) } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Question and reply").autocorrectionDisabled().textInputAutocapitalization(.never)
            .onAppear { if !loadedDraft { restoreDraft() }; loadCurrent() }
            .onChange(of: data) { _ in if loadedDraft, pending == nil { completionReviewed = false; compared = false; savedNotice = nil; do { try persist() } catch { problem = SourceText.error(error) } } }
            .onChange(of: store.account?.scope) { _ in cancel(); current = nil; grant = nil; fresh = false }
            .onChange(of: store.sessionVerified) { verified in if !verified { cancel(); fresh = false; grant = nil; completionReviewed = false; compared = false } }
            .onDisappear { cancel(); fresh = false }
            .confirmationDialog(pending != nil ? "Retry the unchanged reply with its original revision and retry key?" : status == "done" ? "Save these exact answer notes and explicitly record this task as done?" : "Save these exact notes and task state?", isPresented: $confirmation, titleVisibility: .visible) { Button("Save this guarded task update") { save() } }
    }
    @ViewBuilder private func relatedLinks(_ task: RecordItem) -> some View {
        if let request = task.data["request_id"]?.text, UUID(uuidString: request) != nil { NavigationLink("Open the related request or letter") { DetailView(collection: "requests", id: request) } }
        if let document = task.data["document_id"]?.text, UUID(uuidString: document) != nil { NavigationLink("Open the related original document") { DetailView(collection: "documents", id: document) } }
        if let checklist = task.data["checklist_id"]?.text, UUID(uuidString: checklist) != nil { NavigationLink("Open the related checklist and its actual evidence checks") { DetailView(collection: "checklists", id: checklist) } }
        if let farm = task.data["farm_id"]?.text, UUID(uuidString: farm) != nil { NavigationLink("Review this farm's current obligations") { FarmComplianceView(initialFarmID: farm) } }
        if let sources = task.data["source_citations"] { SourceReferences(value: sources) }
    }
    private func comparisonSection(_ task: RecordItem) -> some View {
        Section("Compare before starting a different update") {
            Notice("Your draft keeps revision \(expectedRevision); the current task is revision \(task.revision). Its notes or question may have changed. Nothing is rebased automatically.", warning: true)
            if let originalQuestion { DisclosureGroup("Question context retained with my original draft") { SourceRowCells(value: originalQuestion.object) } }
            else { Notice("The older device draft did not retain its original question text. Compare the current question and notes carefully before keeping that draft.", warning: true) }
            Toggle("I compared the current question and saved notes with my typed reply at revision \(task.revision)", isOn: $compared).disabled(!currentGrantAllowsWrite || busy)
            Button("Keep my typed reply as a new guarded update at this compared revision") {
                guard compared, currentGrantAllowsWrite, pending == nil || knownRejected else { return }
                expectedRevision = task.revision; originalQuestion = TaskReplyData.question(task); pending = nil; knownRejected = false; retryKey = UUID().uuidString; compared = false; completionReviewed = false
                do { try persist() } catch { problem = SourceText.error(error) }
            }.disabled(busy || !compared || !currentGrantAllowsWrite || (pending != nil && !knownRejected))
            if let pending, task.revision > (SourceText.year(pending["expected_revision"]).flatMap { Int($0) } ?? Int.max), task.data["notes"] == pending["data"]?.object["notes"], task.data["status"] == pending["data"]?.object["status"] {
                Button("I see this exact reply is saved; clear the uncertain device intent without sending") { pendingResolved(task) }.disabled(busy || !fresh)
            }
        }
    }
    private func assertScope(_ scope: String) throws { guard scope == store.account?.scope, store.sessionVerified, !Task.isCancelled else { throw CancellationError() } }
    private func readCurrent(scope: String) async throws -> (RecordItem, JSONValue) {
        try assertScope(scope); guard let account = store.account else { throw CancellationError() }
        let before = try TaskReplyData.grant(try await store.scopedValue("/workspaces"), workspaceID: account.workspace.id)
        try assertScope(scope)
        let record = try TaskReplyData.normalized(JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue("/tasks/\(taskID)"))))
        guard record.id == taskID, record.kind == "tasks", record.workspace_id == account.workspace.id, UUID(uuidString: record.value("farm_id")) != nil, TaskReplyData.statuses.contains(record.state), TaskReplyData.allows(before, farmID: record.value("farm_id"), writing: false) else { throw ServiceError(status: 403, message: "The exact task did not match your current workspace and farm grant.") }
        try assertScope(scope)
        let after = try TaskReplyData.grant(try await store.scopedValue("/workspaces"), workspaceID: account.workspace.id)
        try assertScope(scope); guard before == after else { throw ServiceError(status: 409, message: "Your workspace grant changed while loading this task. Reload before replying.") }
        return (record, after)
    }
    private func restoreDraft() {
        accountScope = store.account?.scope
        do {
            let value = try store.loadForm(formKey) ?? store.loadForm("task-status:" + taskID)
            if let value { notes = value["notes"]?.text ?? ""; status = value["status"]?.text ?? "open"; expectedRevision = SourceText.year(value["expected_revision"]).flatMap { Int($0) } ?? 0; originalQuestion = value["original_question"] == .null ? nil : value["original_question"]; retryKey = value["retry_key"]?.text ?? retryKey; knownRejected = value["rejected"] == .bool(true); if case .object(let body)? = value["pending"] {
                guard Set(body.keys) == Set(["expected_revision", "data"]), let revision = SourceText.year(body["expected_revision"]).flatMap({ Int($0) }), revision > 0, Set((body["data"]?.object ?? [:]).keys) == Set(["notes", "status"]), case .string(_)? = body["data"]?.object["notes"], TaskReplyData.statuses.contains(body["data"]?.object["status"]?.text ?? "") else { throw ServiceError(status: 0, message: "The saved pending reply could not be read safely. It has not been sent or replaced.") }
                pending = body
            } }
            if let cached = store.record("tasks", taskID), cached.workspace_id == store.account?.workspace.id { let normalized = try TaskReplyData.normalized(cached); current = normalized; if value == nil { notes = TaskReplyData.notes(normalized); status = normalized.state; expectedRevision = normalized.revision; originalQuestion = TaskReplyData.question(normalized) } }
            loadedDraft = true
        } catch { problem = "The protected reply draft could not be opened. It was not replaced. " + SourceText.error(error) }
    }
    private func persist() throws {
        guard loadedDraft, let accountScope, accountScope == store.account?.scope else { throw CancellationError() }
        try store.saveForm(formKey, value: ["notes": .string(notes), "status": .string(status), "expected_revision": .number(Double(expectedRevision)), "original_question": originalQuestion ?? .null, "retry_key": .string(retryKey), "pending": pending.map(JSONValue.object) ?? .null, "rejected": .bool(knownRejected)])
    }
    private func loadCurrent() {
        guard !busy, let scope = accountScope, scope == store.account?.scope else { return }
        let stamp = requestID; busy = true; fresh = false; grant = nil; compared = false; completionReviewed = false; problem = nil
        operationTask = Task {
            defer { if stamp == requestID { busy = false; operationTask = nil } }
            do {
                let (record, membership) = try await readCurrent(scope: scope)
                guard stamp == requestID, scope == store.account?.scope, !Task.isCancelled else { return }
                current = record; grant = membership; fresh = true
                if expectedRevision == 0, pending == nil { expectedRevision = record.revision; notes = TaskReplyData.notes(record); status = record.state; originalQuestion = TaskReplyData.question(record); try persist() }
            } catch { if stamp == requestID { fresh = false; grant = nil; problem = SourceText.error(error) } }
        }
    }
    private func save() {
        guard canSave, let scope = accountScope, let oldGrant = grant else { return }
        let stamp = requestID; busy = true; problem = nil; savedNotice = nil
        operationTask = Task {
            defer { if stamp == requestID { busy = false; operationTask = nil } }
            var sentRequest = false
            do {
                let (latest, membership) = try await readCurrent(scope: scope)
                guard stamp == requestID, scope == store.account?.scope, !Task.isCancelled else { return }
                current = latest; grant = membership; fresh = true
                guard TaskReplyData.allows(membership, farmID: latest.value("farm_id"), writing: true) else { throw ServiceError(status: 403, message: "Your current task grant is read-only. This reply was not sent.") }
                guard membership == oldGrant else { completionReviewed = false; throw ServiceError(status: 409, message: "Your grant changed. Review the current task and reply before saving.") }
                if pending == nil {
                    guard latest.revision == expectedRevision else { completionReviewed = false; throw ServiceError(status: 409, message: "This task changed before saving. Compare both versions; your reply and original revision are retained.") }
                    pending = ["expected_revision": .number(Double(expectedRevision)), "data": .object(data)]; retryKey = UUID().uuidString; knownRejected = false; try persist()
                }
                guard let body = pending else { return }
                sentRequest = true
                let response = try await store.scopedValue("/tasks/\(taskID)", method: "PATCH", body: body, idempotency: retryKey)
                let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(response))
                guard stamp == requestID, scope == store.account?.scope, !Task.isCancelled else { return }
                guard record.id == taskID, record.kind == "tasks", record.workspace_id == store.account?.workspace.id, record.value("farm_id") == latest.value("farm_id"), record.data["notes"] == body["data"]?.object["notes"], record.data["status"] == body["data"]?.object["status"], TaskReplyData.question(record) == (originalQuestion ?? TaskReplyData.question(latest)) else { throw ServiceError(status: 0, message: "The service did not establish this exact reply without changing the original question. Its request remains retained.") }
                pendingResolved(record)
                do { _ = try await store.refreshDetail("tasks", taskID); guard stamp == requestID else { return }; await store.loadHome(farmID: record.value("farm_id")) } catch { if stamp == requestID { problem = "The reply was saved, but the current task list could not be refreshed. " + SourceText.error(error) } }
            } catch { if stamp == requestID { if pending != nil, sentRequest { knownRejected = [400, 404, 409, 422].contains((error as? ServiceError)?.status ?? 0) }; completionReviewed = false; try? persist(); problem = SourceText.error(error) } }
        }
    }
    private func pendingResolved(_ record: RecordItem) {
        guard accountScope == store.account?.scope else { return }
        current = record; expectedRevision = record.revision; notes = TaskReplyData.notes(record); status = record.state; originalQuestion = TaskReplyData.question(record); pending = nil; knownRejected = false; completionReviewed = false; compared = false; retryKey = UUID().uuidString; savedNotice = "This workspace records your reply at task revision \(record.revision), state: " + TaskReplyData.label(record.state) + ". No fact or report was approved."
        do { try persist() } catch { problem = "The service state is recorded above, but private draft cleanup failed. " + SourceText.error(error) }
    }
    private func cancel() { requestID = UUID(); operationTask?.cancel(); operationTask = nil; busy = false; compared = false; completionReviewed = false }
}
