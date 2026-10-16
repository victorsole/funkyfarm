import SwiftUI

struct FarmTaskListView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    @State private var farmID = ""
    private func items(_ kind: String) -> [RecordItem] { farmID.isEmpty ? [] : store.records(kind).filter { $0.value("farm_id") == farmID } }
    var body: some View {
        List {
            Section { FarmPicker(selected: $farmID); Notice("Tasks and checklists track the actions you record. They do not automatically confirm farm facts, resolve rule conflicts or establish compliance.") }
            SyncBanner()
            Section("Tasks") {
                if items("tasks").isEmpty { Text(farmID.isEmpty ? "Choose a farm to view its tasks." : "No tasks are loaded for this farm.").foregroundStyle(.secondary) }
                ForEach(items("tasks")) { task in NavigationLink { FarmTaskDetailView(initial: task) } label: { RecordRow(item: task) } }
            }
            Section("Checklists") {
                if items("checklists").isEmpty { Text("No checklists are loaded for this farm.").foregroundStyle(.secondary) }
                ForEach(items("checklists")) { checklist in NavigationLink { FarmChecklistView(initial: checklist) } label: { RecordRow(item: checklist) } }
            }
        }.navigationTitle("Tasks and checklists")
            .onAppear { if farmID.isEmpty { farmID = initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "") } }
            .refreshable { await store.verifyAndRefresh() }
    }
}

struct FarmTaskDetailView: View {
    @EnvironmentObject private var store: AppStore
    let initial: RecordItem
    @State private var base: RecordItem?
    @State private var selectedStatus = "open"
    @State private var notes = ""
    @State private var draftRevision = 0
    @State private var compared = false
    @State private var doneReviewed = false
    @State private var loading = false
    @State private var loaded = false
    @State private var saved = false
    @State private var problem: String?
    private var current: RecordItem { base ?? initial }
    private var formKey: String { "task-status:" + initial.id }
    private var draft: [String: JSONValue] { ["status": .string(selectedStatus), "notes": .string(notes), "expected_revision": .number(Double(draftRevision))] }
    private var requiresComparison: Bool { draftRevision > 0 && draftRevision != current.revision }
    var body: some View {
        Form {
            Section("Recorded task") {
                Text(current.title).font(.title3.bold())
                if !current.value("description").isEmpty { Text(current.value("description")) }
                LabeledContent("Current recorded state", value: current.value("status").replacingOccurrences(of: "_", with: " "))
                if !current.value("due_date").suppliedValue.isEmpty { LabeledContent("Recorded due date", value: current.value("due_date")) }
                LabeledContent("Compared revision", value: "\(current.revision)")
                if let citations = current.data["source_citations"] { SourceReferences(value: citations) }
                if let checklistID = current.data["checklist_id"]?.text, UUID(uuidString: checklistID) != nil { NavigationLink("Open the related checklist") { DetailView(collection: "checklists", id: checklistID) } }
                if let farmID = current.data["farm_id"]?.text { NavigationLink("Review this farm's current obligations") { FarmComplianceView(initialFarmID: farmID) } }
            }
            Section("Your update") {
                Picker("Task state", selection: $selectedStatus) { Text("Open").tag("open"); Text("In progress").tag("in_progress"); Text("Done").tag("done"); Text("Cancelled").tag("cancelled") }
                TextField("What did you check or do?", text: $notes, axis: .vertical)
                if selectedStatus == "done", current.value("status") != "done" { Toggle("I checked that this task is done", isOn: $doneReviewed) }
                if requiresComparison {
                    Notice("The saved device draft used revision \(draftRevision). The current task is revision \(current.revision). Compare the recorded task before keeping your update.", warning: true)
                    Toggle("I compared my update with this current revision", isOn: $compared)
                }
                Button("Save task update on this device") { save() }.buttonStyle(.borderedProminent).disabled(loading || saved || (requiresComparison && !compared) || (selectedStatus == "done" && current.value("status") != "done" && !doneReviewed))
                if saved { Notice("Your update is saved in the device outbox. The current server state changes only after synchronization succeeds."); NavigationLink("Review device drafts") { OutboxView() } }
                Notice("Marking this task done records your action. It does not approve an administrative response or certify legal compliance.")
            }.disabled(loading)
            Section { RecordMetadata(item: current) }
            if loading { Section { ProgressView("Loading current task…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Task")
            .task { await load() }
            .onChange(of: draft) { value in guard loaded else { return }; saved = false; do { try store.saveForm(formKey, value: value) } catch { problem = error.localizedDescription } }
            .onChange(of: selectedStatus) { _ in doneReviewed = false }
    }
    private func load() async {
        guard !loaded else { return }; loading = true; defer { loading = false }
        base = store.record("tasks", initial.id) ?? initial
        if store.sessionVerified { do { base = try await store.refreshDetail("tasks", initial.id) } catch { problem = error.localizedDescription } }
        selectedStatus = current.value("status"); notes = current.value("notes").suppliedValue; draftRevision = current.revision
        do { if let value = try store.loadForm(formKey) { selectedStatus = value["status"]?.text ?? selectedStatus; notes = value["notes"]?.text ?? notes; if case .number(let revision)? = value["expected_revision"] { draftRevision = Int(revision) } } }
        catch { problem = "The saved device update could not be opened: \(error.localizedDescription)" }
        loaded = true
    }
    private func save() {
        guard !requiresComparison || compared else { return }
        do { var data = current.data; data["status"] = .string(selectedStatus); data["notes"] = .string(notes); try store.saveEdit(collection: "tasks", existing: current, data: data, label: current.title); try? store.clearForm(formKey); saved = true }
        catch { problem = error.localizedDescription }
    }
}

struct FarmChecklistView: View {
    @EnvironmentObject private var store: AppStore
    let initial: RecordItem
    @State private var base: RecordItem?
    @State private var items: [[String: JSONValue]] = []
    @State private var draftRevision = 0
    @State private var compared = false
    @State private var loading = false
    @State private var loaded = false
    @State private var saved = false
    @State private var problem: String?
    private var current: RecordItem { base ?? initial }
    private var formKey: String { "checklist-items:" + initial.id }
    private var draft: [String: JSONValue] { ["items": .array(items.map(JSONValue.object)), "expected_revision": .number(Double(draftRevision))] }
    var body: some View {
        List {
            Section { Text(current.title).font(.title3.bold()); Notice("Only mark an item after checking the action and its supporting evidence. These marks are task tracking, not compliance approval."); LabeledContent("Current revision", value: "\(current.revision)") }
            Section("Review each action") {
                ForEach(items.indices, id: \.self) { index in
                    DisclosureGroup(items[index]["label"]?.text ?? items[index]["key"]?.text ?? "Checklist item") {
                        Toggle("I checked this action is done", isOn: Binding(get: { items[index]["done"] == .bool(true) }, set: { items[index]["done"] = .bool($0) }))
                        TextField("Action or evidence note", text: Binding(get: { items[index]["note"]?.text.suppliedValue ?? "" }, set: { items[index]["note"] = .string($0) }), axis: .vertical)
                        if let deadline = items[index]["deadline"], deadline != .null { LabeledContent("Recorded deadline", value: deadline.text) }
                        ForEach((items[index]["evidence_ids"]?.array ?? []).map(\.text), id: \.self) { id in NavigationLink("Open recorded evidence") { DetailView(collection: "documents", id: id) } }
                    }
                }
            }.disabled(loading)
            Section {
                if draftRevision > 0, draftRevision != current.revision {
                    Notice("The device draft used revision \(draftRevision). Compare these choices with the current checklist before saving a new guarded update.", warning: true)
                    DisclosureGroup("Current recorded checklist items") { Text(current.data["items"]?.text ?? "").font(.callout).textSelection(.enabled) }
                    Toggle("I compared my choices with the current items", isOn: $compared)
                }
                Button("Save checklist update on this device") { save() }.buttonStyle(.borderedProminent).disabled(loading || saved || (draftRevision > 0 && draftRevision != current.revision && !compared))
                if saved { Notice("The checklist update is saved on this device and awaits successful synchronization."); NavigationLink("Review device drafts") { OutboxView() } }
                RecordMetadata(item: current)
            }
            if loading { Section { ProgressView("Loading current checklist…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Checklist").task { await load() }
            .onChange(of: draft) { value in guard loaded else { return }; saved = false; do { try store.saveForm(formKey, value: value) } catch { problem = error.localizedDescription } }
    }
    private func load() async {
        guard !loaded else { return }; loading = true; defer { loading = false }
        base = store.record("checklists", initial.id) ?? initial
        if store.sessionVerified { do { base = try await store.refreshDetail("checklists", initial.id) } catch { problem = error.localizedDescription } }
        items = current.data["items"]?.array.map(\.object) ?? []; draftRevision = current.revision
        do { if let value = try store.loadForm(formKey) { items = value["items"]?.array.map(\.object) ?? items; if case .number(let revision)? = value["expected_revision"] { draftRevision = Int(revision) } } }
        catch { problem = "The saved checklist choices could not be opened: \(error.localizedDescription)" }
        loaded = true
    }
    private func save() {
        guard draftRevision == current.revision || compared else { return }
        do { var data = current.data; data["items"] = .array(items.map(JSONValue.object)); try store.saveEdit(collection: "checklists", existing: current, data: data, label: current.title); try? store.clearForm(formKey); saved = true }
        catch { problem = error.localizedDescription }
    }
}
