import SwiftUI

struct FarmTaskListView: View {
    var initialFarmID: String? = nil
    var body: some View { NativeTaskListView(initialFarmID: initialFarmID, showChecklists: true).id(initialFarmID ?? "all-task-farms") }
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
