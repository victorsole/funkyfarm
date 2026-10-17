import SwiftUI

struct ImportRowReview: View {
    @EnvironmentObject private var store: AppStore
    let importID: String
    let sourceOffset: Int
    let initial: [String: JSONValue]
    @State private var preview: [String: JSONValue] = [:]
    @State private var imported: RecordItem?
    @State private var row: RecordItem?
    @State private var schema: [String: JSONValue] = [:]
    @State private var importRevision = 0
    @State private var acknowledged: Set<String> = []
    @State private var note = ""
    @State private var compared = false
    @State private var working = false
    @State private var currentLoaded = false
    @State private var pendingIntent = false
    @State private var reconciledAfterIntent = false
    @State private var outcome: String?
    @State private var frozenOffset: Int?
    @State private var problem: String?
    private var initialID: String { initial["row"]?.object["id"]?.text ?? "" }
    private var formKey: String { "import-row-review:" + importID + ":" + initialID }
    private var intentKey: String { formKey + ":pending-intent" }
    private var promoted: Bool { row?.data["promoted_record"] != nil && row?.data["promoted_record"] != .null }
    private var issues: [JSONValue] { preview["issues"]?.array ?? [] }
    private var warnings: Set<String> { Set((preview["requires_acknowledgement"]?.array ?? []).map(\.text)) }
    private var canSend: Bool { currentLoaded && !working && !pendingIntent && !promoted && compared && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && note.count <= 4_000 && preview["can_save"] == .bool(true) && warnings.isSubset(of: acknowledged) && importRevision > 0 && store.sessionVerified }
    var body: some View {
        List {
            Section { Notice("Compare this original row with the proposed values. Saving a row creates a proposal only; its fact or work review is separate.") }
            if let row, let imported {
                Section("Original source row") { Text(imported.value("source_name")).font(.headline); LabeledContent("Source row", value: row.value("row_number")); OriginalImportCells(columns: imported.data["columns"]?.array ?? [], cells: row.data["original_row"]?.array ?? []); PromotedImportRecordLink(importID: importID, row: row.data) }
                Section("Proposed values, without source conversion") {
                    let values = preview["normalized_data"]?.object ?? preview["data"]?.object ?? [:]
                    if case .object(let raw)? = values["value"], !schema.isEmpty { SourceRowCells(value: raw, schema: schema) }
                    else { SourceRowCells(value: values) }
                }
            }
            if pendingIntent {
                Section("Check the previous send first") {
                    Notice("This row review may already have reached the service. No automatic replay is made. Reload the original row and inspect its existing proposed record before considering another review.", warning: true)
                    Button("Reload the row and check its promotion") { Task { await load() } }.disabled(working)
                    if reconciledAfterIntent {
                        Text(promoted ? "The current original row links to an existing record above. Open that record to inspect its review state; do not promote the row again." : "A fresh service response shows no promoted record for this exact source row.")
                        Button(promoted ? "Keep the existing proposal and finish reconciliation" : "I checked the current row; prepare a new review") { clearReconciledIntent() }.disabled(working)
                    }
                }
            }
            Section("Checks to review") {
                ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? "Source issue", warning: issue.object["severity"] == .string("error")) }
                ForEach(warnings.sorted(), id: \.self) { code in Toggle(issues.first { $0.object["code"]?.text == code }?.object["message"]?.text ?? code.replacingOccurrences(of: "_", with: " "), isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                Toggle("I compared the original row with these proposed values", isOn: $compared)
                TextField("What did you check in the original source?", text: $note, axis: .vertical)
                Button("Create a proposed record from this reviewed row") { review() }.buttonStyle(.borderedProminent).disabled(!canSend)
                if let outcome { Notice(outcome) }
                if !schema.isEmpty { NavigationLink("Review the source profile and farm again") { ImportProfileReviewView(importID: importID) } }
                Button("Reload current values and checks") { Task { await load() } }.disabled(working)
                if working { ProgressView("Checking the current source row…") }
                if let problem { Notice(problem, warning: true) }
            }.disabled(working)
        }.navigationTitle("Review source row")
            .task { do { if let draft = try store.loadForm(formKey) { note = draft["note"]?.text ?? "" }; if let intent = try store.loadForm(intentKey) { pendingIntent = true; if case .number(let n)? = intent["source_offset"], n >= 0, n < 50_000, n.rounded() == n { frozenOffset = Int(n) } } } catch { pendingIntent = true; problem = "The previous review intent could not be opened. Reload the row before any new send." }; await load() }
            .onChange(of: note) { value in do { try store.saveForm(formKey, value: ["note": .string(value)]) } catch { problem = error.localizedDescription } }
    }
    private func load() async {
        working = true; currentLoaded = false; reconciledAfterIntent = false; acknowledged = []; compared = false; preview = [:]; schema = [:]
        defer { working = false }
        do {
            let offset = frozenOffset ?? sourceOffset
            let response = try await store.scopedValue("/imports/\(importID)?limit=1&offset=\(offset)")
            let source = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(response))
            let rows = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(response.object["rows"]?.object["items"] ?? .array([])))
            guard source.workspace_id == store.account?.workspace.id, let currentRow = rows.first, currentRow.id == initialID, currentRow.workspace_id == source.workspace_id, currentRow.data["row_number"] == initial["row"]?.object["data"]?.object["row_number"] else { throw ServiceError(status: 0, message: "The authorized original row has changed or is unavailable. No review can be submitted.") }
            imported = source; row = currentRow
            // Only this fresh post-attempt row response can reconcile a durable intent.
            reconciledAfterIntent = pendingIntent
            let page = try await store.scopedValue("/imports/\(importID)/preview?limit=1&offset=\(offset)").object
            guard let value = page["items"]?.array.first?.object, value["row"]?.object["id"] == .string(initialID), value["row"]?.object["revision"] == .number(Double(currentRow.revision)), page["import_revision"] == .number(Double(source.revision)) else { throw ServiceError(status: 409, message: "The source or row changed while loading. Reload and compare again.") }
            importRevision = source.revision; preview = value
            if let profileID = source.data["format_profile"]?.text, source.data["format_profile"] != .null {
                let catalogue = try await store.scopedValue("/imports/profiles").object["items"]?.array.map(\.object) ?? []
                guard let definition = catalogue.first(where: { $0["id"]?.text == profileID }), let farmID = source.data["farm_id"]?.text else { throw ServiceError(status: 0, message: "The prepared source definition is unavailable.") }
                schema = definition
                let farm = try await store.refreshDetail("farms", farmID)
                guard ImportProfileState.valid(item: source, profile: definition, farm: farm) else { throw ServiceError(status: 409, message: "The source definition, holding, source year or farm revision needs a fresh profile review.", code: "profile_review_required") }
            }
            currentLoaded = true
        } catch { problem = SourceText.error(error); currentLoaded = false }
    }
    private func clearReconciledIntent() {
        guard pendingIntent, reconciledAfterIntent else { return }
        do { try store.clearForm(intentKey); pendingIntent = false; reconciledAfterIntent = false; acknowledged = []; compared = false }
        catch { problem = error.localizedDescription }
    }
    private func review() {
        guard canSend, let row, let number = row.data["row_number"], let token = preview["preview_token"] else { return }
        let body: [String: JSONValue] = ["expected_revision": .number(Double(importRevision)), "note": .string(note), "rows": .array([.object(["row_number": number, "expected_revision": .number(Double(row.revision)), "preview_token": token, "acknowledged_issues": .array(acknowledged.sorted().map(JSONValue.string))])])]
        let offset = frozenOffset ?? sourceOffset
        do { try store.saveForm(intentKey, value: ["body": .object(body), "row_id": .string(row.id), "source_offset": .number(Double(offset)), "stage": .string("send_outcome_unconfirmed")]); frozenOffset = offset }
        catch { problem = "The review intent could not be saved privately. Nothing was sent. " + error.localizedDescription; return }
        pendingIntent = true; reconciledAfterIntent = false; working = true; currentLoaded = false; problem = nil
        Task {
            do {
                // No Idempotency-Key: this endpoint has no replay contract.
                let result = try await store.scopedValue("/imports/\(importID)/rows/review", method: "POST", body: body).object
                guard case .number(let saved)? = result["saved_count"], case .number(let failed)? = result["failed_count"], saved >= 0, failed >= 0, saved + failed == 1, result["items"]?.array.count == 1, let selected = result["items"]?.array.first?.object, selected["row_number"] == number, [JSONValue.string("saved"), .string("failed")].contains(selected["status"] ?? .null) else { throw ServiceError(status: 0, message: "The service response did not establish this row's outcome. Reload the original row before any further action.") }
                outcome = "The service returned \(Int(saved)) saved and \(Int(failed)) failed rows. Saved records are proposals, not confirmations."
                if selected["status"] == .string("failed") { problem = selected["error"]?.object["message"]?.text ?? "This row was not saved. Reload its current checks." }
                await load()
            } catch { problem = SourceText.error(error); acknowledged = []; compared = false; currentLoaded = false }
            working = false
        }
    }
}
