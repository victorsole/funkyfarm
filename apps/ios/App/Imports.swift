import SwiftUI
import UniformTypeIdentifiers

struct ImportRecordsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var imports: [RecordItem] = []
    @State private var picker = false
    @State private var bytes: Data?
    @State private var filename = ""
    @State private var grain = ""
    @State private var farm = ""
    @State private var uploadKey = UUID()
    @State private var working = false
    @State private var problem: String?
    var body: some View {
        List {
            Section("Bring in existing records") {
                Notice("Import a UTF-8 CSV file. The service preserves the original cells and source rows. Mapping and row review happen before any proposed farm facts or work records are created.")
                Button("Choose CSV file") { picker = true }
                if let bytes {
                    Text(filename).font(.headline)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(bytes.count), countStyle: .file)).font(.caption)
                    FarmPicker(selected: $farm, optional: true)
                    TextField("What does each row represent?", text: $grain, axis: .vertical)
                    Text("For example, one field application on one date, or one holding and reporting year. Preserve the source's original level of detail.").font(.footnote).foregroundStyle(.secondary)
                    Button("Upload source for review") {
                        working = true; problem = nil
                        Task {
                            do { let item = try await store.importCSV(bytes: bytes, filename: filename, grain: grain, farmID: farm.isEmpty ? nil : farm, idempotency: uploadKey.uuidString); imports.removeAll { $0.id == item.id }; imports.insert(item, at: 0); self.bytes = nil }
                            catch { problem = error.localizedDescription }
                            working = false
                        }
                    }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || grain.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            Section("Import sources") {
                if imports.isEmpty { Text("No import sources are loaded.").foregroundStyle(.secondary) }
                ForEach(imports) { item in NavigationLink { ImportDetailView(importID: item.id) } label: { VStack(alignment: .leading) { Text(item.value("source_name").isEmpty ? item.title : item.value("source_name")).font(.headline); Text("\(item.value("row_count")) source rows · \(item.value("grain"))").font(.caption).foregroundStyle(.secondary) } } }
            }
            if working { Section { ProgressView("Waiting for import service…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Import records").task { await load() }.refreshable { await load() }
            .fileImporter(isPresented: $picker, allowedContentTypes: [.commaSeparatedText, .plainText], allowsMultipleSelection: false) { result in
                do {
                    guard let url = try result.get().first else { return }
                    let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= IntakeInbox.maximumFileBytes else { throw ServiceError(status: 0, message: "Choose a CSV file up to 20 MB.") }
                    let selected = try Data(contentsOf: url)
                    guard selected.count <= IntakeInbox.maximumFileBytes else { throw ServiceError(status: 0, message: "Choose a CSV file up to 20 MB.") }
                    bytes = selected; filename = url.lastPathComponent; uploadKey = UUID()
                } catch { problem = error.localizedDescription }
            }
            .onChange(of: grain) { _ in uploadKey = UUID() }
            .onChange(of: farm) { _ in uploadKey = UUID() }
    }
    private func load() async {
        working = true; defer { working = false }
        do { let page = try await store.scopedValue("/imports"); imports = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(page.object["items"] ?? .array([]))) }
        catch { problem = error.localizedDescription }
    }
}

struct ImportDetailView: View {
    @EnvironmentObject private var store: AppStore
    let importID: String
    @State private var item: RecordItem?
    @State private var rows: [RecordItem] = []
    @State private var working = false
    @State private var problem: String?
    var body: some View {
        List {
            if let item {
                Section("Source record") {
                    Text(item.value("source_name")).font(.headline)
                    LabeledContent("Row meaning", value: item.value("grain"))
                    LabeledContent("Source rows", value: item.value("row_count"))
                    LabeledContent("Review state", value: item.state)
                    NavigationLink("Review column mapping") { ImportMappingView(item: item) }
                    NavigationLink("Preview and review mapped rows") { ImportPreviewView(importID: importID) }
                    if let url = BrowserHandoff.url(account: store.account, path: "/app/imports", query: [URLQueryItem(name: "import", value: importID)]) { Link("Open advanced mapping in the web workspace", destination: url) }
                    Text("The browser requires its own sign-in. No session token is passed in the link. Use advanced mapping for foreign-key joins and source-specific adapters.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Source rows, before mapping") {
                    ForEach(rows) { row in DisclosureGroup("Row \(row.value("row_number"))") { Text(row.data["original_row"]?.text ?? "").font(.callout).textSelection(.enabled); if let diagnostics = row.data["diagnostics"] { Text(diagnostics.text).font(.caption) } } }
                    Text("The first returned source rows are shown here. The mapped preview supports paging and per-row review.").font(.footnote).foregroundStyle(.secondary)
                }
                Section { RecordMetadata(item: item) }
            }
            if working { Section { ProgressView("Loading import…") } }
            if let problem { Section { Notice(problem, warning: true); Button("Try again") { Task { await load() } } } }
        }.navigationTitle("Import source").task { await load() }.refreshable { await load() }
    }
    private func load() async {
        working = true; defer { working = false }
        do {
            let value = try await store.scopedValue("/imports/\(importID)")
            item = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value))
            rows = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(value.object["rows"]?.object["items"] ?? .array([])))
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
                ForEach(Array(previews.enumerated()), id: \.offset) { _, preview in NavigationLink { ImportRowReview(importID: importID, importRevision: importRevision, preview: preview) } label: {
                    VStack(alignment: .leading) { Text("Source row \(preview["row"]?.object["data"]?.object["row_number"]?.text ?? "")").font(.headline); Text(preview["data"]?.object["label"]?.text ?? preview["data"]?.object["title"]?.text ?? preview["target"]?.text ?? "Mapped record").font(.subheadline); if preview["can_save"] != .bool(true) { Text("Resolve source or mapping issues before promotion").font(.caption).foregroundStyle(.secondary) } }
                } }
                HStack { Button("Previous rows") { offset = max(0, offset - 50) }.disabled(offset == 0 || working); Spacer(); Button("Next rows") { offset += 50 }.disabled(offset + previews.count >= total || working) }
                Text("\(previews.isEmpty ? 0 : offset + 1)–\(offset + previews.count) of \(total) rows").font(.caption).foregroundStyle(.secondary)
            }
            if working { Section { ProgressView("Loading current row previews…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Review imported rows").task(id: offset) { await load() }.refreshable { await load() }
    }
    private func load() async {
        working = true; problem = nil; defer { working = false }
        do {
            let page = try await store.scopedValue("/imports/\(importID)/preview?limit=50&offset=\(offset)").object
            previews = page["items"]?.array.map(\.object) ?? []
            if case .number(let number)? = page["total"] { total = Int(number) }
            if case .number(let number)? = page["import_revision"] { importRevision = Int(number) }
        } catch { problem = error.localizedDescription }
    }
}

struct ImportRowReview: View {
    @EnvironmentObject private var store: AppStore
    let importID: String
    let importRevision: Int
    let preview: [String: JSONValue]
    @State private var acknowledged: Set<String> = []
    @State private var note = ""
    @State private var working = false
    @State private var result: JSONValue?
    @State private var problem: String?
    var body: some View {
        List {
            Section("Original source row") { Text(preview["row"]?.object["data"]?.object["original_row"]?.text ?? "Source row unavailable").textSelection(.enabled) }
            Section("Proposed normalized values") { JSONFields(data: preview["normalized_data"]?.object ?? preview["data"]?.object ?? [:]) }
            Section("Checks to review") {
                let issues = preview["issues"]?.array ?? []
                ForEach(Array(issues.enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? issue.text, warning: issue.object["severity"]?.text == "error") }
                ForEach((preview["requires_acknowledgement"]?.array ?? []).map(\.text), id: \.self) { code in Toggle(issues.first { $0.object["code"]?.text == code }?.object["message"]?.text ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                TextField("Source review note", text: $note, axis: .vertical)
                Button("Create reviewed proposal from this row") { review() }.buttonStyle(.borderedProminent).disabled(working || result != nil || note.isEmpty || preview["can_save"] != .bool(true) || !Set((preview["requires_acknowledgement"]?.array ?? []).map(\.text)).isSubset(of: acknowledged) || importRevision <= 0)
                if working { ProgressView("Recording row review…") }
                if let result { JSONFields(data: result.object); Notice("Use the returned saved and failed counts above. A saved row is still a proposal until its fact or work review is confirmed.") }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("Review source row")
    }
    private func review() {
        let row = preview["row"]?.object ?? [:]
        guard let rowNumber = row["data"]?.object["row_number"], let rowRevision = row["revision"], let token = preview["preview_token"] else { problem = "The current row token or revision is missing. Reload the preview before review."; return }
        working = true; problem = nil
        Task {
            do { result = try await store.scopedValue("/imports/\(importID)/rows/review", method: "POST", body: ["expected_revision": .number(Double(importRevision)), "note": .string(note), "rows": .array([.object(["row_number": rowNumber, "expected_revision": rowRevision, "preview_token": token, "acknowledged_issues": .array(acknowledged.sorted().map(JSONValue.string))])])]); await store.refresh() }
            catch { problem = error.localizedDescription }
            working = false
        }
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
