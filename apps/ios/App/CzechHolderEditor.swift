import SwiftUI

struct CzechHolderEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let farmID: String
    var existing: RecordItem? = nil
    var deviceDraft: PendingEdit? = nil
    @State private var value: [String: JSONValue] = [:]
    @State private var note = ""
    @State private var check: CaptureCheck?
    @State private var acknowledged: Set<String> = []
    @State private var loaded = false
    @State private var busy = false
    @State private var problem: String?
    @State private var predecessorID: String?
    @State private var boundRevision: Int?
    @State private var boundState: String?
    @State private var isCorrection = false
    @State private var sources: [JSONValue] = []
    private var formKey: String { "cz-journal:holder:" + (deviceDraft?.id.uuidString ?? existing?.id ?? farmID) }
    private var correction: Bool { loaded ? isCorrection : existing?.state == "confirmed" }
    private var request: [String: JSONValue] {
        var sources = self.sources
        let manual: JSONValue = .object(["kind": .string("manual"), "note": .string(note)])
        if !note.isEmpty, !sources.contains(manual) { sources.append(manual) }
        var data: [String: JSONValue] = ["farm_id": .string(farmID), "key": .string(CzechJournalData.holderKey), "label": .string("Holder for the Czech application journal"), "value": .object(value), "unit": .null, "period": .null, "temporal_basis": .string("static"), "sources": .array(sources), "review_status": .string("proposed")]
        if correction, let existing { data["supersedes_id"] = .string(existing.id) }
        else if let predecessorID { data["supersedes_id"] = .string(predecessorID) }
        var request: [String: JSONValue] = ["kind": .string("facts"), "data": .object(data)]
        if let existing, !correction { request["record_id"] = .string(existing.id); request["expected_revision"] = .number(Double(boundRevision ?? existing.revision)) }
        else if let id = deviceDraft?.payload["record_id"], let revision = deviceDraft?.payload["expected_revision"] { request["record_id"] = id; request["expected_revision"] = revision }
        return request
    }
    private func text(_ path: [String]) -> Binding<String> { Binding(get: { CzechJournalData.text(CzechJournalData.get(value, path)) }, set: { CzechJournalData.put(&value, path, $0.isEmpty ? nil : .string($0)) }) }
    var body: some View {
        Form {
            Section("Holder identity from your evidence") {
                Notice("Enter the actual holder. Farm display names do not establish a person's or company's legal identity. These details stay private in this workspace and selected reports.")
                if correction { Notice("This creates a proposed holder correction. The confirmed identity is retained until a separate fact review.", warning: true) }
                Picker("Holder type", selection: text(["kind"])) { Text("Choose from the source").tag(""); Text("Natural person").tag("natural_person"); Text("Legal person").tag("legal_person") }
                TextField("Holder name exactly as recorded", text: text(["name"]))
                TextField("Holder address exactly as recorded", text: text(["address"]), axis: .vertical)
                Picker("Identification number", selection: text(["identification_number", "status"])) { Text("Not established").tag("unknown"); Text("Provided in the source").tag("provided"); Text("Explicitly not assigned").tag("not_assigned") }
                if CzechJournalData.get(value, ["identification_number", "status"]) == .string("provided") { TextField("Actual identification number", text: text(["identification_number", "value"])) }
                if value["kind"] == .string("natural_person") { TextField("Actual birth date if required (YYYY-MM-DD)", text: text(["birth_date"])); Text("A natural person without an assigned identification number needs the actual birth date for a completed holder record. Unknown is not 'not assigned'.").font(.footnote) }
                if value["kind"] == .string("legal_person"), value["birth_date"] != nil { TextField("Previously supplied birth date — clear for a legal person", text: text(["birth_date"])) }
                TextField("Source checked and review note", text: $note, axis: .vertical)
            }
            Section("Check, then separately confirm") {
                Button("Check holder proposal") { runCheck() }.disabled(busy || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.sessionVerified)
                if let check {
                    ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                    ForEach(check.requires_acknowledgement, id: \.self) { code in Toggle(check.issues.first { $0.code == code }?.message ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                    DisclosureGroup("Structured holder to be proposed") { CzechHolderValues(value: check.normalized_data["value"]?.object ?? [:]) }
                }
                Button("Save checked holder proposal") { save(checked: true) }.buttonStyle(.borderedProminent).disabled(busy || check?.can_save != true || !Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged))
                Button("Keep unfinished holder on this device") { save(checked: false) }.disabled(busy)
                Notice("Open the saved holder fact to confirm or reject it. Saving this form never confirms identity or approves a journal.")
                if busy { ProgressView("Checking or saving holder…") }
                if let problem { Notice(problem, warning: true) }
            }
        }.autocorrectionDisabled().textInputAutocapitalization(.never)
            .navigationTitle("Journal holder").disabled(busy)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            .onAppear { fill() }
            .onChange(of: request) { _ in
                check = nil; acknowledged = []
                guard loaded, !busy else { return }
                do { try store.saveForm(formKey, value: request) } catch { problem = SourceText.error(error) }
            }
            .onChange(of: value["identification_number"]?.object["status"]) { status in if status != .string("provided") { CzechJournalData.put(&value, ["identification_number", "value"], nil) } }
    }
    private func fill() {
        guard !loaded else { return }; loaded = true
        do {
            let form = try store.loadForm(formKey) ?? deviceDraft?.payload
            boundRevision = SourceText.year(form?["expected_revision"]).flatMap { Int($0) } ?? existing?.revision
            boundState = existing?.state
            value = form?["data"]?.object["value"]?.object ?? existing?.data["value"]?.object ?? [:]
            if value["identification_number"] == nil { value["identification_number"] = .object(["status": .string("unknown")]) }
            predecessorID = form?["data"]?.object["supersedes_id"]?.text ?? existing?.data["supersedes_id"]?.text
            isCorrection = existing?.state == "confirmed" || (existing == nil && form?["record_id"] == nil && predecessorID != nil)
            sources = form?["data"]?.object["sources"]?.array ?? existing?.data["sources"]?.array ?? []
            note = form?["data"]?.object["sources"]?.array.last?.object["note"]?.text ?? ""
        } catch { problem = SourceText.error(error) }
    }
    private func runCheck() {
        let body = request; busy = true; problem = nil
        Task {
            do {
                if let existing { let current = try await store.refreshDetail("facts", existing.id); guard current.revision == boundRevision, current.state == boundState, current.data["superseded_by"] == nil else { throw ServiceError(status: 409, message: "The holder source revision changed. Keep this draft and reopen the current holder before checking a new correction.") } }
                else if let predecessorID { let predecessor = try await store.refreshDetail("facts", predecessorID); guard predecessor.state == "confirmed", predecessor.value("farm_id") == farmID, predecessor.data["superseded_by"] == nil else { throw ServiceError(status: 409, message: "This holder correction's confirmed predecessor changed. Open its current fact history instead of silently changing the correction link.") } }
                let result = try await store.checkCapture(body); if request == body { check = result; acknowledged = [] }
            } catch { check = nil; problem = SourceText.error(error) }
            busy = false
        }
    }
    private func save(checked: Bool) {
        do {
            guard !checked || (check?.can_save == true && Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged) && store.sessionVerified) else { return }
            let id = try store.saveCaptureDraft(body: request, review: checked ? check : nil, acknowledged: acknowledged, replacing: deviceDraft?.id, label: "Czech journal holder", reviewContext: ["type": .string("cz_journal_holder")])
            try? store.clearForm(formKey)
            if checked { busy = true; Task { await store.sync(onlyID: id); busy = false; dismiss() } }
            else { dismiss() }
        } catch { problem = SourceText.error(error) }
    }
}
