import SwiftUI

enum ImportProfileState {
    static func valid(item: RecordItem, profile: [String: JSONValue], farm: RecordItem) -> Bool {
        let data = item.data, review = data["profile_review"]?.object ?? [:]
        guard let id = profile["id"], let hash = profile["definition_hash"], let year = profile["source_year"], let holding = data["holding_reference"], case .string(let rawHolding) = holding, !rawHolding.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return data["format_profile"] == id && data["farm_id"] == .string(farm.id) && farm.data["country"] == profile["country"] && data["source_year"] == year && data["profile_definition_hash"] == hash && review["profile_id"] == id && review["definition_hash"] == hash && review["source_year"] == year && review["holding_reference"] == holding && review["farm_revision"] == .number(Double(farm.revision)) && review["confirmed_source"] == .bool(true) && [JSONValue.string("."), .string(",")].contains(review["decimal_separator"] ?? .null)
    }
}

struct ImportProfileReviewView: View {
    @EnvironmentObject private var store: AppStore
    let importID: String
    @State private var item: RecordItem?
    @State private var farm: RecordItem?
    @State private var profile: [String: JSONValue] = [:]
    @State private var decimal = ""
    @State private var checkedFarm = false
    @State private var checkedYear = false
    @State private var checkedSource = false
    @State private var actionKey = UUID().uuidString
    @State private var working = false
    @State private var ready = false
    @State private var problem: String?
    private var formKey: String { "source-profile-review:" + importID }
    private var context: [String: JSONValue] { ["import_revision": .number(Double(item?.revision ?? 0)), "farm_id": .string(farm?.id ?? ""), "farm_revision": .number(Double(farm?.revision ?? 0)), "profile_id": profile["id"] ?? .null, "definition_hash": profile["definition_hash"] ?? .null, "source_year": item?.data["source_year"] ?? .null, "holding_reference": item?.data["holding_reference"] ?? .null] }
    private var reviewed: Bool { guard ready, let item, let farm else { return false }; return ImportProfileState.valid(item: item, profile: profile, farm: farm) }
    private var canReview: Bool {
        guard ready, let item, let farm, case .string(let holding)? = item.data["holding_reference"], !holding.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return item.data["source_year"] == profile["source_year"] && farm.data["country"] == profile["country"] && !decimal.isEmpty && checkedFarm && checkedYear && checkedSource
    }
    var body: some View {
        List {
            if let item, let farm {
                Section("Check the source and farm") {
                    Text(item.value("source_name")).font(.headline)
                    Text(profile["label"]?.text ?? item.value("format_profile"))
                    LabeledContent("Selected farm", value: farm.title)
                    LabeledContent("Farm country", value: farm.value("country"))
                    LabeledContent("Documented source country", value: profile["country"]?.text ?? "Unavailable")
                    LabeledContent("Source year", value: SourceText.year(item.data["source_year"]) ?? "Unavailable")
                    LabeledContent("Documented profile year", value: SourceText.year(profile["source_year"]) ?? "Unavailable")
                    Text("Exact holding reference from the source").font(.caption)
                    SourceCellValue(value: item.data["holding_reference"])
                    Text("This reference is read-only. Leading zeroes and spaces are retained. A missing or mixed holding must be corrected in the source, not invented here.").font(.footnote).foregroundStyle(.secondary)
                    LabeledContent("Current farm revision", value: String(farm.revision))
                }
                Section("Your source review") {
                    Picker("Numeric format used by this source", selection: $decimal) { Text("Choose the source's decimal mark").tag(""); Text("Decimal point (.)").tag("."); Text("Decimal comma (,)").tag(",") }.disabled(working)
                    Toggle("I compared this exact holding with the selected farm", isOn: $checkedFarm)
                    Toggle("I checked the original export's source year", isOn: $checkedYear)
                    Toggle("I checked this source matches the selected profile", isOn: $checkedSource)
                    Button("Save this source-profile review") { save() }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || !canReview)
                    Notice("This review establishes only how to read this source. It does not confirm a fact, infer a date, convert units or establish eligibility.")
                    if reviewed { Notice("The saved source review matches the current profile definition and farm revision."); NavigationLink("Preview and review source rows") { ImportPreviewView(importID: importID) } }
                    else { Notice("Source-row promotion is unavailable until the profile, source year, holding and current farm revision have been reviewed.", warning: true) }
                }.disabled(working)
                Section("Documented columns") { ForEach(Array((profile["row_columns"]?.array ?? []).enumerated()), id: \.offset) { _, column in VStack(alignment: .leading, spacing: 4) { Text(column.object["label"]?.text ?? column.object["key"]?.text ?? "Source column").font(.headline); Text(column.object["key"]?.text ?? "").font(.caption.monospaced()); if let unit = column.object["unit"], unit != .null { Text("Source unit: \(unit.text)").font(.caption) } } } }
                Section("Source references") { if let notice = profile["notice"] { Notice(notice.text) }; if let sources = profile["sources"] { SourceReferences(value: sources) }; DisclosureGroup("Definition identity") { Text(profile["definition_hash"]?.text ?? "Unavailable").font(.caption.monospaced()).textSelection(.enabled) } }
            }
            Button("Reload current source and farm") { Task { await load() } }.disabled(working)
            if working { Section { ProgressView("Loading current source review…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Review source profile").task { await load() }
            .onChange(of: decimal) { _ in checkedSource = false }
    }
    private func load() async {
        working = true; ready = false; checkedFarm = false; checkedYear = false; checkedSource = false
        defer { working = false }
        do {
            let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue("/imports/\(importID)?limit=1&offset=0")))
            guard record.workspace_id == store.account?.workspace.id, let farmID = record.data["farm_id"]?.text, let profileID = record.data["format_profile"]?.text else { throw ServiceError(status: 0, message: "This import has no accessible farm or prepared profile.") }
            let catalogue = try await store.scopedValue("/imports/profiles").object["items"]?.array.map(\.object) ?? []
            guard let definition = catalogue.first(where: { $0["id"]?.text == profileID }) else { throw ServiceError(status: 0, message: "The selected source definition is unavailable. No replacement meanings were inferred.") }
            let currentFarm = try await store.refreshDetail("farms", farmID)
            item = record; profile = definition; farm = currentFarm; decimal = ""; actionKey = UUID().uuidString
            if let saved = try store.loadForm(formKey), saved["context"] == .object(context) { decimal = saved["decimal_separator"]?.text ?? ""; actionKey = saved["action_key"]?.text ?? actionKey }
            ready = true
        } catch { item = nil; farm = nil; profile = [:]; decimal = ""; problem = SourceText.error(error) }
    }
    private func save() {
        guard canReview, let item, let farm, let holding = item.data["holding_reference"] else { return }
        let body: [String: JSONValue] = ["expected_revision": .number(Double(item.revision)), "expected_farm_revision": .number(Double(farm.revision)), "holding_reference": holding, "decimal_separator": .string(decimal), "confirm_source": .bool(true)]
        do {
            if let saved = try store.loadForm(formKey), saved["context"] == .object(context), saved["decimal_separator"] == .string(decimal), let key = saved["action_key"]?.text { actionKey = key } else { actionKey = UUID().uuidString }
            try store.saveForm(formKey, value: ["context": .object(context), "decimal_separator": .string(decimal), "action_key": .string(actionKey)])
        } catch { problem = error.localizedDescription; return }
        working = true; problem = nil
        Task { do { _ = try await store.scopedValue("/imports/\(importID)/profile-review", method: "POST", body: body, idempotency: actionKey); try? store.clearForm(formKey); await load() } catch { problem = SourceText.error(error); await load() }; working = false }
    }
}

struct PromotedImportRecordLink: View {
    let importID: String
    let row: [String: JSONValue]
    var body: some View {
        if let promoted = row["promoted_record"]?.object, let id = promoted["id"]?.text, UUID(uuidString: id) != nil, let kind = promoted["kind"]?.text, ["facts", "operations", "purchases", "sales"].contains(kind) {
            Notice("This source row already links to a record. Do not promote it again; open it to inspect its current review state.")
            if kind == "facts" { NavigationLink("Compare and review the existing source fact") { ImportedFactReviewView(factID: id, importID: importID) } }
            else { NavigationLink("Review the existing proposed record") { DetailView(collection: kind, id: id) } }
        }
    }
}
