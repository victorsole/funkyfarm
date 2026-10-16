import SwiftUI

struct RegulatoryUpdatesView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    var deviceDraft: PendingEdit? = nil
    @State private var farmID = ""
    @State private var response: [String: JSONValue] = [:]
    @State private var enabled = true
    @State private var families: Set<String> = []
    @State private var readIDs: Set<String> = []
    @State private var revision = 0
    @State private var draftRevision = 0
    @State private var compared = false
    @State private var loaded = false
    @State private var working = false
    @State private var saved = false
    @State private var offset = 0
    @State private var problem: String?
    private let options = ["annual", "cap", "inputs", "inspection", "sustainability"]
    private var formKey: String { "regulatory-preferences:" + farmID }
    private var draft: [String: JSONValue] { ["enabled": .bool(enabled), "families": .array(families.sorted().map(JSONValue.string)), "read_event_ids": .array(readIDs.sorted().map(JSONValue.string)), "expected_revision": .number(Double(draftRevision))] }
    var body: some View {
        List {
            Section { FarmPicker(selected: Binding(get: { farmID }, set: { loaded = false; offset = 0; farmID = $0 })).disabled(working || deviceDraft != nil); Notice("An observed change to an official page is a prompt to review the source. It does not establish a new legal rule, effective date or required farm action.") }
            if loaded {
                Section("In-app notices") {
                    Toggle("Show relevant notices in this workspace", isOn: $enabled)
                    Text("No email or push messages are enabled here. Leaving all topics unselected includes all relevant topics.").font(.footnote).foregroundStyle(.secondary)
                    ForEach(options, id: \.self) { topic in Toggle(topic.capitalized, isOn: Binding(get: { families.contains(topic) }, set: { if $0 { families.insert(topic) } else { families.remove(topic) } })) }
                }
                Section("Official-source observations") {
                    let items = response["items"]?.array ?? []
                    if items.isEmpty { Text("No observations were returned for this farm.").foregroundStyle(.secondary) }
                    ForEach(Array(items.enumerated()), id: \.offset) { _, value in
                        let item = value.object
                        DisclosureGroup(item["title"]?.text ?? "Source observation") {
                            Text("Unreviewed official-page change").font(.caption.weight(.semibold))
                            if let date = item["detected_at"] { LabeledContent("Observed", value: date.text) }
                            LabeledContent("Effective date", value: item["effective_date"] == nil || item["effective_date"] == .null ? "Not established" : item["effective_date"]!.text)
                            if let relevance = item["relevance"] { Text(relevance.text) }
                            if let action = item["required_action"] { Text(action.text) }
                            if let notice = item["notice"] { Notice(notice.text) }
                            if let text = item["url"]?.text, let url = URL(string: text), url.scheme == "https" { Link("Read the official source", destination: url) }
                            if let id = item["id"]?.text { Toggle("I have read this observation", isOn: Binding(get: { readIDs.contains(id) }, set: { if $0 { readIDs.insert(id) } else { readIDs.remove(id) } })) }
                            Text("Read status is not legal approval.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    HStack { Button("Previous observations") { page(max(0, offset - 20)) }.disabled(offset == 0 || working); Spacer(); if let total = response["total"] { Text("\(offset + items.count) of \(total.text)").font(.caption) }; Spacer(); Button("More observations") { page(offset + 20) }.disabled(working || !hasMore) }
                }
                Section("Save your choices") {
                    if draftRevision != revision { Notice("The device draft used revision \(draftRevision); the service returned revision \(revision). Compare the current preferences before keeping your changes.", warning: true); DisclosureGroup("Current service preferences") { JSONFields(data: response["preferences"]?.object ?? [:]) }; Toggle("I compared my choices with the current preferences", isOn: $compared) }
                    Button("Save preferences on this device") { save() }.buttonStyle(.borderedProminent).disabled(saved || (draftRevision != revision && !compared))
                    if saved { Notice("Preferences are in the device outbox. The service changes only after successful synchronization."); NavigationLink("Review device drafts") { OutboxView() } }
                    if let monitor = response["monitor"] { DisclosureGroup("Source monitor coverage") { JSONFields(data: monitor.object) } }
                    if let notice = response["notice"] { Notice(notice.text) }
                }
            }
            if working { Section { ProgressView("Loading source observations…") } }
            if let problem { Section { Notice(problem, warning: true); Button("Reload current observations") { Task { await load() } }.disabled(working) } }
        }.navigationTitle("Source updates")
            .onAppear { if farmID.isEmpty { farmID = initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "") } }
            .task(id: farmID + ":" + String(offset)) { await load() }
            .onChange(of: draft) { value in guard loaded else { return }; saved = false; do { try store.saveForm(formKey, value: value) } catch { problem = error.localizedDescription } }
    }
    private var hasMore: Bool { if case .number(let total)? = response["total"] { return offset + (response["items"]?.array.count ?? 0) < Int(total) }; return false }
    private func page(_ next: Int) {
        do { try store.saveForm(formKey, value: draft); loaded = false; offset = next } catch { problem = error.localizedDescription }
    }
    private func load() async {
        loaded = false; response = [:]; compared = false; saved = false; problem = nil
        guard !farmID.isEmpty else { return }; let selected = farmID, selectedOffset = offset
        working = true; defer { working = false }
        do {
            let result = try await store.scopedValue("/regulatory/updates?farm_id=\(selected)&limit=20&offset=\(selectedOffset)").object
            guard farmID == selected, offset == selectedOffset else { return }; response = result
            let prefs = result["preferences"]?.object ?? [:]
            guard case .number(let number)? = prefs["revision"] else { throw ServiceError(status: 0, message: "The service returned no preference revision. Saving is unavailable.") }
            revision = Int(number); draftRevision = revision
            enabled = prefs["enabled"] == .bool(true); families = Set((prefs["families"]?.array ?? []).map(\.text)); readIDs = Set((prefs["read_event_ids"]?.array ?? []).map(\.text))
            if let saved = try store.loadForm(formKey) ?? deviceDraft?.payload { enabled = saved["enabled"] == .bool(true); families = Set((saved["families"]?.array ?? []).map(\.text)); readIDs = Set((saved["read_event_ids"]?.array ?? []).map(\.text)); if case .number(let n)? = saved["expected_revision"] { draftRevision = Int(n) } }
            loaded = true
        } catch { problem = error.localizedDescription }
    }
    private func save() {
        guard loaded, draftRevision == revision || compared else { return }
        do { var body = draft; body["farm_id"] = .string(farmID); body["expected_revision"] = .number(Double(revision)); try store.saveAction(path: "/regulatory/preferences", label: "Source-update preferences", payload: body, replacing: deviceDraft?.id); try? store.clearForm(formKey); saved = true }
        catch { problem = error.localizedDescription }
    }
}
