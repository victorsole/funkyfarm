import SwiftUI

private enum PortugueseJournalData {
    static let pack = "pt-ppp-surface-journal"
    static let schema = "pt-ppp-surface-v1"
    static let key = "pt.ppp.surface_journal"
    static let keys: Set<String> = ["application_date_time_text", "location_text", "use_crop_oepp_text", "bbch_text", "target_text", "treated_area_text", "applicator_number_text", "product_name_text", "product_authorisation_text", "seller_establishment_text", "seller_activity_authorisation_text", "quantity_or_dose_text", "mixture_volume_text"]
    struct Column: Identifiable, Hashable {
        let id: String
        let label: String
        let letter: String
        let hint: String
    }
    struct Definition: Equatable {
        let raw: [String: JSONValue]
        let columns: [Column]
        init(_ raw: [String: JSONValue]) throws {
            let rows = raw["columns"]?.array.map(\.object) ?? []
            guard raw["schema_id"] == .string(PortugueseJournalData.schema), raw["fact_key"] == .string(PortugueseJournalData.key), rows.count == 13,
                  Set(rows.compactMap { $0["key"]?.text }) == PortugueseJournalData.keys,
                  rows.map({ $0["column"]?.text ?? "" }) == Array("ABCDEFGHIJKLM").map({ String($0) }),
                  rows.allSatisfy({ if case .string(let label)? = $0["label"] { return !label.isEmpty }; return false }),
                  raw["limits"]?.object["max_entries"] == .number(256), raw["limits"]?.object["cell_max_chars"] == .number(2000), raw["limits"]?.object["block_size"] == .number(16),
                  raw["identity"]?.object["key"] == .string("identity_text"), raw["identity"]?.object["max_chars"] == .number(1000),
                  raw["observations"]?.object["key"] == .string("observations_text"), raw["observations"]?.object["max_chars"] == .number(8000),
                  ["title", "edition", "sha256"].allSatisfy({ PortugueseJournalData.nonempty(raw["source"]?.object[$0]) }) else {
                throw ServiceError(status: 0, message: "The complete Portuguese journal template is unavailable or has changed. No columns or limits have been guessed.")
            }
            self.raw = raw
            columns = rows.map { Column(id: $0["key"]!.text, label: $0["label"]!.text, letter: $0["column"]!.text, hint: $0["hint"]?.text ?? "Preserve the text exactly as recorded.") }
        }
        var identityLabel: String { raw["identity"]?.object["label"]?.text ?? "Producer / company / authorised entity" }
        var observationsLabel: String { raw["observations"]?.object["label"]?.text ?? "Global observations" }
    }
    static func decode(_ value: JSONValue) throws -> RecordItem { try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value)) }
    static func text(_ value: JSONValue?) -> String { if case .string(let text)? = value { return text }; return "" }
    static func nonempty(_ value: JSONValue?) -> Bool { !text(value).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    static func active(_ fact: RecordItem) -> Bool { fact.state == "confirmed" && (fact.data["superseded_by"] == nil || fact.data["superseded_by"] == .null) }
    static func validDate(_ text: String) -> Date? {
        guard text.utf8.count == 10, text.utf8.enumerated().allSatisfy({ [4, 7].contains($0.offset) ? $0.element == 45 : (48...57).contains($0.element) }) else { return nil }
        let f = DateFormatter(); f.calendar = Calendar(identifier: .gregorian); f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(secondsFromGMT: 0); f.dateFormat = "yyyy-MM-dd"; f.isLenient = false
        guard let date = f.date(from: text), f.string(from: date) == text else { return nil }; return date
    }
    static func exclusion(_ row: JSONValue, year: Int?) -> String? {
        let entry = row.object, date = text(entry["actual_date"])
        guard entry["date_confirmed"] == .bool(true), let actual = validDate(date) else { return "No separately confirmed actual date — retained as a draft, not inferred from column A." }
        guard actual <= Date() else { return "The supplied actual date is in the future." }
        guard let year else { return "Choose the app's selection year explicitly." }
        guard Int(date.prefix(4)) == year else { return "Actual date is outside the selected year; original column A is unchanged." }
        return nil
    }
    static func validateValue(_ value: [String: JSONValue], allowPlaceholders: Bool = false) throws {
        guard Set(value.keys) == Set(["schema_id", "identity_text", "observations_text", "entries"]), value["schema_id"] == .string(schema),
              literal(value["identity_text"], limit: 1000), literal(value["observations_text"], limit: 8000), case .array(let entries)? = value["entries"], entries.count <= 256 else { throw ServiceError(status: 0, message: "This journal needs its complete literal identity, observations and no more than 256 rows.") }
        var ids = Set<String>()
        for row in entries {
            let entry = row.object, cells = entry["cells"]?.object ?? [:], id = text(entry["entry_id"])
            guard Set(entry.keys) == Set(["entry_id", "cells", "actual_date", "date_confirmed"]), UUID(uuidString: id) != nil, ids.insert(id).inserted,
                  Set(cells.keys) == keys, cells.values.allSatisfy({ literal($0, limit: 2000) }),
                  entry["date_confirmed"] == .bool(false) || entry["date_confirmed"] == .bool(true),
                  entry["actual_date"] == .null || validDate(text(entry["actual_date"])) != nil,
                  entry["date_confirmed"] != .bool(true) || validDate(text(entry["actual_date"])) != nil else { throw ServiceError(status: 0, message: "A journal row has unsupported cells, duplicate identity, oversized text or an invalid separately supplied date. Original text has not been repaired or converted.") }
            guard allowPlaceholders || cells.values.contains(where: { nonempty($0) }) else { throw ServiceError(status: 0, message: "Remove completely blank placeholder rows before saving to the service. Empty cells within a nonempty row stay exactly as supplied.") }
        }
        guard try JSONEncoder().encode(JSONValue.object(value)).count <= 512_000 else { throw ServiceError(status: 0, message: "This literal journal is too large for the fact's 512,000-byte budget. Keep this device draft and split it explicitly; nothing was truncated.") }
    }
    static func literal(_ value: JSONValue?, limit: Int) -> Bool {
        if value == .null { return true }; if case .string(let text)? = value { return text.unicodeScalars.count <= limit }; return false
    }
    static func fact(_ value: JSONValue, farmID: String, workspace: String?) throws -> RecordItem {
        let item = try decode(value)
        guard item.kind == "facts", item.workspace_id == workspace, item.value("farm_id") == farmID, item.data["key"] == .string(key), item.data["temporal_basis"] == .string("static"), item.data["period"] == .null, item.data["unit"] == .null, ["proposed", "confirmed", "rejected"].contains(item.state) else { throw ServiceError(status: 0, message: "The journal does not match this private farm and static source record.") }
        try validateValue(item.data["value"]?.object ?? [:]); return item
    }
    @MainActor static func context(store: AppStore, farmID: String, writing: Bool) async throws -> RecordItem {
        guard let account = store.account, store.sessionVerified, UUID(uuidString: farmID) != nil else { throw CancellationError() }
        let membership = try await store.scopedValue("/workspaces")
        guard let grant = membership.object["items"]?.array.map(\.object).first(where: { $0["id"] == .string(account.workspace.id) }),
              grant["farm_ids"] == .null || (grant["farm_ids"]?.array ?? []).contains(.string(farmID)),
              !writing || grant["role"] == .string("owner") || (grant["permissions"]?.array ?? []).contains(.string("review")) else { throw ServiceError(status: 403, message: "The current workspace permission does not allow this journal action for the selected farm.") }
        let farm = try await store.refreshDetail("farms", farmID)
        guard store.account?.scope == account.scope, store.sessionVerified, farm.value("country") == "PT", farm.workspace_id == account.workspace.id else { throw ServiceError(status: 403, message: "Select an authorised Portuguese farm. No other country's journal rules are substituted.") }; return farm
    }
    @MainActor static func checkSources(_ sources: [JSONValue], store: AppStore, farmID: String) async throws {
        for source in sources where source.object["document_id"] != nil {
            let pin = source.object
            guard let id = pin["document_id"]?.text, UUID(uuidString: id) != nil, case .number(let revision)? = pin["document_revision"], revision >= 1 else { throw ServiceError(status: 0, message: "A selected source document lacks its exact revision. Reselect it explicitly.") }
            let current = try await store.refreshDetail("documents", id)
            guard current.value("farm_id") == farmID, Double(current.revision) == revision else { throw ServiceError(status: 409, message: "A selected source document changed or moved farms. Compare and explicitly reselect it; no unseen revision is attested automatically.") }
        }
    }
    @MainActor static func page(_ kind: String, farmID: String, offset: Int, store: AppStore, journalOnly: Bool = true) async throws -> RecordPage {
        let filter = kind == "facts" && journalOnly ? "&fact_key=" + key : ""
        let value = try await store.scopedValue("/\(kind)?farm_id=\(farmID)&limit=5&offset=\(offset)" + filter)
        let page = try JSONDecoder().decode(RecordPage.self, from: JSONEncoder().encode(value))
        guard value.object["limit"] == .number(5), value.object["offset"] == .number(Double(offset)), page.items.count <= 5, page.total >= offset + page.items.count, !page.items.isEmpty || offset == page.total,
              page.items.allSatisfy({ $0.kind == kind && $0.workspace_id == store.account?.workspace.id && $0.value("farm_id") == farmID && (kind != "facts" || !journalOnly || $0.data["key"] == .string(key)) }) else { throw ServiceError(status: 0, message: "The complete source page was not established. Unloaded records are not assumed absent.") }; return page
    }
    @MainActor static func reportBaseline(_ source: RecordItem, farmID: String, store: AppStore) async throws -> RecordItem {
        let fresh = try decode(await store.scopedValue("/reports/" + source.id))
        guard fresh.id == source.id, fresh.kind == "reports", fresh.workspace_id == store.account?.workspace.id,
              fresh.value("farm_id") == farmID, fresh.value("pack_id") == pack, fresh.revision == source.revision,
              fresh.data["checksum"] == source.data["checksum"], fresh.data["request_id"] == source.data["request_id"],
              fresh.data["reporting_year"] == source.data["reporting_year"], ["draft", "issued"].contains(fresh.state) else { throw ServiceError(status: 409, message: "The original Portuguese report revision, checksum or linked-letter scope changed. Reload that report before preparing a new explicit selection.") }
        if case .string(let requestID)? = fresh.data["request_id"] { _ = try await requestRecord(requestID, farmID: farmID, year: fresh.data["reporting_year"], store: store) }
        return ReportTransport.compact(fresh)
    }
    @MainActor static func requestRecord(_ id: String, farmID: String, year: JSONValue?, store: AppStore) async throws -> RecordItem {
        guard UUID(uuidString: id) != nil else { throw ServiceError(status: 0, message: "The existing letter link is invalid. It is not replaced with an unlinked manual report.") }
        let fresh = try decode(await store.scopedValue("/requests/" + id))
        guard fresh.id == id, fresh.kind == "requests", fresh.workspace_id == store.account?.workspace.id, fresh.value("farm_id") == farmID, fresh.data["pack_id"] == .string(pack), fresh.data["country"] == .string("PT"), fresh.data["reporting_year"] == year else { throw ServiceError(status: 409, message: "The actual linked letter does not match this farm, Portuguese template and selected year. Reload it; no letter is fabricated or silently dropped.") }; return fresh
    }
    @MainActor static func requestBaseline(_ source: RecordItem, farmID: String, store: AppStore) async throws -> RecordItem {
        let fresh = try await requestRecord(source.id, farmID: farmID, year: source.data["reporting_year"], store: store)
        guard fresh.revision == source.revision else { throw ServiceError(status: 409, message: "The linked letter revision changed. Open the current letter before starting another journal selection.") }; return fresh
    }
}

struct PortugueseJournalView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    var reissue: RecordItem? = nil
    var request: RecordItem? = nil
    @State private var farmID = ""
    @State private var definition: PortugueseJournalData.Definition?
    @State private var page: RecordPage?
    @State private var offset = 0
    @State private var busy = false
    @State private var problem: String?
    @State private var scope: String?
    @State private var generation = UUID()
    @State private var cachedTemplate = false
    @State private var reportBaseline: RecordItem?
    @State private var requestBaseline: RecordItem?
    var body: some View {
        List {
            Section("Portuguese surface-treatment journal") {
                Picker("Portuguese farm", selection: $farmID) {
                    Text("Choose a farm").tag("")
                    ForEach(store.records("farms").filter { $0.value("country") == "PT" }) { Text($0.title).tag($0.id) }
                    if !farmID.isEmpty, store.record("farms", farmID) == nil { Text("Farm from this link — access must be checked").tag(farmID) }
                }.disabled(reissue != nil || request != nil)
                if reissue != nil { Notice("Choose the current confirmed source journal below, then explicitly choose its dated rows and output order. No previous row selection is assumed. The original report and any existing letter link remain in history.") }
                if request != nil { Notice("Choose a confirmed journal for this actual letter's farm and year, then explicitly select its dated rows. The letter remains linked; no row is selected or confirmed automatically.") }
                Notice("Prepare the DGAV model's literal surface-treatment rows. This does not determine legal completeness, validate a product use, submit anything or establish acceptance.")
                if let definition {
                    NavigationLink("Start or reopen my unfinished journal") { PortugueseJournalEditor(farmID: farmID, definition: definition, reportToReissue: reissue, linkedLetter: request) }
                    PortugueseJournalSource(definition: definition)
                    if cachedTemplate { Notice("This is the last template retained privately for this farm. You may keep an unfinished device draft; reconnect to check the current template and permissions before proposing or confirming anything.", warning: true) }
                }
                Button("Reload this farm and journal template") { Task { await load() } }.disabled(busy || farmID.isEmpty || !store.sessionVerified)
            }
            Section("Saved journals — five at a time") {
                if let page, let definition {
                    let journals = page.items.filter { $0.data["key"] == .string(PortugueseJournalData.key) }
                    if journals.isEmpty { Text("No Portuguese journals occur in this loaded range.") }
                    ForEach(journals) { fact in NavigationLink { PortugueseJournalDetail(farmID: farmID, factID: fact.id, definition: definition, reissue: reportBaseline, request: requestBaseline) } label: { RecordRow(item: fact) }.disabled((reissue != nil && reportBaseline == nil) || (request != nil && requestBaseline == nil)) }
                    Text("Journals \(page.total == 0 ? 0 : offset + 1)–\(offset + page.items.count) of \(page.total). Only this farm's Portuguese surface journals are counted.").font(.footnote)
                    HStack { Button("Previous five journals") { offset = max(0, offset - 5); Task { await load() } }.disabled(offset == 0 || busy); Spacer(); Button("Next five journals") { offset += 5; Task { await load() } }.disabled(offset + page.items.count >= page.total || busy) }
                } else { Text("Saved journals have not loaded for this range; none are assumed absent.") }
            }
            if busy { ProgressView("Loading this private farm and source template…") }
            if let problem { Notice(problem, warning: true) }
        }.navigationTitle("Portuguese journal")
            .onAppear { if farmID.isEmpty { farmID = reissue?.value("farm_id") ?? request?.value("farm_id") ?? initialFarmID ?? "" } }
            .task(id: farmID) { offset = 0; await load() }
            .onChange(of: store.account?.scope) { _ in generation = UUID(); definition = nil; page = nil; reportBaseline = nil; requestBaseline = nil; problem = nil }
            .onChange(of: store.sessionVerified) { verified in if !verified { generation = UUID(); page = nil; reportBaseline = nil; requestBaseline = nil; busy = false } }
            .onDisappear { generation = UUID(); busy = false }
    }
    private func load() async {
        let stamp = UUID(); generation = stamp; scope = store.account?.scope; let boundScope = scope, selectedFarm = farmID, requested = offset
        definition = nil; cachedTemplate = false; page = nil; reportBaseline = nil; requestBaseline = nil; problem = nil; busy = true
        defer { if generation == stamp { busy = false } }
        guard UUID(uuidString: selectedFarm) != nil else { if !selectedFarm.isEmpty { problem = "The farm link is invalid. Choose an authorised Portuguese farm." }; return }
        do {
            if let cached = try store.loadForm("pt-journal:template:" + selectedFarm), cached["farm_id"] == .string(selectedFarm), let cachedDefinition = try? PortugueseJournalData.Definition(cached["template"]?.object ?? [:]) {
                definition = cachedDefinition; cachedTemplate = true
            }
            _ = try await PortugueseJournalData.context(store: store, farmID: selectedFarm, writing: false)
            let pack = try await store.scopedValue("/packs/" + PortugueseJournalData.pack)
            guard pack.object["id"] == .string(PortugueseJournalData.pack), pack.object["country"] == .string("PT"), pack.object["journal_schema"] == .string(PortugueseJournalData.schema) else { throw ServiceError(status: 0, message: "The Portuguese manual journal pack is unavailable.") }
            let loadedDefinition = try PortugueseJournalData.Definition(pack.object["manual_schema"]?.object ?? [:])
            let loadedReport: RecordItem?
            if let reissue { loadedReport = try await PortugueseJournalData.reportBaseline(reissue, farmID: selectedFarm, store: store) } else { loadedReport = nil }
            let loadedRequest: RecordItem?
            if let request { loadedRequest = try await PortugueseJournalData.requestBaseline(request, farmID: selectedFarm, store: store) } else { loadedRequest = nil }
            let loadedPage = try await PortugueseJournalData.page("facts", farmID: selectedFarm, offset: requested, store: store)
            guard generation == stamp, boundScope == store.account?.scope, farmID == selectedFarm, store.sessionVerified, !Task.isCancelled else { return }
            definition = loadedDefinition; cachedTemplate = false; page = loadedPage; reportBaseline = loadedReport; requestBaseline = loadedRequest
            try store.saveForm("pt-journal:template:" + selectedFarm, value: ["farm_id": .string(selectedFarm), "template": .object(loadedDefinition.raw)])
        } catch { if generation == stamp, boundScope == store.account?.scope { problem = SourceText.error(error) } }
    }
}

struct PortugueseJournalRecordView: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    let factID: String
    @State private var definition: PortugueseJournalData.Definition?
    @State private var problem: String?
    @State private var generation = UUID()
    var body: some View {
        Group {
            if let definition { PortugueseJournalDetail(farmID: farmID, factID: factID, definition: definition) }
            else { List { Notice(problem ?? "Loading the literal Portuguese journal template…", warning: problem != nil); Button("Reload this exact journal template") { Task { await load() } }.disabled(!store.sessionVerified) }.navigationTitle("Portuguese journal") }
        }.task { await load() }
            .onChange(of: store.account?.scope) { _ in generation = UUID(); definition = nil; problem = nil }
            .onChange(of: store.sessionVerified) { verified in if !verified { generation = UUID(); definition = nil } }
            .onDisappear { generation = UUID() }
    }
    private func load() async {
        let stamp = UUID(); generation = stamp; let scope = store.account?.scope; definition = nil; problem = nil
        do {
            _ = try await PortugueseJournalData.context(store: store, farmID: farmID, writing: false)
            let pack = try await store.scopedValue("/packs/" + PortugueseJournalData.pack)
            let current = try PortugueseJournalData.Definition(pack.object["manual_schema"]?.object ?? [:])
            guard generation == stamp, scope == store.account?.scope, store.sessionVerified, !Task.isCancelled else { return }; definition = current
        } catch { if generation == stamp, scope == store.account?.scope { problem = SourceText.error(error) } }
    }
}

private struct PortugueseJournalSource: View {
    let definition: PortugueseJournalData.Definition
    var body: some View {
        DisclosureGroup("Template source and preparation limits") {
            SourceRowCells(value: definition.raw["source"]?.object ?? [:])
            Notice(definition.raw["notice"]?.text ?? "Manual preparation only. Check missing details and recipient requirements. Not an authority submission or a legal compliance decision.")
            Text("Rows stay in your order. Sixteen rows form a display/export block, not a legal row limit. No quantities, doses, areas or volumes are totalled, converted or inferred.").font(.footnote)
        }
    }
}

private struct PortugueseLiteralInput: View {
    let label: String
    @Binding var value: JSONValue
    let maximum: Int
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker(label + " — recorded value", selection: Binding(get: { value == .null }, set: { value = $0 ? .null : .string("") })) { Text("Unknown / not supplied (null)").tag(true); Text("Literal text, including an empty string").tag(false) }
            if value != .null { TextField(label, text: Binding(get: { PortugueseJournalData.text(value) }, set: { value = .string($0) }), axis: .vertical) }
            if !PortugueseJournalData.literal(value, limit: maximum) { Notice("Keep this literal value within \(maximum) characters. Text has not been cut off.", warning: true) }
        }
    }
}

private struct PortugueseEntryEditor: View {
    @Binding var entry: JSONValue
    let definition: PortugueseJournalData.Definition
    private func cell(_ key: String) -> Binding<JSONValue> {
        Binding(get: { entry.object["cells"]?.object[key] ?? .null }, set: { value in var row = entry.object, cells = row["cells"]?.object ?? [:]; cells[key] = value; row["cells"] = .object(cells); entry = .object(row) })
    }
    var body: some View {
        ForEach(definition.columns) { column in
            PortugueseLiteralInput(label: column.letter + " · " + column.label, value: cell(column.id), maximum: 2000)
            Text(column.hint).font(.footnote).foregroundStyle(.secondary)
        }
        TextField("Separate actual date, if established (YYYY-MM-DD)", text: Binding(get: { PortugueseJournalData.text(entry.object["actual_date"]) }, set: { text in var row = entry.object; row["actual_date"] = text.isEmpty ? .null : .string(text); row["date_confirmed"] = .bool(false); entry = .object(row) }))
        Toggle("I separately checked this actual date — not inferred from column A", isOn: Binding(get: { entry.object["date_confirmed"] == .bool(true) }, set: { confirmed in var row = entry.object; row["date_confirmed"] = .bool(confirmed); entry = .object(row) })).disabled(PortugueseJournalData.validDate(PortugueseJournalData.text(entry.object["actual_date"])) == nil)
        Text("Leave the actual date unknown for an undated draft. This separate date never rewrites A, supplies a timezone or creates a work operation.").font(.footnote)
    }
}

private struct PortugueseEntryReadback: View {
    let entry: JSONValue
    let definition: PortugueseJournalData.Definition
    var body: some View {
        ForEach(definition.columns) { column in
            VStack(alignment: .leading) { Text(column.letter + " · " + column.label).font(.caption.bold()); SourceCellValue(value: entry.object["cells"]?.object[column.id]) }
        }
        LabeledContent("Separately supplied actual date", value: PortugueseJournalData.text(entry.object["actual_date"]).isEmpty ? "Unknown — not inferred" : PortugueseJournalData.text(entry.object["actual_date"]))
        LabeledContent("Actual date explicitly checked", value: entry.object["date_confirmed"] == .bool(true) ? "Yes" : "No")
    }
}

private struct PortugueseJournalEditor: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    let definition: PortugueseJournalData.Definition
    var existing: RecordItem? = nil
    var reportToReissue: RecordItem? = nil
    var linkedLetter: RecordItem? = nil
    @State private var value: [String: JSONValue] = [:]
    @State private var sources: [JSONValue] = []
    @State private var baseline: RecordItem?
    @State private var boundRevision: Int?
    @State private var boundState: String?
    @State private var farmRevision: Int?
    @State private var note = ""
    @State private var pageOffset = 0
    @State private var documents: RecordPage?
    @State private var documentOffset = 0
    @State private var check: CaptureCheck?
    @State private var acknowledged: Set<String> = []
    @State private var intent: [String: JSONValue]?
    @State private var intentKey = UUID().uuidString
    @State private var rejected = false
    @State private var saved: RecordItem?
    @State private var scope: String?
    @State private var loaded = false
    @State private var busy = false
    @State private var problem: String?
    @State private var generation = UUID()
    @State private var operation: Task<Void, Never>?
    @State private var reset = false
    private var formKey: String { "pt-journal:editor:" + (existing?.id ?? farmID) }
    private var rows: [JSONValue] { value["entries"]?.array ?? [] }
    private var correction: Bool { boundState == "confirmed" }
    private var request: [String: JSONValue] {
        var data: [String: JSONValue] = ["farm_id": .string(farmID), "key": .string(PortugueseJournalData.key), "label": .string("Portuguese surface-treatment journal"), "value": .object(value), "unit": .null, "period": .null, "temporal_basis": .string("static"), "review_status": .string("proposed"), "sources": .array(sources)]
        if correction, let existing { data["supersedes_id"] = .string(existing.id) }
        else if let predecessor = baseline?.data["supersedes_id"] { data["supersedes_id"] = predecessor }
        var body: [String: JSONValue] = ["kind": .string("facts"), "data": .object(data)]
        if let existing, !correction { body["record_id"] = .string(existing.id); body["expected_revision"] = boundRevision.map { .number(Double($0)) } }
        return body
    }
    private var draft: [String: JSONValue] { ["value": .object(value), "sources": .array(sources), "bound_revision": boundRevision.map { .number(Double($0)) } ?? .null, "bound_state": boundState.map(JSONValue.string) ?? .null, "farm_revision": farmRevision.map { .number(Double($0)) } ?? .null, "note": .string(note), "template": .object(definition.raw), "intent": intent.map(JSONValue.object) ?? .null, "intent_key": .string(intentKey), "rejected": .bool(rejected)] }
    var body: some View {
        Form {
            Section("Literal document details") {
                Notice(correction ? "Propose a separate correction. The confirmed original remains in history until a separate review confirms its successor." : "Keep unfinished rows without inventing a date. Saving proposes this journal; it never confirms it or creates a work operation.")
                PortugueseLiteralInput(label: definition.identityLabel, value: literal("identity_text"), maximum: 1000)
                PortugueseLiteralInput(label: definition.observationsLabel + " — whole document", value: literal("observations_text"), maximum: 8000)
                PortugueseJournalSource(definition: definition)
            }.disabled(busy || intent != nil || saved != nil)
            Section("Ordered rows — block \(pageOffset / 16 + 1)") {
                Text("\(rows.count) rows retained, up to 256. Only this 16-row block is expanded. Null, empty text, whitespace, zero, leading zeros and Unicode stay distinct.").font(.footnote)
                ForEach(Array(rows.enumerated()).filter { (pageOffset..<(pageOffset + 16)).contains($0.offset) }, id: \.offset) { index, row in
                    DisclosureGroup("Row \(index + 1) · " + (PortugueseJournalData.text(row.object["cells"]?.object["product_name_text"]).isEmpty ? "Product not supplied" : String(PortugueseJournalData.text(row.object["cells"]?.object["product_name_text"]).prefix(80)))) {
                        PortugueseEntryEditor(entry: rowBinding(index), definition: definition)
                        HStack {
                            Button("Move row up") { move(index, by: -1) }.disabled(index == 0)
                            Button("Move row down") { move(index, by: 1) }.disabled(index + 1 >= rows.count)
                        }
                        Button("Remove this row from my draft", role: .destructive) { removeRow(index) }
                    }
                }
                HStack { Button("Previous block") { pageOffset = max(0, pageOffset - 16) }.disabled(pageOffset == 0); Spacer(); Button("Next block") { pageOffset += 16 }.disabled(pageOffset + 16 >= rows.count) }
                Button("Add another literal row") { addRow() }.disabled(rows.count >= 256)
                Text("A completely blank placeholder row must be removed before service save. No row is silently dropped, deduplicated or sorted.").font(.footnote)
            }.disabled(busy || intent != nil || saved != nil)
            sourceSection
            Section("Keep or propose this journal") {
                TextField("Private note for my later review", text: $note, axis: .vertical).disabled(intent != nil || saved != nil)
                Button("Keep unfinished journal privately on this device") { do { try persist(); problem = "Unfinished literal journal saved privately on this device. Nothing was confirmed or sent." } catch { problem = SourceText.error(error) } }.disabled(busy || saved != nil)
                Button("Check this exact journal proposal") { runCheck() }.disabled(busy || intent != nil || saved != nil || !store.sessionVerified)
                if let check {
                    ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                    ForEach(check.requires_acknowledgement, id: \.self) { code in Toggle(check.issues.first(where: { $0.code == code })?.message ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                }
                Button(intent == nil ? "Save checked proposal — confirm separately" : "Retry the exact retained proposal request") { save() }.buttonStyle(.borderedProminent).disabled(busy || !store.sessionVerified || saved != nil || (intent == nil && (check?.can_save != true || !Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged))))
                if intent != nil { Notice("This exact request and retry key are retained privately. A lost response may already have saved the proposal. No changed body or new correction is sent to compensate.", warning: true) }
                if let saved { NavigationLink("Open saved journal and confirm it separately") { PortugueseJournalDetail(farmID: farmID, factID: saved.id, definition: definition, reissue: reportToReissue, request: linkedLetter) } }
                if rejected { Button("Compare current source and discard this rejected device intent") { reset = true }.disabled(busy) }
                if busy { ProgressView("Checking or saving this private journal…"); Button("Cancel request — retain exact intent") { cancel() } }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle(correction ? "Journal correction proposal" : "Write Portuguese journal").autocorrectionDisabled().textInputAutocapitalization(.never)
            .task { restore() }
            .onChange(of: draft) { _ in guard loaded, saved == nil, scope == store.account?.scope else { return }; do { try persist() } catch { problem = SourceText.error(error) } }
            .onChange(of: request) { _ in check = nil; acknowledged = [] }
            .onChange(of: store.account?.scope) { _ in cancel(); value = [:]; sources = []; saved = nil; documents = nil; scope = nil }
            .onChange(of: store.sessionVerified) { verified in if !verified { cancel(); check = nil; acknowledged = []; documents = nil } }
            .onDisappear { cancel() }
            .confirmationDialog("Discard this device draft and load the current source? Your typed values will be removed only after the current source loads. Saved service records are not deleted.", isPresented: $reset, titleVisibility: .visible) { Button("Load current source and start a new guarded draft", role: .destructive) { resetDraft() } }
    }
    private var sourceSection: some View {
        Section("Optional real source documents") {
            Text("No evidence is invented for typed rows. Select only actual documents assigned to this farm; their exact revisions are pinned. Source files are not automatically selected for outward report sharing.").font(.footnote)
            ForEach(Array(sources.enumerated()), id: \.offset) { index, source in
                if let id = source.object["document_id"]?.text {
                    NavigationLink("Review selected source document · revision " + (source.object["document_revision"]?.text ?? "missing")) { DetailView(collection: "documents", id: id) }
                    Button("Remove this source pin", role: .destructive) { sources.remove(at: index) }.disabled(busy || intent != nil || saved != nil)
                }
            }
            Button("Load five actual farm documents") { loadDocuments(documentOffset) }.disabled(busy || !store.sessionVerified)
            if let documents {
                ForEach(documents.items) { document in
                    VStack(alignment: .leading) {
                        NavigationLink(document.title) { DetailView(collection: "documents", id: document.id) }
                        Button("Pin this current document revision explicitly") { pin(document) }.disabled(busy || intent != nil || saved != nil || sources.contains(where: { $0.object["document_id"] == .string(document.id) }))
                    }
                }
                HStack { Button("Previous documents") { loadDocuments(max(0, documentOffset - 5)) }.disabled(documentOffset == 0 || busy); Spacer(); Button("Next documents") { loadDocuments(documentOffset + 5) }.disabled(documentOffset + documents.items.count >= documents.total || busy) }
                Text("Showing \(documents.items.count) of \(documents.total) farm documents, starting at \(documentOffset). Unloaded files are not assumed absent.").font(.footnote)
            }
        }
    }
    private func literal(_ key: String) -> Binding<JSONValue> { Binding(get: { value[key] ?? .null }, set: { value[key] = $0 }) }
    private func rowBinding(_ index: Int) -> Binding<JSONValue> { Binding(get: { rows.indices.contains(index) ? rows[index] : .null }, set: { row in guard rows.indices.contains(index) else { return }; var entries = rows; entries[index] = row; value["entries"] = .array(entries) }) }
    private func move(_ index: Int, by amount: Int) { var entries = rows; let destination = index + amount; guard entries.indices.contains(index), entries.indices.contains(destination) else { return }; entries.swapAt(index, destination); value["entries"] = .array(entries); pageOffset = destination / 16 * 16 }
    private func removeRow(_ index: Int) { var entries = rows; guard entries.indices.contains(index) else { return }; entries.remove(at: index); value["entries"] = .array(entries); pageOffset = min(pageOffset, max(0, (entries.count - 1) / 16 * 16)) }
    private func addRow() {
        var entries = rows; entries.append(.object(["entry_id": .string(UUID().uuidString.lowercased()), "cells": .object(Dictionary(uniqueKeysWithValues: definition.columns.map { ($0.id, JSONValue.null) })), "actual_date": .null, "date_confirmed": .bool(false)])); value["entries"] = .array(entries); pageOffset = (entries.count - 1) / 16 * 16
    }
    private func restore() {
        guard !loaded else { return }; scope = store.account?.scope
        do {
            let saved = try store.loadForm(formKey)
            baseline = existing; boundRevision = SourceText.year(saved?["bound_revision"]).flatMap(Int.init) ?? existing?.revision; boundState = saved?["bound_state"] == .null ? existing?.state : saved?["bound_state"]?.text ?? existing?.state
            farmRevision = SourceText.year(saved?["farm_revision"]).flatMap(Int.init)
            value = saved?["value"]?.object ?? existing?.data["value"]?.object ?? ["schema_id": .string(PortugueseJournalData.schema), "identity_text": .null, "observations_text": .null, "entries": .array([])]
            sources = saved?["sources"]?.array ?? existing?.data["sources"]?.array ?? []; note = PortugueseJournalData.text(saved?["note"])
            if case .object(let pending)? = saved?["intent"] { intent = pending }; intentKey = saved?["intent_key"]?.text ?? intentKey; rejected = saved?["rejected"] == .bool(true)
            loaded = true
            if let old = saved?["template"]?.object, old != definition.raw { problem = "The source template changed since this private draft. Original values remain; compare the source before a new check." }
        } catch { loaded = true; problem = SourceText.error(error) }
    }
    private func persist() throws { guard loaded, scope != nil, scope == store.account?.scope else { throw CancellationError() }; try store.saveForm(formKey, value: draft) }
    private func cancel() { generation = UUID(); operation?.cancel(); operation = nil; busy = false }
    private func start(_ action: @escaping (UUID) async throws -> Void) {
        guard !busy, scope == store.account?.scope else { return }; let stamp = UUID(); generation = stamp; busy = true; problem = nil
        operation = Task { defer { if generation == stamp { busy = false; operation = nil } }; do { try await action(stamp) } catch { if generation == stamp, scope == store.account?.scope { if intent == nil, (error as? ServiceError)?.status == 409 { rejected = true }; problem = SourceText.error(error) } } }
    }
    private func bound(_ stamp: UUID) -> Bool { stamp == generation && scope == store.account?.scope && store.sessionVerified && !Task.isCancelled }
    private func validateCurrent() async throws {
        let farm = try await PortugueseJournalData.context(store: store, farmID: farmID, writing: true)
        let pack = try await store.scopedValue("/packs/" + PortugueseJournalData.pack)
        guard pack.object["manual_schema"] == .object(definition.raw) else { throw ServiceError(status: 409, message: "The source template changed. Keep the literal draft and reopen the current journal template before checking it; no cached definition authorises a new proposal.") }
        if let farmRevision { guard farmRevision == farm.revision else { throw ServiceError(status: 409, message: "The farm revision changed. Keep this draft; compare the current farm before starting a new source-bound proposal.") } }
        else { farmRevision = farm.revision }
        if let existing {
            let current = try PortugueseJournalData.fact(await store.scopedValue("/facts/" + existing.id), farmID: farmID, workspace: store.account?.workspace.id)
            guard current.revision == boundRevision, current.state == boundState, !correction || PortugueseJournalData.active(current) else { throw ServiceError(status: 409, message: "The journal source changed. Your original revision and typed draft are retained, not automatically rebased.") }
        }
        try await PortugueseJournalData.checkSources(sources, store: store, farmID: farmID)
    }
    private func runCheck() {
        check = nil; acknowledged = []
        start { stamp in
            try PortugueseJournalData.validateValue(value)
            guard sources.count <= 100, try JSONEncoder().encode(request["data"]).count <= 512_000 else { throw ServiceError(status: 0, message: "Keep the complete journal and its source pins within 512,000 bytes and 100 source references. Nothing has been cut off.") }
            let raw = request; try await validateCurrent()
            guard bound(stamp), raw == request else { return }
            let checked = try await store.checkCapture(raw)
            guard bound(stamp), raw == request else { return }; check = checked; try persist()
        }
    }
    private func save() {
        guard intent != nil || (check?.can_save == true && Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged)) else { return }
        do {
            if intent == nil, let check { var body = request; body["check_token"] = .string(check.check_token); body["acknowledged_codes"] = .array(acknowledged.sorted().map(JSONValue.string)); intent = body; intentKey = UUID().uuidString; rejected = false }
            try persist()
        } catch { problem = SourceText.error(error); return }
        guard let body = intent else { return }
        start { stamp in
            do {
                let result = try await store.scopedValue("/workflow/capture", method: "POST", body: body, idempotency: intentKey)
                let record = try PortugueseJournalData.fact(result.object["record"] ?? .null, farmID: farmID, workspace: store.account?.workspace.id)
                guard bound(stamp) else { return }
                guard record.state == "proposed", record.data["value"] == body["data"]?.object["value"], record.data["sources"] == body["data"]?.object["sources"] else { throw ServiceError(status: 0, message: "The saved proposal did not echo the complete literal values and source pins. Reload the source; do not resend a changed replacement.") }
                saved = record; intent = nil; check = nil; acknowledged = []; try store.clearForm(formKey)
            } catch {
                if bound(stamp) { rejected = [400, 403, 404, 409, 413, 422].contains((error as? ServiceError)?.status ?? 0); try persist() }; throw error
            }
        }
    }
    private func loadDocuments(_ requested: Int) { start { stamp in let page = try await PortugueseJournalData.page("documents", farmID: farmID, offset: requested, store: store); guard bound(stamp) else { return }; documents = page; documentOffset = requested } }
    private func pin(_ document: RecordItem) { start { stamp in let fresh = try await store.refreshDetail("documents", document.id); guard bound(stamp), fresh.revision == document.revision, fresh.value("farm_id") == farmID else { throw ServiceError(status: 409, message: "This document changed since it was displayed. Reload and inspect its current revision before pinning it.") }; sources.append(.object(["document_id": .string(fresh.id), "document_revision": .number(Double(fresh.revision))])); try persist() } }
    private func resetDraft() {
        guard rejected else { return }
        start { stamp in
            let farm = try await PortugueseJournalData.context(store: store, farmID: farmID, writing: true)
            var fresh: RecordItem?
            if let existing { fresh = try PortugueseJournalData.fact(await store.scopedValue("/facts/" + existing.id), farmID: farmID, workspace: store.account?.workspace.id) }
            if let fresh { guard fresh.state == "proposed" || PortugueseJournalData.active(fresh) else { throw ServiceError(status: 409, message: "This original is rejected or has a confirmed successor. Open its current journal history instead of editing the retained predecessor.") } }
            guard bound(stamp) else { return }
            baseline = fresh; boundRevision = fresh?.revision; boundState = fresh?.state; farmRevision = farm.revision
            value = fresh?.data["value"]?.object ?? ["schema_id": .string(PortugueseJournalData.schema), "identity_text": .null, "observations_text": .null, "entries": .array([])]
            sources = fresh?.data["sources"]?.array ?? []; intent = nil; intentKey = UUID().uuidString; rejected = false; check = nil; acknowledged = []; note = ""; pageOffset = 0; try persist()
        }
    }
}

private struct PortugueseJournalDetail: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    let factID: String
    let definition: PortugueseJournalData.Definition
    var reissue: RecordItem? = nil
    var request: RecordItem? = nil
    @State private var fact: RecordItem?
    @State private var pageOffset = 0
    @State private var visited: Set<Int> = []
    @State private var checked = false
    @State private var note = ""
    @State private var yearText = ""
    @State private var selected: [String] = []
    @State private var acknowledged = false
    @State private var outward: Set<String> = []
    // Keep selected revisions and labels, never whole extra fact values, in this private form.
    @State private var extraFacts: [String: JSONValue] = [:]
    @State private var documentPins: [String: JSONValue] = [:]
    @State private var factPage: RecordPage?
    @State private var factOffset = 0
    @State private var documentPage: RecordPage?
    @State private var documentOffset = 0
    @State private var report: RecordItem?
    @State private var intent: [String: JSONValue]?
    @State private var intentPath: String?
    @State private var intentKey = UUID().uuidString
    @State private var knownRejected = false
    @State private var attempted = false
    @State private var scope: String?
    @State private var generation = UUID()
    @State private var operation: Task<Void, Never>?
    @State private var busy = false
    @State private var problem: String?
    @State private var confirmation = false
    @State private var baselineRevision: Int?
    @State private var baselineFarmRevision: Int?
    @State private var currentFarmRevision: Int?
    @State private var templateBaseline: JSONValue?
    @State private var loaded = false
    @State private var sourcesVerified = false
    private var formKey: String { "pt-journal:review:" + factID + (reissue.map { ":reissue:" + $0.id } ?? request.map { ":request:" + $0.id } ?? "") }
    private var reportPath: String { reissue.map { "/reports/" + $0.id + "/reissue" } ?? "/reports" }
    private var value: [String: JSONValue] { fact?.data["value"]?.object ?? [:] }
    private var entries: [JSONValue] { value["entries"]?.array ?? [] }
    private var year: Int? { guard yearText.count == 4, yearText.utf8.allSatisfy({ (48...57).contains($0) }), let y = Int(yearText), (2000...2200).contains(y) else { return nil }; return y }
    private var reviewedAll: Bool { !entries.isEmpty && (0..<((entries.count + 15) / 16)).allSatisfy { visited.contains($0) } }
    private var unchanged: Bool { fact != nil && fact?.revision == baselineRevision && currentFarmRevision != nil && currentFarmRevision == baselineFarmRevision && templateBaseline == .object(definition.raw) }
    private var selectionValid: Bool { !selected.isEmpty && Set(selected).count == selected.count && selected.allSatisfy { id in entries.first(where: { $0.object["entry_id"] == .string(id) }).map { PortugueseJournalData.exclusion($0, year: year) == nil } ?? false } }
    private var extraBindingsComplete: Bool { extraFacts.count < 5000 && outward.count <= 250 && extraFacts.allSatisfy({ UUID(uuidString: $0.key) != nil && $0.key != factID && (SourceText.year($0.value.object["revision"]).flatMap(Int.init) ?? 0) > 0 }) && outward.allSatisfy({ UUID(uuidString: $0) != nil && (SourceText.year(documentPins[$0]?.object["revision"]).flatMap(Int.init) ?? 0) > 0 }) }
    var body: some View {
        List {
            if let fact {
                Section("Private source journal") {
                    LabeledContent("Review state", value: fact.state); LabeledContent("Source revision", value: String(fact.revision))
                    Text(definition.identityLabel).font(.headline); SourceCellValue(value: value["identity_text"])
                    Text(definition.observationsLabel + " — whole document").font(.headline); SourceCellValue(value: value["observations_text"])
                    PortugueseJournalSource(definition: definition)
                    if fact.state == "proposed" { NavigationLink("Edit this proposal without confirming it") { PortugueseJournalEditor(farmID: farmID, definition: definition, existing: fact, reportToReissue: reissue, linkedLetter: request) } }
                    else if PortugueseJournalData.active(fact) { NavigationLink("Propose a separate correction successor") { PortugueseJournalEditor(farmID: farmID, definition: definition, existing: fact, reportToReissue: reissue, linkedLetter: request) } }
                    if let previous = fact.data["supersedes_id"]?.text { NavigationLink("Compare the retained predecessor") { PortugueseJournalDetail(farmID: farmID, factID: previous, definition: definition, reissue: reissue, request: request) } }
                    if let successor = fact.data["superseded_by"]?.text, UUID(uuidString: successor) != nil { NavigationLink("Open confirmed successor") { PortugueseJournalDetail(farmID: farmID, factID: successor, definition: definition, reissue: reissue, request: request) } }
                    ReportSourceLinks(sources: fact.data["sources"]?.array ?? [])
                }
                rowsSection
                if fact.state == "proposed" { reviewSection }
                if PortugueseJournalData.active(fact) { selectionSection; extraEvidenceSection }
                if !unchanged { Section { Notice("This retained device review uses a different fact revision, farm revision or template definition. Typed notes and selection are not rebased automatically. Compare the current source and template, then explicitly discard the old review choices.", warning: true); Button("Discard old review choices and use this displayed source, farm and template") { resetReview() }.disabled(busy || (intent != nil && !knownRejected)) } }
            } else { Notice("The exact private journal has not loaded. No absent row or source is assumed complete.", warning: true) }
            Section {
                Button("Reload exact current journal and source pins") { load() }.disabled(busy || !store.sessionVerified)
                if let intent { Button("Retry exact saved " + (intentPath == reportPath ? "report preparation" : "fact review")) { send(intent, path: intentPath ?? "") }.disabled(busy || !store.sessionVerified); Notice("The exact pending request and retry key are retained. A lost response may have succeeded; do not substitute a new body.", warning: true) }
                if knownRejected { Button("Clear definitely rejected request — keep my notes and selection") { intent = nil; intentPath = nil; intentKey = UUID().uuidString; knownRejected = false; attempted = false; persistQuietly() }.disabled(busy) }
                if let report { NavigationLink("Review every retained report value before approval") { ReportDetail(item: report) } }
                if busy { ProgressView("Loading or recording this exact journal action…"); Button("Cancel — keep pending intent") { cancel() } }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("Review Portuguese journal").autocorrectionDisabled().textInputAutocapitalization(.never)
            .onAppear { restore(); load() }
            .onChange(of: yearText) { _ in acknowledged = false; persistQuietly() }
            .onChange(of: selected) { _ in acknowledged = false; persistQuietly() }
            .onChange(of: outward) { _ in acknowledged = false; persistQuietly() }
            .onChange(of: extraFacts) { _ in acknowledged = false; persistQuietly() }
            .onChange(of: documentPins) { _ in acknowledged = false; persistQuietly() }
            .onChange(of: note) { _ in persistQuietly() }
            .onChange(of: store.account?.scope) { _ in cancel(); fact = nil; report = nil; scope = nil; visited = []; checked = false; acknowledged = false; sourcesVerified = false; factPage = nil; documentPage = nil }
            .onChange(of: store.sessionVerified) { verified in if !verified { cancel(); fact = nil; visited = []; checked = false; acknowledged = false; sourcesVerified = false; factPage = nil; documentPage = nil } }
            .onDisappear { cancel(); visited = []; checked = false; acknowledged = false; sourcesVerified = false; factPage = nil; documentPage = nil }
            .confirmationDialog("Confirm this exact journal fact revision? This confirms your source record only, not legal completeness or a report.", isPresented: $confirmation, titleVisibility: .visible) { Button("Confirm checked source journal") { reviewFact() } }
    }
    private var rowsSection: some View {
        Section("Literal rows \(entries.isEmpty ? 0 : pageOffset + 1)–\(min(pageOffset + 16, entries.count)) of \(entries.count)") {
            ForEach(Array(entries.enumerated()).filter { (pageOffset..<(pageOffset + 16)).contains($0.offset) }, id: \.offset) { index, entry in
                DisclosureGroup("Read complete literal row \(index + 1)") { PortugueseEntryReadback(entry: entry, definition: definition) }
                if let reason = PortugueseJournalData.exclusion(entry, year: year) { Text(reason).font(.footnote).foregroundStyle(.secondary) }
            }
            if entries.isEmpty { Text("No treatment rows were supplied. This can remain a partial proposal but cannot prepare a report.") }
            HStack { Button("Previous 16 rows") { pageOffset = max(0, pageOffset - 16) }.disabled(pageOffset == 0 || busy); Spacer(); Button("Next 16 rows") { pageOffset += 16 }.disabled(pageOffset + 16 >= entries.count || busy) }
            Button("I reviewed every literal cell in this 16-row block") { visited.insert(pageOffset / 16) }.disabled(busy || entries.isEmpty || !store.sessionVerified || !unchanged)
            Text("\(visited.count) of \((entries.count + 15) / 16) blocks explicitly reviewed. Text is never converted or totalled.").font(.footnote)
        }
    }
    private var reviewSection: some View {
        Section("Confirm the source separately") {
            TextField("What original values and source documents did you check?", text: $note, axis: .vertical)
            Toggle("I checked identity, global observations, all literal row blocks and remaining unknown details", isOn: $checked).disabled(!reviewedAll || !unchanged)
            Button("Confirm this journal source separately") { confirmation = true }.buttonStyle(.borderedProminent).disabled(busy || intent != nil || !store.sessionVerified || !sourcesVerified || !unchanged || !reviewedAll || !checked || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Notice("Undated and partial literal rows remain visible. Source confirmation does not invent dates or establish national completeness. Corrections replace a confirmed predecessor only through this separate human review.")
        }.disabled(intent != nil)
    }
    private var selectionSection: some View {
        Section("Choose exact dated rows for manual preparation") {
            TextField("App selection year (YYYY)", text: $yearText).keyboardType(.numberPad).disabled(reissue != nil || request != nil)
            Text("This year is app selection metadata, not a printed workbook field or an inferred application date. Rows outside it and undated rows remain in the original journal.").font(.footnote)
            ForEach(Array(entries.enumerated()).filter { (pageOffset..<(pageOffset + 16)).contains($0.offset) }, id: \.offset) { index, entry in
                let id = PortugueseJournalData.text(entry.object["entry_id"]), reason = PortugueseJournalData.exclusion(entry, year: year)
                Toggle("Include original row \(index + 1) · " + PortugueseJournalData.text(entry.object["actual_date"]), isOn: Binding(get: { selected.contains(id) }, set: { include in if include { if !selected.contains(id) { selected.append(id) } } else { selected.removeAll { $0 == id } } })).disabled(reason != nil && !selected.contains(id))
                if let reason { Text("Not eligible: " + reason).font(.footnote) }
            }
            DisclosureGroup("Selected output order — \(selected.count) rows") {
                ForEach(Array(selected.enumerated()), id: \.element) { index, id in
                    let original = entries.firstIndex { $0.object["entry_id"] == .string(id) }
                    VStack(alignment: .leading) {
                        Text("Output \(index + 1) · original row \(original.map { String($0 + 1) } ?? "no longer present")")
                        HStack { Button("Earlier") { reorder(index, by: -1) }.disabled(index == 0); Button("Later") { reorder(index, by: 1) }.disabled(index + 1 == selected.count); Button("Exclude", role: .destructive) { selected.removeAll { $0 == id } } }
                    }
                }
            }
            Text("\(max(0, entries.count - selected.count)) original rows are not selected. Their IDs, supplied dates and exclusion reasons are retained by report preparation; values are not erased.").font(.footnote)
            ForEach((fact?.data["sources"]?.array ?? []).filter { $0.object["document_id"] != nil }, id: \.self) { source in
                let id = source.object["document_id"]!.text
                Toggle("Also include this explicitly pinned document in the report · " + (store.record("documents", id)?.title ?? "Source document") + " · revision " + (source.object["document_revision"]?.text ?? "missing"), isOn: Binding(get: { outward.contains(id) }, set: { include in
                    if include { outward.insert(id); documentPins[id] = .object(["revision": source.object["document_revision"] ?? .null, "title": .string(store.record("documents", id)?.title ?? "Source document")]) }
                    else { outward.remove(id); documentPins.removeValue(forKey: id) }
                }))
            }
            Toggle("I checked the producer identity, selected row order, actual dates, unknown cells and manual-only limits", isOn: $acknowledged).disabled(!selectionValid || !reviewedAll || !unchanged)
            Button("Check selected rows in a manual journal preview") { prepare() }.buttonStyle(.borderedProminent).disabled(busy || intent != nil || !store.sessionVerified || !sourcesVerified || !unchanged || !selectionValid || !extraBindingsComplete || !reviewedAll || !acknowledged || !PortugueseJournalData.nonempty(value["identity_text"]))
            Notice(request != nil || (reissue?.data["request_id"] != nil && reissue?.data["request_id"] != .null) ? "The actual letter link is retained. Preparing creates a separate server-checked draft; review every retained mapped value and approve separately. Nothing is filed or sent." : "No letter is linked. Preparing creates a server-checked draft; use Reports to review every retained mapped value and approve separately. Nothing is filed or sent to an authority.")
        }.disabled(intent != nil)
    }
    private var extraEvidenceSection: some View {
        Section("Extra facts and documents for this request or preparation") {
            Text("A letter may ask for information beyond the literal journal. Explicitly choose only the confirmed facts and actual documents you want this report to retain. Nothing else in the farm is included automatically; source pins are not automatic outward attachments.").font(.footnote)
            Text("\(extraFacts.count) extra facts and \(outward.count) outward documents selected.")
            ForEach(extraFacts.keys.sorted(), id: \.self) { id in
                NavigationLink((extraFacts[id]?.object["title"]?.text ?? "Selected fact") + " · selected revision " + (extraFacts[id]?.object["revision"]?.text ?? "missing")) { DetailView(collection: "facts", id: id) }
                Button("Exclude this extra fact", role: .destructive) { extraFacts.removeValue(forKey: id) }
            }
            ForEach(outward.sorted(), id: \.self) { id in
                NavigationLink((documentPins[id]?.object["title"]?.text ?? "Selected document") + " · selected revision " + (documentPins[id]?.object["revision"]?.text ?? "missing — reselect explicitly")) { DetailView(collection: "documents", id: id) }
                Button("Exclude this outward document", role: .destructive) { outward.remove(id); documentPins.removeValue(forKey: id) }
            }
            if !extraBindingsComplete { Notice("A retained extra selection is missing its exact revision or exceeds the report limit. Remove and explicitly reselect it; an unseen current version is never substituted.", warning: true) }
            DisclosureGroup("Choose extra confirmed facts — five farm facts per page") {
                Button("Load this fact range") { loadExtra("facts", offset: factOffset) }.disabled(busy || !store.sessionVerified)
                if let factPage {
                    let eligible = factPage.items.filter(eligibleExtraFact)
                    if eligible.isEmpty { Text("No eligible extra fact occurs in this range. Other pages may contain one. Proposed, rejected, superseded and other Portuguese journal facts are not offered.") }
                    ForEach(eligible) { record in
                        VStack(alignment: .leading) {
                            NavigationLink(record.title + " · revision \(record.revision)") { DetailView(collection: "facts", id: record.id) }
                            Text("\(record.value("temporal_basis")) · \(record.value("period")) · \(record.value("unit"))").font(.caption)
                            Button(extraFacts[record.id] == nil ? "Select this exact confirmed fact" : "Already selected — inspect selected revision above") { selectExtra(record, kind: "facts") }.disabled(extraFacts[record.id] != nil || extraFacts.count >= 4999)
                        }
                    }
                    Text("Complete farm fact range \(factPage.total == 0 ? 0 : factOffset + 1)–\(factOffset + factPage.items.count) of \(factPage.total). Eligibility is checked within this range, not treated as a complete filtered catalogue.").font(.footnote)
                    HStack { Button("Previous facts") { loadExtra("facts", offset: max(0, factOffset - 5)) }.disabled(factOffset == 0 || busy); Spacer(); Button("Next facts") { loadExtra("facts", offset: factOffset + 5) }.disabled(factOffset + factPage.items.count >= factPage.total || busy) }
                } else { Text("This fact range has not loaded successfully. No extra fact is assumed absent or selected.").font(.footnote) }
            }
            DisclosureGroup("Choose actual same-farm documents — five per page") {
                Button("Load this document range") { loadExtra("documents", offset: documentOffset) }.disabled(busy || !store.sessionVerified)
                if let documentPage {
                    if documentPage.items.isEmpty { Text("This loaded farm document range is empty.") }
                    ForEach(documentPage.items) { record in
                        VStack(alignment: .leading) {
                            NavigationLink(record.title + " · revision \(record.revision)") { DetailView(collection: "documents", id: record.id) }
                            Button(outward.contains(record.id) ? "Already selected — inspect selected revision above" : "Include this exact document in the report") { selectExtra(record, kind: "documents") }.disabled(outward.contains(record.id) || outward.count >= 250)
                        }
                    }
                    Text("Complete document range \(documentPage.total == 0 ? 0 : documentOffset + 1)–\(documentOffset + documentPage.items.count) of \(documentPage.total). Files not loaded are not assumed absent.").font(.footnote)
                    HStack { Button("Previous documents") { loadExtra("documents", offset: max(0, documentOffset - 5)) }.disabled(documentOffset == 0 || busy); Spacer(); Button("Next documents") { loadExtra("documents", offset: documentOffset + 5) }.disabled(documentOffset + documentPage.items.count >= documentPage.total || busy) }
                } else { Text("This document range has not loaded successfully. Retry it explicitly; source documents are not used as a hidden fallback.").font(.footnote) }
            }
            Notice("Selected facts and documents are reloaded at their exact displayed revisions before the first preparation request. The resulting immutable report still needs its own complete review and approval.")
        }.disabled(busy || intent != nil)
    }
    private func eligibleExtraFact(_ record: RecordItem) -> Bool { record.kind == "facts" && record.workspace_id == store.account?.workspace.id && record.value("farm_id") == farmID && record.id != factID && record.data["key"] != .string(PortugueseJournalData.key) && PortugueseJournalData.active(record) }
    private func loadExtra(_ kind: String, offset: Int) {
        guard ["facts", "documents"].contains(kind) else { return }
        start { stamp in
            if kind == "facts" { factPage = nil; factOffset = offset } else { documentPage = nil; documentOffset = offset }
            let farm = try await PortugueseJournalData.context(store: store, farmID: farmID, writing: false)
            guard bound(stamp) else { return }; currentFarmRevision = farm.revision
            let page = try await PortugueseJournalData.page(kind, farmID: farmID, offset: offset, store: store, journalOnly: false)
            guard bound(stamp) else { return }
            if kind == "facts" { factPage = page } else { documentPage = page }
        }
    }
    private func selectExtra(_ displayed: RecordItem, kind: String) {
        start { stamp in
            let fresh = try PortugueseJournalData.decode(await store.scopedValue("/\(kind)/\(displayed.id)"))
            guard bound(stamp) else { return }
            guard fresh.kind == kind, fresh.value("farm_id") == farmID, fresh.workspace_id == store.account?.workspace.id, fresh.revision == displayed.revision,
                  kind == "documents" || eligibleExtraFact(fresh) else { throw ServiceError(status: 409, message: "This source changed or is no longer an eligible confirmed fact or same-farm document. Reload and review it before selecting a different revision.") }
            let pin: JSONValue = .object(["revision": .number(Double(fresh.revision)), "title": .string(fresh.title)])
            if kind == "facts" { guard extraFacts.count < 4999 else { return }; extraFacts[fresh.id] = pin }
            else { guard outward.count < 250 else { return }; outward.insert(fresh.id); documentPins[fresh.id] = pin }
            acknowledged = false; try persist()
        }
    }
    private func checkExtraSources() async throws {
        guard extraBindingsComplete else { throw ServiceError(status: 409, message: "The extra evidence selection lacks complete revision pins. Remove and reselect those records explicitly.") }
        for id in extraFacts.keys.sorted() {
            let fresh = try PortugueseJournalData.decode(await store.scopedValue("/facts/" + id))
            guard eligibleExtraFact(fresh), extraFacts[id]?.object["revision"] == .number(Double(fresh.revision)) else { throw ServiceError(status: 409, message: "An extra selected fact changed, was superseded or lost its confirmed state. Compare it and explicitly choose the current evidence; no selection is rebased automatically.") }
        }
        for id in outward.sorted() {
            let fresh = try PortugueseJournalData.decode(await store.scopedValue("/documents/" + id))
            guard fresh.kind == "documents", fresh.workspace_id == store.account?.workspace.id, fresh.value("farm_id") == farmID, documentPins[id]?.object["revision"] == .number(Double(fresh.revision)) else { throw ServiceError(status: 409, message: "An outward selected document changed or no longer belongs to this farm. Compare it and explicitly reselect it; no unseen attachment is shared.") }
        }
    }
    private func reorder(_ index: Int, by delta: Int) { let destination = index + delta; guard selected.indices.contains(index), selected.indices.contains(destination) else { return }; selected.swapAt(index, destination) }
    private func restore() {
        guard !loaded else { return }; loaded = true; scope = store.account?.scope
        do {
            let draft = try store.loadForm(formKey); note = PortugueseJournalData.text(draft?["note"]); yearText = PortugueseJournalData.text(draft?["year"]); selected = draft?["entry_ids"]?.array.map(\.text) ?? []; outward = Set(draft?["document_ids"]?.array.map(\.text) ?? [])
            extraFacts = draft?["extra_facts"]?.object ?? [:]; documentPins = draft?["document_pins"]?.object ?? [:]
            if draft == nil, let context = reissue ?? request { yearText = SourceText.year(context.data["reporting_year"]) ?? "" }
            baselineRevision = SourceText.year(draft?["baseline_revision"]).flatMap(Int.init)
            baselineFarmRevision = SourceText.year(draft?["farm_revision"]).flatMap(Int.init); templateBaseline = draft?["template"]
            if case .object(let body)? = draft?["intent"] { intent = body }; intentPath = draft?["intent_path"] == .null ? nil : draft?["intent_path"]?.text; intentKey = draft?["intent_key"]?.text ?? intentKey; knownRejected = draft?["known_rejected"] == .bool(true); attempted = draft?["attempted"] == .bool(true)
        } catch { problem = SourceText.error(error) }
    }
    private func persist() throws {
        guard scope != nil, scope == store.account?.scope else { throw CancellationError() }
        try store.saveForm(formKey, value: ["note": .string(note), "year": .string(yearText), "entry_ids": .array(selected.map(JSONValue.string)), "document_ids": .array(outward.sorted().map(JSONValue.string)), "extra_facts": .object(extraFacts), "document_pins": .object(documentPins), "baseline_revision": baselineRevision.map { .number(Double($0)) } ?? .null, "farm_revision": baselineFarmRevision.map { .number(Double($0)) } ?? .null, "template": templateBaseline ?? .null, "intent": intent.map(JSONValue.object) ?? .null, "intent_path": intentPath.map(JSONValue.string) ?? .null, "intent_key": .string(intentKey), "known_rejected": .bool(knownRejected), "attempted": .bool(attempted)])
    }
    private func persistQuietly() { guard loaded, scope == store.account?.scope else { return }; do { try persist() } catch { problem = SourceText.error(error) } }
    private func cancel() { generation = UUID(); operation?.cancel(); operation = nil; busy = false }
    private func bound(_ stamp: UUID) -> Bool { generation == stamp && scope == store.account?.scope && store.sessionVerified && !Task.isCancelled }
    private func start(_ action: @escaping (UUID) async throws -> Void) {
        guard !busy, scope == store.account?.scope else { return }; let stamp = UUID(); generation = stamp; busy = true; problem = nil
        operation = Task { defer { if generation == stamp { busy = false; operation = nil } }; do { try await action(stamp) } catch { if bound(stamp) { problem = SourceText.error(error) } } }
    }
    private func load() {
        start { stamp in
            sourcesVerified = false; checked = false; acknowledged = false; visited = []; fact = nil
            let farm = try await PortugueseJournalData.context(store: store, farmID: farmID, writing: false)
            if let reissue { _ = try await PortugueseJournalData.reportBaseline(reissue, farmID: farmID, store: store) }
            if let request { _ = try await PortugueseJournalData.requestBaseline(request, farmID: farmID, store: store) }
            let current = try PortugueseJournalData.fact(await store.scopedValue("/facts/" + factID), farmID: farmID, workspace: store.account?.workspace.id)
            guard bound(stamp) else { return }
            fact = current; currentFarmRevision = farm.revision
            if baselineRevision == nil { baselineRevision = current.revision }
            if baselineFarmRevision == nil { baselineFarmRevision = farm.revision }
            if templateBaseline == nil || templateBaseline == .null { templateBaseline = .object(definition.raw) }
            pageOffset = min(pageOffset, max(0, ((entries.count - 1) / 16) * 16)); try persist()
            try await PortugueseJournalData.checkSources(current.data["sources"]?.array ?? [], store: store, farmID: farmID)
            guard bound(stamp) else { return }; sourcesVerified = true
        }
    }
    private func resetReview() { guard let fact, let currentFarmRevision, intent == nil || knownRejected else { return }; baselineRevision = fact.revision; baselineFarmRevision = currentFarmRevision; templateBaseline = .object(definition.raw); intent = nil; intentPath = nil; intentKey = UUID().uuidString; knownRejected = false; attempted = false; selected = []; outward = []; extraFacts = [:]; documentPins = [:]; factPage = nil; documentPage = nil; visited = []; checked = false; acknowledged = false; persistQuietly() }
    private func reviewFact() {
        guard let fact, unchanged, sourcesVerified, fact.state == "proposed", reviewedAll, checked, !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        queue(["expected_revision": .number(Double(fact.revision)), "decision": .string("confirmed"), "note": .string(note)], path: "/facts/\(factID)/review")
    }
    private func prepare() {
        guard let fact, PortugueseJournalData.active(fact), unchanged, sourcesVerified, selectionValid, extraBindingsComplete, reviewedAll, acknowledged, let year, PortugueseJournalData.nonempty(value["identity_text"]) else { return }
        var body: [String: JSONValue] = ["fact_ids": .array(([factID] + extraFacts.keys.sorted()).map(JSONValue.string)), "operation_ids": .array([]), "selected_document_ids": .array(outward.sorted().map(JSONValue.string)), "manual_journal_selection": .object(["source_fact_id": .string(factID), "source_fact_revision": .number(Double(fact.revision)), "entry_ids": .array(selected.map(JSONValue.string)), "acknowledged_unresolved": .bool(true)])]
        if let reissue {
            guard reissue.data["reporting_year"] == .number(Double(year)) else { problem = "The saved selection year differs from this report. Discard the old review choices and reopen the exact report; its year is not changed silently."; return }
            body["expected_revision"] = .number(Double(reissue.revision)); body["snapshot_checksum"] = reissue.data["checksum"]
        } else {
            body["farm_id"] = .string(farmID); body["pack_id"] = .string(PortugueseJournalData.pack); body["reporting_year"] = .number(Double(year))
            if let request {
                guard request.data["reporting_year"] == .number(Double(year)) else { problem = "The saved selection year differs from the linked letter. Reload the current letter; no new period or unlinked report is substituted."; return }
                body["request_id"] = .string(request.id)
            }
        }
        queue(body, path: reportPath)
    }
    private func queue(_ body: [String: JSONValue], path: String) {
        guard intent == nil, scope == store.account?.scope else { return }; intent = body; intentPath = path; intentKey = UUID().uuidString; knownRejected = false; attempted = false
        do { try persist(); send(body, path: path) } catch { problem = SourceText.error(error) }
    }
    private func send(_ body: [String: JSONValue], path: String) {
        guard path == reportPath || path == "/facts/\(factID)/review", intent == body, intentPath == path else { problem = "The retained action does not match this journal. It was not sent."; return }
        start { stamp in
            var sent = false
            do {
                let farm = try await PortugueseJournalData.context(store: store, farmID: farmID, writing: true)
                // Exact retries preserve their body/key. A successful lost response is resolved by backend idempotency, not an unseen revision rebase.
                if !attempted {
                    guard farm.revision == baselineFarmRevision else { throw ServiceError(status: 409, message: "The farm changed after this selection. Reload and explicitly compare the source context before reviewing a new preparation.") }
                    let pack = try await store.scopedValue("/packs/" + PortugueseJournalData.pack)
                    guard pack.object["manual_schema"] == templateBaseline else { throw ServiceError(status: 409, message: "The journal template changed after review. Reload the current template and explicitly review a new selection; no unseen labels or source edition are substituted.") }
                    if path == reportPath, let reissue { _ = try await PortugueseJournalData.reportBaseline(reissue, farmID: farmID, store: store) }
                    if path == reportPath, let request { _ = try await PortugueseJournalData.requestBaseline(request, farmID: farmID, store: store) }
                    if path == reportPath { try await checkExtraSources() }
                    let fresh = try PortugueseJournalData.fact(await store.scopedValue("/facts/" + factID), farmID: farmID, workspace: store.account?.workspace.id)
                    guard fresh.revision == baselineRevision, fresh.data["value"] == fact?.data["value"], fresh.data["sources"] == fact?.data["sources"] else { throw ServiceError(status: 409, message: "The source changed after your review. Keep the original selection and compare its current revision; no changed source is approved automatically.") }
                    try await PortugueseJournalData.checkSources(fresh.data["sources"]?.array ?? [], store: store, farmID: farmID)
                }
                guard bound(stamp) else { return }; attempted = true; try persist(); sent = true
                let response = try await store.scopedValue(path, method: "POST", body: body, idempotency: intentKey)
                guard bound(stamp) else { return }
                if path == reportPath {
                    let prepared = try PortugueseJournalData.decode(response)
                    guard prepared.kind == "reports", prepared.workspace_id == store.account?.workspace.id, prepared.value("farm_id") == farmID, prepared.value("pack_id") == PortugueseJournalData.pack, prepared.state == "draft" else { throw ServiceError(status: 0, message: "The prepared report did not match this journal's exact farm and template.") }; report = ReportTransport.compact(prepared)
                } else {
                    let reviewed = try PortugueseJournalData.fact(response, farmID: farmID, workspace: store.account?.workspace.id)
                    guard reviewed.id == factID, reviewed.state == "confirmed" else { throw ServiceError(status: 0, message: "The source confirmation result is not the expected journal fact.") }; fact = reviewed; baselineRevision = reviewed.revision
                }
                intent = nil; intentPath = nil; knownRejected = false; attempted = false; checked = false; acknowledged = false; visited = []; try persist()
            } catch { if bound(stamp), sent || !attempted { knownRejected = [400, 403, 404, 409, 413, 422].contains((error as? ServiceError)?.status ?? 0); try persist() }; throw error }
        }
    }
}
