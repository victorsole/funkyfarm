import SwiftUI
import UniformTypeIdentifiers

struct ImportRecordsView: View {
    @EnvironmentObject private var store: AppStore
    var initialProfileID: String? = nil
    var initialFarmID: String? = nil
    @State private var imports: [RecordItem] = []
    @State private var profiles: [[String: JSONValue]] = []
    @State private var profileID = ""
    @State private var delimiter = ","
    @State private var sourceConfirmed = false
    @State private var attachment: String?
    @State private var draftLoaded = false
    @State private var listOffset = 0
    @State private var listTotal = 0
    @State private var profileProblem: String?
    @State private var profileCatalogueReady = false
    @State private var trackedUploadValues: [String: JSONValue]?
    @State private var picker = false
    @State private var bytes: Data?
    @State private var filename = ""
    @State private var grain = ""
    @State private var farm = ""
    @State private var uploadKey = UUID()
    @State private var working = false
    @State private var problem: String?
    private var profile: [String: JSONValue]? { profiles.first { $0["id"]?.text == profileID } }
    private var formKey: String { "import-upload:" + (initialProfileID ?? "generic") + ":" + (initialFarmID ?? "choose") }
    private var uploadValues: [String: JSONValue] { ["grain": .string(grain), "farm_id": .string(farm), "format_profile": .string(profileID), "delimiter": .string(delimiter), "profile_definition_hash": profile?["definition_hash"] ?? .null, "source_year": profile?["source_year"] ?? .null] }
    private var canUpload: Bool {
        guard !grain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if profileID.isEmpty { return delimiter != "auto" }
        guard profileCatalogueReady, let profile, SourceText.year(profile["source_year"]) != nil, let farm = store.record("farms", farm) else { return false }
        return sourceConfirmed && farm.data["country"] == profile["country"]
    }
    var body: some View {
        List {
            Section("Bring in existing records") {
                Notice("Import a UTF-8 CSV file. The service preserves the original cells and source rows. Mapping and row review happen before any proposed farm facts or work records are created.")
                Picker("Source format", selection: $profileID) { Text("Generic column mapping").tag(""); ForEach(Array(profiles.enumerated()), id: \.offset) { _, profile in Text(profile["label"]?.text ?? profile["id"]?.text ?? "Source profile").tag(profile["id"]?.text ?? "") } }
                if !profileID.isEmpty {
                    if let profile { Text(profile["label"]?.text ?? profileID).font(.headline); LabeledContent("Documented source country", value: profile["country"]?.text ?? "Unknown"); LabeledContent("Documented source year", value: SourceText.year(profile["source_year"]) ?? "Unknown"); if let notice = profile["notice"] { Notice(notice.text) }; Toggle("I checked this is the selected country and year's source export", isOn: $sourceConfirmed) }
                    else { Notice("The selected source profile is unavailable. Reload the catalogue before uploading; no replacement profile is chosen automatically.", warning: true) }
                }
                Picker("File delimiter", selection: $delimiter) { Text("Comma").tag(","); Text("Semicolon").tag(";"); Text("Tab").tag("\t"); if !profileID.isEmpty { Text("Match the profile's documented headers").tag("auto") } }
                Button("Choose CSV file") { picker = true }.disabled(working)
                if let bytes {
                    Text(filename).font(.headline)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(bytes.count), countStyle: .file)).font(.caption)
                    FarmPicker(selected: $farm, optional: profileID.isEmpty)
                    if let profile, let selectedFarm = store.record("farms", farm), selectedFarm.data["country"] != profile["country"] { Notice("The selected farm country does not match this source profile. Choose the matching farm or source; nothing is reassigned automatically.", warning: true) }
                    TextField("What does each row represent?", text: $grain, axis: .vertical)
                    Text("For example, one field application on one date, or one holding and reporting year. Preserve the source's original level of detail.").font(.footnote).foregroundStyle(.secondary)
                    Button("Upload source for review") {
                        working = true; problem = nil
                        Task {
                            do { try persistDraft(); let item = try await store.importCSV(bytes: bytes, filename: filename, grain: grain, farmID: farm.isEmpty ? nil : farm, idempotency: uploadKey.uuidString, formatProfile: profileID.isEmpty ? nil : profileID, sourceYear: profile.flatMap { SourceText.year($0["source_year"]) }, delimiter: delimiter); imports.removeAll { $0.id == item.id }; imports.insert(item, at: 0); self.bytes = nil; try? store.clearForm(formKey); if let attachment { try? store.removeImportSource(attachment) }; attachment = nil }
                            catch { sourceConfirmed = false; problem = SourceText.error(error) }
                            working = false
                        }
                    }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || !canUpload)
                    Text("The selected file and unfinished choices are saved in this account's protected device storage. Upload creates source rows, not confirmed facts.").font(.footnote).foregroundStyle(.secondary)
                }
                if let profileProblem { Notice(profileProblem, warning: true) }
            }.disabled(working)
            Section("Import sources") {
                if imports.isEmpty { Text("No import sources are loaded.").foregroundStyle(.secondary) }
                ForEach(imports) { item in NavigationLink { ImportDetailView(importID: item.id) } label: { VStack(alignment: .leading) { Text(item.value("source_name").isEmpty ? item.title : item.value("source_name")).font(.headline); Text("\(item.value("row_count")) source rows · \(item.value("grain"))").font(.caption).foregroundStyle(.secondary) } } }
                HStack { Button("Previous sources") { listOffset = max(0, listOffset - 20) }.disabled(working || listOffset == 0); Spacer(); Button("More sources") { listOffset += 20 }.disabled(working || listOffset + imports.count >= listTotal) }
            }
            if working { Section { ProgressView("Waiting for import service…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Import records").task(id: listOffset) { restoreDraft(); await load() }.refreshable { await load() }
            .fileImporter(isPresented: $picker, allowedContentTypes: [.commaSeparatedText, .plainText], allowsMultipleSelection: false) { result in
                do {
                    guard let url = try result.get().first else { return }
                    let selected = try BoundedCSVReader.read(url)
                    let staged = try store.stageImportSource(selected), previous = attachment
                    bytes = selected; attachment = staged; filename = url.lastPathComponent; uploadKey = UUID(); sourceConfirmed = false
                    try persistDraft()
                    if let previous { try? store.removeImportSource(previous) }
                } catch { problem = error.localizedDescription }
            }
            .onChange(of: uploadValues) { value in guard draftLoaded, !working, value != trackedUploadValues else { return }; trackedUploadValues = value; sourceConfirmed = false; uploadKey = UUID(); if profileID.isEmpty && delimiter == "auto" { delimiter = "," }; do { try persistDraft() } catch { problem = error.localizedDescription } }
    }
    private func load() async {
        guard !working else { return }
        working = true; profileCatalogueReady = false; sourceConfirmed = false; defer { working = false }
        do {
            profiles = try await store.scopedValue("/imports/profiles").object["items"]?.array.map(\.object) ?? []; profileProblem = nil; profileCatalogueReady = true
            let current = uploadValues
            if current != trackedUploadValues { sourceConfirmed = false; uploadKey = UUID(); trackedUploadValues = current; try persistDraft() }
        }
        catch { profileProblem = "Prepared profiles could not be loaded. Generic mapping remains separate. " + SourceText.error(error) }
        do { let page = try await store.scopedValue("/imports?limit=20&offset=\(listOffset)"); imports = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(page.object["items"] ?? .array([]))); if case .number(let n)? = page.object["total"] { listTotal = Int(n) } }
        catch { problem = error.localizedDescription }
    }
    private func restoreDraft() {
        guard !draftLoaded else { return }; profileID = initialProfileID ?? ""; farm = initialFarmID ?? ""; delimiter = profileID.isEmpty ? "," : "auto"
        do { if let saved = try store.loadForm(formKey) { grain = saved["grain"]?.text ?? ""; farm = saved["farm_id"]?.text ?? farm; profileID = saved["format_profile"]?.text ?? profileID; delimiter = saved["delimiter"]?.text ?? delimiter; filename = saved["filename"]?.text ?? ""; if let key = saved["upload_key"]?.text, let value = UUID(uuidString: key) { uploadKey = value }; trackedUploadValues = saved.filter { uploadValues.keys.contains($0.key) }; if let name = saved["attachment"]?.text { attachment = name; bytes = try BoundedCSVReader.read(store.localAttachment(name).url) } } }
        catch { problem = "The saved import source could not be opened: " + error.localizedDescription }; if trackedUploadValues == nil { trackedUploadValues = uploadValues }; draftLoaded = true
    }
    private func persistDraft() throws {
        guard let attachment else { return }; var value = uploadValues; value["attachment"] = .string(attachment); value["filename"] = .string(filename); value["upload_key"] = .string(uploadKey.uuidString); try store.saveForm(formKey, value: value)
    }
}

struct ImportDetailView: View {
    @EnvironmentObject private var store: AppStore
    let importID: String
    @State private var item: RecordItem?
    @State private var rows: [RecordItem] = []
    @State private var working = false
    @State private var problem: String?
    @State private var offset = 0
    @State private var rowTotal = 0
    var body: some View {
        List {
            if let item {
                Section("Source record") {
                    Text(item.value("source_name")).font(.headline)
                    LabeledContent("Row meaning", value: item.value("grain"))
                    LabeledContent("Source rows", value: item.value("row_count"))
                    LabeledContent("Review state", value: item.state)
                    if item.data["format_profile"] != nil && item.data["format_profile"] != .null { NavigationLink("Review the prepared source profile") { ImportProfileReviewView(importID: importID) }; Notice("This source uses a prepared profile. Generic column mapping cannot change its source meanings.") }
                    else { NavigationLink("Review column mapping") { ImportMappingView(item: item) }; NavigationLink("Preview and review mapped rows") { ImportPreviewView(importID: importID) }; if let url = BrowserHandoff.url(account: store.account, path: "/app/imports", query: [URLQueryItem(name: "import", value: importID)]) { Link("Open advanced mapping in the web workspace", destination: url) }; Text("Advanced joins and exact null tokens use the web mapper with its own sign-in. No session token is passed in this link.").font(.footnote).foregroundStyle(.secondary) }
                }
                Section("Source rows, before mapping") {
                    ForEach(rows) { row in
                        VStack(alignment: .leading, spacing: 5) {
                            Text("Source row \(row.value("row_number"))").font(.headline)
                            Text(row.data["promoted_record"] == nil || row.data["promoted_record"] == .null ? "Original source · not promoted" : "Linked record exists · separate review state").font(.caption).foregroundStyle(.secondary)
                            DisclosureGroup("Inspect original source cells") { OriginalImportCells(columns: item.data["columns"]?.array ?? [], cells: row.data["original_row"]?.array ?? []) }
                            PromotedImportRecordLink(importID: importID, row: row.data)
                        }
                    }
                    HStack { Button("Previous source rows") { offset = max(0, offset - 20) }.disabled(working || offset == 0); Spacer(); Button("More source rows") { offset += 20 }.disabled(working || offset + rows.count >= rowTotal) }
                }
                Section { RecordMetadata(item: item) }
            }
            if working { Section { ProgressView("Loading import…") } }
            if let problem { Section { Notice(problem, warning: true); Button("Try again") { Task { await load() } } } }
        }.navigationTitle("Import source").task(id: offset) { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard !working else { return }
        working = true; item = nil; rows = []; defer { working = false }
        do {
            let value = try await store.scopedValue("/imports/\(importID)?limit=20&offset=\(offset)")
            item = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value))
            rows = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(value.object["rows"]?.object["items"] ?? .array([])))
            if case .number(let n)? = value.object["rows"]?.object["total"] { rowTotal = Int(n) }
        } catch { problem = error.localizedDescription }
    }
}

struct ImportMappingView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let item: RecordItem
    @State private var target = "facts"
    @State private var farm = ""
    @State private var columns: [[String: JSONValue]] = []
    @State private var period = ""
    @State private var basis = ""
    @State private var fixedKey = ""
    @State private var fixedLabel = ""
    @State private var fixedUnit = ""
    @State private var working = false
    @State private var problem: String?
    private var targets: [String] {
        switch target {
        case "operations": return ["title", "date", "type", "quantity", "unit", "parcel", "product", "crop", "note", "hours"]
        case "purchases": return ["title", "date", "amount", "currency", "category", "quantity", "unit", "supplier", "invoice_number", "tax_amount", "tax_rate", "credit", "note"]
        case "sales": return ["title", "date", "amount", "currency", "category", "quantity", "unit", "buyer", "invoice_number", "tax_amount", "tax_rate", "credit", "note"]
        default: return ["key", "label", "value", "unit", "period", "temporal_basis"]
        }
    }
    var body: some View {
        Form {
            Section("Record destination") {
                Picker("Create proposed", selection: $target) { Text("Farm facts").tag("facts"); Text("Work records").tag("operations"); Text("Purchases").tag("purchases"); Text("Sales").tag("sales") }
                FarmPicker(selected: $farm)
                Text("No source row is promoted by saving this mapping. Review the resulting values and diagnostics in the next screen.").font(.footnote).foregroundStyle(.secondary)
                if target == "sales" { Notice("Map the actual buyer and sale date from the source. Supplier columns are not converted into buyers, and animal movement rows do not establish financial sales.") }
            }
            Section("Columns") {
                ForEach(columns.indices, id: \.self) { index in
                    DisclosureGroup(columns[index]["header"]?.text ?? "Column \(index + 1)") {
                        Picker("Use as", selection: binding(index, "target_field", fallback: "")) { Text("Keep as source only").tag(""); ForEach(targets, id: \.self) { Text($0.replacingOccurrences(of: "_", with: " ").capitalized).tag($0) } }
                        Picker("Value type", selection: binding(index, "value_type", fallback: "text")) { Text("Text").tag("text"); Text("Number").tag("number"); Text("Whole number").tag("integer"); Text("ISO / calendar date").tag("date"); Text("Structured JSON").tag("json") }
                        Picker("Blank cells", selection: binding(index, "blank_behavior", fallback: "preserve")) { Text("Preserve empty text").tag("preserve"); Text("Unknown / null").tag("null"); Text("Missing field").tag("missing") }
                        Picker("Decimal separator", selection: binding(index, "decimal_separator", fallback: ".")) { Text("Decimal point").tag("."); Text("Decimal comma").tag(",") }
                        Picker("Date format", selection: binding(index, "date_format", fallback: "iso")) { Text("ISO year-month-day").tag("iso"); Text("Day-month-year").tag("dmy"); Text("Month-day-year").tag("mdy") }
                        Text("Source column index: \(columns[index]["source_index"]?.text ?? "")").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Section("Explicit shared values, if appropriate") {
                if target == "facts" { TextField("Fact key, if not supplied by a column", text: $fixedKey); TextField("Fact label, if not supplied by a column", text: $fixedLabel) }
                TextField("Unit, if shared by these rows", text: $fixedUnit)
                TextField("Period, only if shared by these rows", text: $period)
                Picker("Time basis", selection: $basis) { Text("Take it from source mapping").tag(""); Text("Calendar date").tag("calendar_date"); Text("Campaign year").tag("campaign_year"); Text("Static fact").tag("static") }
                Text("Do not turn an annual total into a dated action, or infer units missing from the source. Advanced joins and exact null tokens remain available in the web mapping editor.").font(.footnote).foregroundStyle(.secondary)
            }
            Section {
                Button("Save reviewed mapping") { save() }.buttonStyle(.borderedProminent).disabled(working || farm.isEmpty || !store.sessionVerified)
                if working { ProgressView("Saving mapping…") }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("Column mapping").onAppear {
            columns = item.data["columns"]?.array.map(\.object) ?? []; target = item.data["target"]?.text ?? "facts"; farm = item.value("farm_id").suppliedValue
            if farm.isEmpty, store.records("farms").count == 1 { farm = store.records("farms")[0].id }
            let defaults = item.data["defaults"]?.object ?? [:]
            period = defaults["period"]?.text.suppliedValue ?? ""; basis = defaults["temporal_basis"]?.text.suppliedValue ?? ""; fixedKey = defaults["key"]?.text ?? ""; fixedLabel = defaults["label"]?.text ?? ""; fixedUnit = defaults["unit"]?.text.suppliedValue ?? ""
        }
        .onChange(of: target) { _ in
            for index in columns.indices { if let field = columns[index]["target_field"]?.text, !targets.contains(field) { columns[index]["target_field"] = .null } }
        }
    }
    private func binding(_ index: Int, _ key: String, fallback: String) -> Binding<String> {
        Binding(get: { columns[index][key] == .null ? fallback : columns[index][key]?.text ?? fallback }, set: { columns[index][key] = $0.isEmpty ? .null : .string($0) })
    }
    private func save() {
        guard item.data["format_profile"] == nil || item.data["format_profile"] == .null else { problem = "Prepared source profiles cannot use generic column mapping. Open source-profile review instead."; return }
        working = true; problem = nil
        Task {
            do {
                var defaults: [String: JSONValue] = ["farm_id": .string(farm)]
                for (key, value) in [("period", period), ("temporal_basis", basis), ("key", fixedKey), ("label", fixedLabel), ("unit", fixedUnit)] where !value.isEmpty { defaults[key] = .string(value) }
                let accepted = Set(["source_index", "target_field", "role", "reference_kind", "value_type", "decimal_separator", "date_format", "blank_behavior", "null_tokens"])
                let mappings = columns.map { JSONValue.object($0.filter { accepted.contains($0.key) }) }
                _ = try await store.scopedValue("/imports/\(item.id)/mapping", method: "POST", body: ["expected_revision": .number(Double(item.revision)), "target": .string(target), "defaults": .object(defaults), "columns": .array(mappings)])
                dismiss()
            } catch { problem = error.localizedDescription }
            working = false
        }
    }
}

struct ImportPreviewView: View {
    @EnvironmentObject private var store: AppStore
    let importID: String
    @State private var previews: [[String: JSONValue]] = []
    @State private var importRevision = 0
    @State private var offset = 0
    @State private var total = 0
    @State private var working = false
    @State private var problem: String?
    var body: some View {
        List {
            Section { Notice("Check the original source row, mapped values and all warnings. Promoting a row creates a proposal, which still needs ordinary fact or work review.") }
            Section("Mapped rows") {
                ForEach(Array(previews.enumerated()), id: \.offset) { index, preview in NavigationLink { ImportRowReview(importID: importID, sourceOffset: offset + index, initial: preview) } label: {
                    VStack(alignment: .leading) {
                        Text("Source row \(preview["row"]?.object["data"]?.object["row_number"]?.text ?? "")").font(.headline)
                        Text(preview["data"]?.object["label"]?.text ?? preview["data"]?.object["title"]?.text ?? preview["target"]?.text ?? "Mapped record").font(.subheadline)
                        if let promoted = preview["row"]?.object["data"]?.object["promoted_record"], promoted != .null { Text("Existing record linked · inspect its separate review state").font(.caption).foregroundStyle(.secondary) }
                        else if preview["can_save"] != .bool(true) { Text("Source or mapping checks need attention").font(.caption).foregroundStyle(.secondary) }
                        Text("\(preview["issues"]?.array.count ?? 0) source checks to inspect").font(.caption).foregroundStyle(.secondary)
                    }
                } }
                HStack { Button("Previous rows") { offset = max(0, offset - 20) }.disabled(offset == 0 || working); Spacer(); Button("Next rows") { offset += 20 }.disabled(offset + previews.count >= total || working) }
                Text("\(previews.isEmpty ? 0 : offset + 1)–\(offset + previews.count) of \(total) rows").font(.caption).foregroundStyle(.secondary)
            }
            if working { Section { ProgressView("Loading current row previews…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Review imported rows").task(id: offset) { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard !working else { return }
        working = true; problem = nil; defer { working = false }
        do {
            previews = []
            let page = try await store.scopedValue("/imports/\(importID)/preview?limit=20&offset=\(offset)").object
            previews = page["items"]?.array.map(\.object) ?? []
            if case .number(let number)? = page["total"] { total = Int(number) }
            if case .number(let number)? = page["import_revision"] { importRevision = Int(number) }
        } catch { problem = error.localizedDescription }
    }
}

enum BrowserHandoff {
    static func url(account: Account?, path: String, query: [URLQueryItem] = []) -> URL? {
        guard let base = account?.baseURL, var components = URLComponents(string: base) else { return nil }
        if components.port == 8139 { components.port = 5189 }
        components.path = path; components.queryItems = query.isEmpty ? nil : query; components.fragment = nil
        return components.url
    }
}
