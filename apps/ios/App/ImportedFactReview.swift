import SwiftUI

struct ImportedFactReviewView: View {
    @EnvironmentObject private var store: AppStore
    let factID: String
    let importID: String
    @State private var fact: RecordItem?
    @State private var imported: RecordItem?
    @State private var original: RecordItem?
    @State private var schema: [String: JSONValue] = [:]
    @State private var compared = false
    @State private var note = ""
    @State private var working = false
    @State private var sourceCurrent = false
    @State private var confirm = false
    @State private var problem: String?
    @State private var reviewKey = UUID().uuidString
    var body: some View {
        List {
            if let fact {
                Section("Separate fact review") { Text(fact.title).font(.title3.bold()); LabeledContent("Current review state", value: fact.state); LabeledContent("Source period", value: fact.value("period")); Notice("Row promotion created a proposal only. Compare every source value before confirming it. No current farm field, date, unit or eligibility is inferred.") }
                if let imported, let original { Section("Original source row") { Text(imported.value("source_name")).font(.headline); LabeledContent("Original row", value: original.value("row_number")); OriginalImportCells(columns: imported.data["columns"]?.array ?? [], cells: original.data["original_row"]?.array ?? []) } }
                Section("Proposed source values") { if case .object(let values)? = fact.data["value"] { SourceRowCells(value: values, schema: schema) } else { SourceCellValue(value: fact.data["value"]) } }
                Section("Your decision") {
                    Toggle("I compared the proposal with this original source row", isOn: $compared)
                    TextField("What did you check?", text: $note, axis: .vertical)
                    if fact.state == "proposed" {
                        Button("Confirm this source fact") { confirm = true }.buttonStyle(.borderedProminent).disabled(!canReview)
                        Button("Reject this source proposal", role: .destructive) { review("rejected") }.disabled(working || !sourceCurrent || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.sessionVerified)
                    }
                    if !sourceCurrent { Notice("The source or its current review could not be verified. Reload it or review the prepared profile before any decision.", warning: true) }
                    NavigationLink("Review the current source profile") { ImportProfileReviewView(importID: importID) }
                    Button("Reload current fact and original row") { Task { await load() } }.disabled(working)
                }.disabled(working)
            }
            if working { Section { ProgressView("Comparing the authorized source…") } }
            if let problem { Section { Notice(problem, warning: true) } }
            if fact == nil && !working { Button("Reload source fact") { Task { await load() } } }
        }.navigationTitle("Review imported fact").task { do { note = try store.loadForm("imported-fact-note:" + factID)?["note"]?.text ?? "" } catch { problem = error.localizedDescription }; await load() }
            .onChange(of: note) { value in do { try store.saveForm("imported-fact-note:" + factID, value: ["note": .string(value)]) } catch { problem = error.localizedDescription } }
            .confirmationDialog("Confirm this exact source fact revision after comparing the original row?", isPresented: $confirm, titleVisibility: .visible) { Button("Confirm source fact") { review("confirmed") } }
    }
    private var canReview: Bool { fact?.state == "proposed" && sourceCurrent && compared && !working && store.sessionVerified && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func load() async {
        working = true; sourceCurrent = false; compared = false; fact = nil; original = nil; imported = nil; schema = [:]; reviewKey = UUID().uuidString
        defer { working = false }
        do {
            let currentFact = try await store.refreshDetail("facts", factID)
            let source = (currentFact.data["sources"]?.array ?? []).map(\.object).first { $0["import_id"]?.text == importID }
            guard let source, case .number(let rowNumber)? = source["row_number"], rowNumber >= 1, rowNumber <= 50_000, rowNumber.rounded() == rowNumber else { throw ServiceError(status: 0, message: "This fact has no matching original import-row reference.") }
            let value = try await store.scopedValue("/imports/\(importID)?limit=1&offset=\(Int(rowNumber) - 1)")
            let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value))
            let rows = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(value.object["rows"]?.object["items"] ?? .array([])))
            guard record.workspace_id == store.account?.workspace.id, currentFact.workspace_id == record.workspace_id, record.data["farm_id"] == nil || record.data["farm_id"] == .null || record.data["farm_id"] == currentFact.data["farm_id"], let row = rows.first, row.workspace_id == record.workspace_id, row.data["row_number"] == .number(rowNumber), source["row_id"] == .string(row.id), row.data["promoted_record"]?.object["id"] == .string(factID) else { throw ServiceError(status: 0, message: "The current source row does not match this farm fact. No review is enabled.") }
            imported = record; original = row; fact = currentFact
            if let profileID = record.data["format_profile"]?.text, record.data["format_profile"] != .null {
                let profiles = try await store.scopedValue("/imports/profiles").object["items"]?.array.map(\.object) ?? []
                guard let definition = profiles.first(where: { $0["id"]?.text == profileID }), let farmID = record.data["farm_id"]?.text else { throw ServiceError(status: 0, message: "The prepared source definition is unavailable.") }
                let farm = try await store.refreshDetail("farms", farmID); schema = definition
                sourceCurrent = ImportProfileState.valid(item: record, profile: definition, farm: farm)
            } else { sourceCurrent = true }
        } catch { sourceCurrent = false; problem = SourceText.error(error) }
    }
    private func review(_ decision: String) {
        guard let fact, sourceCurrent, !working, store.sessionVerified, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, decision != "confirmed" || compared else { return }
        working = true; problem = nil
        Task { do { try await store.mutate("/facts/\(fact.id)/review", body: ["expected_revision": .number(Double(fact.revision)), "decision": .string(decision), "note": .string(note)], idempotency: reviewKey); try? store.clearForm("imported-fact-note:" + factID); await load() } catch { compared = false; sourceCurrent = false; problem = SourceText.error(error) }; working = false }
    }
}

struct SourceTableFactsView: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    let profileID: String
    private var facts: [RecordItem] { store.records("facts").filter { $0.data["farm_id"] == .string(farmID) && ($0.data["sources"]?.array ?? []).contains { $0.object["adapter_profile"] == .string(profileID) } } }
    var body: some View {
        List {
            Section { Notice("These loaded facts retain their source rows. A proposed record is not confirmed, and an old source year does not become a current observation."); Button("Refresh authorized facts") { Task { await store.verifyAndRefresh() } }.disabled(store.busy) }
            ForEach(facts) { fact in
                if let importID = (fact.data["sources"]?.array ?? []).compactMap({ $0.object["import_id"]?.text }).first { NavigationLink { ImportedFactReviewView(factID: fact.id, importID: importID) } label: { RecordRow(item: fact) } }
            }
            if facts.isEmpty { Text("No matching source facts are present in the loaded records. Import and review the source rows first, or refresh your access.").foregroundStyle(.secondary) }
            SyncBanner()
        }.navigationTitle("Source facts").task { await store.verifyAndRefresh() }.refreshable { await store.verifyAndRefresh() }
    }
}
