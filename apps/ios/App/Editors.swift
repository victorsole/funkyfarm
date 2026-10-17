import SwiftUI

struct FarmPicker: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selected: String
    var optional = false
    var body: some View {
        Picker("Farm", selection: $selected) {
            Text(optional ? "Assign later" : "Choose farm").tag("")
            ForEach(store.records("farms")) { farm in Text(farm.title).tag(farm.id) }
        }
    }
}

struct RequestEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    var existing: RecordItem? = nil
    var document: RecordItem? = nil
    @State private var farm = ""
    @State private var title = ""
    @State private var recipient = ""
    @State private var country = "DE"
    @State private var region = ""
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var deadline = Date()
    @State private var hasDeadline = false
    @State private var requirements = ""
    @State private var pack = ""
    @State private var status = "draft"
    @State private var error: String?
    @State private var loaded = false
    private let countries = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]
    private var availablePacks: [Pack] { store.packs(country: country, year: year) }
    var body: some View {
        Form {
            Section {
                Notice(document == nil ? "Save reviewed request details as a device draft, then sync when connected." : "Check the original letter. Dates, requirements and recipient details are proposals until you review them here.")
                FarmPicker(selected: $farm)
                TextField("Request title", text: $title)
                TextField("Recipient or authority", text: $recipient)
                Picker("Country", selection: Binding(get: { country }, set: { country = $0; pack = "" })) { ForEach(countries, id: \.self) { Text(Locale.current.localizedString(forRegionCode: $0) ?? $0).tag($0) } }
                TextField("Region (if applicable)", text: $region)
                Stepper("Reporting year \(String(year))", value: Binding(get: { year }, set: { year = $0; pack = "" }), in: 2000...2100)
                Toggle("A deadline is specified", isOn: $hasDeadline)
                if hasDeadline { DatePicker("Deadline", selection: $deadline, displayedComponents: .date) }
            }
            Section("Supported format") {
                Button("Load available packs") {
                    Task { do { try await store.loadPacks(country: country, year: year) } catch { self.error = error.localizedDescription } }
                }
                Picker("Reporting pack", selection: $pack) {
                    Text("Choose pack").tag("")
                    if !pack.isEmpty, !availablePacks.contains(where: { $0.id == pack }) { Text("Previously selected: \(pack)").tag(pack) }
                    ForEach(availablePacks) { Text($0.title).tag($0.id) }
                }
                if let selected = availablePacks.first(where: { $0.id == pack }) { Text(selected.capability).font(.footnote); DisclosureGroup("Sources and version") { JSONFields(data: selected.data) } }
                Text("Only formats returned by the service are offered. A general dossier does not establish a country-specific submission.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Requirements") {
                TextField("One requirement per line", text: $requirements, axis: .vertical).lineLimit(4...12)
                if existing != nil {
                    Picker("Working state", selection: $status) {
                        ForEach(["draft", "review", "waiting"], id: \.self) { Text($0.capitalized).tag($0) }
                        if !["draft", "review", "waiting"].contains(status) { Text("Recorded: \(status)").tag(status) }
                    }
                }
                Text("Readiness and response history should follow completed reviews and real responses. An export does not establish acceptance.").font(.footnote).foregroundStyle(.secondary)
            }
            if let error { Section { Notice(error, warning: true) } }
        }.navigationTitle(existing == nil ? "New request" : "Review request")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save draft") { save() }.disabled(farm.isEmpty || title.isEmpty || recipient.isEmpty || pack.isEmpty) }
            }
            .onAppear {
                guard !loaded else { return }; loaded = true
                if let existing {
                    farm = existing.value("farm_id"); title = existing.value("title"); recipient = existing.value("recipient"); country = existing.value("country")
                    region = existing.value("region") == "Not supplied" ? "" : existing.value("region")
                    if case .number(let n)? = existing.data["reporting_year"] { year = Int(n) }
                    pack = existing.value("pack_id"); status = existing.state
                    requirements = existing.data["requirements"]?.array.map(\.text).joined(separator: "\n") ?? ""
                    let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
                    if let date = formatter.date(from: existing.value("deadline")) { deadline = date; hasDeadline = true }
                } else if store.records("farms").count == 1 { farm = store.records("farms")[0].id }
            }
    }
    private func save() {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
        var data = existing?.data ?? [:]
        data.merge(["farm_id": .string(farm), "title": .string(title), "recipient": .string(recipient), "country": .string(country), "region": region.isEmpty ? .null : .string(region), "reporting_year": .number(Double(year)), "deadline": hasDeadline ? .string(formatter.string(from: deadline)) : .null, "pack_id": .string(pack), "requirements": .array(requirements.split(separator: "\n").map { .string(String($0)) }), "status": .string(status)], uniquingKeysWith: { _, new in new })
        do {
            if let document { try store.saveAction(path: "/documents/\(document.id)/request", label: title, payload: ["expected_revision": .number(Double(document.revision)), "data": .object(data)]) }
            else { try store.saveEdit(collection: "requests", existing: existing, data: data, label: title) }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct RecordEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let collection: String
    var existing: RecordItem? = nil
    var farmID: String? = nil
    var correction: RecordItem? = nil
    var proposal: [String: JSONValue]? = nil
    @State private var farm = ""
    @State private var name = ""
    @State private var country = ""
    @State private var key = ""
    @State private var value = ""
    @State private var valueType = "text"
    @State private var unit = ""
    @State private var period = ""
    @State private var temporalBasis = "campaign_year"
    @State private var notes = ""
    @State private var source = ""
    @State private var sourceRecordKind = ""
    @State private var sourceRecordID = ""
    @State private var date = Date()
    @State private var error: String?
    @State private var loaded = false
    @State private var correctionReviewed = false
    var body: some View {
        Group {
            if ["operations", "purchases", "sales"].contains(collection) { WorkCaptureView(existing: existing, initialFarmID: farmID, initialKind: collection) }
            else { editForm }
        }
    }
    private var editForm: some View {
        Form {
            Section {
                if collection != "farms" { FarmPicker(selected: $farm) }
                TextField(collection == "facts" ? "Fact label" : "Name or title", text: $name)
                if collection == "farms" { TextField("Country code", text: $country).textInputAutocapitalization(.characters); TextField("Region and farm context", text: $notes, axis: .vertical) }
                else if collection == "facts" {
                    TextField("Fact key", text: $key).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Picker("Value type", selection: $valueType) { Text("Text").tag("text"); Text("Number").tag("number"); Text("True / false").tag("boolean"); Text("Unknown / null").tag("null"); Text("Structured JSON").tag("json") }
                    if valueType != "null" { TextField(valueType == "boolean" ? "true or false" : "Value", text: $value, axis: .vertical) }
                    TextField("Unit (only if known)", text: $unit)
                    Picker("Time basis", selection: $temporalBasis) { Text("Campaign year").tag("campaign_year"); Text("Calendar date").tag("calendar_date"); Text("Static fact").tag("static") }
                    TextField("Period, year or ISO date", text: $period)
                    TextField("Source and review note", text: $source, axis: .vertical)
                    Picker("Link a confirmed source record", selection: $sourceRecordKind) { Text("No additional record").tag(""); Text("Sale").tag("sales"); Text("Purchase").tag("purchases"); Text("Work").tag("operations") }
                    if !sourceRecordKind.isEmpty {
                        Picker("Reviewed source", selection: $sourceRecordID) {
                            Text("Choose a confirmed record").tag("")
                            ForEach(store.records(sourceRecordKind).filter { $0.value("farm_id") == farm && $0.state == "confirmed" }) { record in Text("\(record.title) · \(record.value("date")) · revision \(record.revision)").tag(record.id) }
                        }
                        Text("Enter this fact's value and period yourself. A source link does not calculate a total or turn a sale or purchase into a product application.").font(.footnote).foregroundStyle(.secondary)
                    }
                    Notice("Saved facts start as proposals. Review the source and confirm separately. Unknown values remain unknown; zero is a recorded number.")
                    if let correction {
                        Notice("The current confirmed revision \(correction.revision) was fetched before opening this editor. Its value is \(correction.data["value"]?.text ?? "Not supplied"). This creates a separate proposal; earlier facts and issued reports stay in history.")
                        Toggle("I compared this correction with the current value and sources", isOn: $correctionReviewed)
                    }
                    if let sources = proposal?["sources"] { DisclosureGroup("Original source location") { Text(sources.text).textSelection(.enabled) } }
                } else {
                    DatePicker("Recorded date", selection: $date, displayedComponents: .date)
                    TextField("Notes / activity", text: $notes, axis: .vertical)
                    TextField("Evidence/source reference", text: $source, axis: .vertical)
                }
            }
            if let error { Section { Notice(error, warning: true) } }
        }.navigationTitle(correction == nil ? "Save \(collection == "farms" ? "farm" : "record")" : "Propose correction")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save draft") { save() }.disabled(name.isEmpty || (collection != "farms" && farm.isEmpty) || (collection == "facts" && key.isEmpty) || (correction != nil && !correctionReviewed)) }
            }
            .onAppear {
                guard !loaded else { return }; loaded = true
                farm = farmID ?? existing?.value("farm_id") ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "")
                if let existing { name = existing.title; country = existing.value("country"); notes = existing.value("notes") }
                if let fact = correction {
                    name = fact.title; key = fact.value("key"); applyValue(fact.data["value"])
                    unit = fact.value("unit") == "Not supplied" ? "" : fact.value("unit")
                    period = fact.value("period") == "Not supplied" ? "" : fact.value("period")
                    temporalBasis = fact.value("temporal_basis")
                }
                if let proposal { name = proposal["label"]?.text ?? ""; key = proposal["key"]?.text ?? ""; applyValue(proposal["value"]) }
            }
            .onChange(of: sourceRecordKind) { _ in sourceRecordID = "" }
            .onChange(of: farm) { _ in sourceRecordID = "" }
    }
    private func applyValue(_ raw: JSONValue?) {
        switch raw {
        case .number(let n)?: valueType = "number"; value = String(n)
        case .bool(let b)?: valueType = "boolean"; value = b ? "true" : "false"
        case .null?: valueType = "null"; value = ""
        case .object?, .array?: valueType = "json"; value = raw?.text ?? ""
        default: valueType = "text"; value = raw?.text ?? ""
        }
    }
    private func save() {
        var data = existing?.data ?? [:]
        if collection == "farms" { data.merge(["name": .string(name), "country": .string(country), "notes": .string(notes)], uniquingKeysWith: { _, new in new }) }
        else if collection == "facts" {
            let jsonValue: JSONValue
            switch valueType {
            case "number":
                guard let number = Double(value), number.isFinite else { error = "Enter a finite number using a decimal point."; return }; jsonValue = .number(number)
            case "boolean":
                guard ["true", "false"].contains(value.lowercased()) else { error = "Enter true or false."; return }; jsonValue = .bool(value.lowercased() == "true")
            case "null": jsonValue = .null
            case "json":
                guard let decoded = try? JSONDecoder().decode(JSONValue.self, from: Data(value.utf8)) else { error = "Enter valid JSON. Unreadable or unknown values can be recorded as null."; return }; jsonValue = decoded
            default: jsonValue = .string(value)
            }
            var sources = proposal?["sources"]?.array ?? correction?.data["sources"]?.array ?? []
            if !source.isEmpty { sources.append(.object(["type": .string("manual"), "note": .string(source)])) }
            if !sourceRecordKind.isEmpty {
                guard let record = store.record(sourceRecordKind, sourceRecordID), record.state == "confirmed", record.value("farm_id") == farm else { error = "Choose a confirmed source record from this farm, or remove the additional source selection."; return }
                sources.append(.object(["record_id": .string(record.id), "record_kind": .string(sourceRecordKind), "revision": .number(Double(record.revision)), "note": .string(source)]))
            }
            data = ["farm_id": .string(farm), "key": .string(key), "label": .string(name), "value": jsonValue, "unit": unit.isEmpty ? .null : .string(unit), "period": period.isEmpty ? .null : .string(period), "temporal_basis": .string(temporalBasis), "sources": .array(sources), "review_status": .string("proposed")]
            if let correction {
                data["supersedes_id"] = .string(correction.id)
                sources.append(.object(["kind": .string("correction"), "record_id": .string(correction.id), "revision": .number(Double(correction.revision)), "note": .string(source)]))
                data["sources"] = .array(sources)
            }
        } else {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
            data = ["farm_id": .string(farm), "title": .string(name), "date": .string(formatter.string(from: date)), "notes": .string(notes), "sources": .array(source.isEmpty ? [] : [.object(["note": .string(source)])])]
        }
        do { try store.saveEdit(collection: collection, existing: existing, data: data, label: name); dismiss() }
        catch { self.error = error.localizedDescription }
    }
}

struct ReportComposer: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    var request: RecordItem? = nil
    var reissue: RecordItem? = nil
    var initialFarmID: String? = nil
    var initialPackID: String? = nil
    var initialYear: Int? = nil
    var initialOperationIDs: Set<String> = []
    @State private var farm = ""
    @State private var country = "DE"
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var pack = ""
    @State private var selectedFacts: Set<String> = []
    @State private var selectedDocuments: Set<String> = []
    @State private var selectedOperations: Set<String> = []
    @State private var replaceRetainedOperations = false
    @State private var preflight: [String: JSONValue]?
    @State private var checkedSelection: [String: JSONValue]?
    @State private var initialized = false
    @State private var selectionFarm = ""
    @State private var submissionKey = UUID()
    @State private var working = false
    @State private var error: String?
    private var availablePacks: [Pack] { store.packs(country: country, year: year) }
    private var actualRequestID: String? { if let request { return request.id }; guard let id = reissue?.data["request_id"]?.text, UUID(uuidString: id) != nil else { return nil }; return id }
    private var contextRequest: RecordItem? { request ?? actualRequestID.flatMap { store.record("requests", $0) } }
    private var journalPack: Bool { pack == CzechJournalData.pack || availablePacks.first(where: { $0.id == pack })?.data["journal_schema"] == .string(CzechJournalData.schema) }
    private var eligibleOperations: [RecordItem] { store.records("operations").filter { $0.value("farm_id") == farm && $0.state == "confirmed" && CzechJournalData.isActive($0) && CzechJournalData.year($0) == year && (!journalPack || CzechJournalData.isEntry($0)) } }
    private var sourceRevisions: [String: JSONValue] {
        var result: [String: JSONValue] = [:]
        for collection in ["facts", "documents", "operations"] {
            let selected = collection == "facts" ? selectedFacts : collection == "documents" ? selectedDocuments : selectedOperations
            for record in store.records(collection) where selected.contains(record.id) { result[collection + ":" + record.id] = .array([.number(Double(record.revision)), .string(record.state)]) }
        }
        if let request = contextRequest { result["request"] = .number(Double(store.record("requests", request.id)?.revision ?? request.revision)) }
        if let farm = store.record("farms", farm) { result["farm"] = .number(Double(farm.revision)) }
        return result
    }
    private var preparation: [String: JSONValue] {
        var body: [String: JSONValue] = ["farm_id": .string(farm), "pack_id": .string(pack), "reporting_year": .number(Double(year)), "fact_ids": .array(selectedFacts.sorted().map(JSONValue.string)), "selected_document_ids": .array(selectedDocuments.sorted().map(JSONValue.string))]
        if reissue == nil || journalPack || replaceRetainedOperations { body["operation_ids"] = .array(selectedOperations.sorted().map(JSONValue.string)) }
        if let actualRequestID { body["request_id"] = .string(actualRequestID) }
        return body
    }
    var body: some View {
        Form {
            Section("Prepare a reviewed draft") {
                FarmPicker(selected: $farm).disabled(request != nil || reissue != nil)
                TextField("Country code", text: $country).textInputAutocapitalization(.characters).disabled(request != nil || reissue != nil)
                Stepper("Reporting year \(String(year))", value: $year, in: 2000...2100).disabled(request != nil || reissue != nil)
                if reissue == nil {
                    Button("Load available packs") { Task { do { try await store.loadPacks(country: country, year: year) } catch { self.error = error.localizedDescription } } }
                    Picker("Pack", selection: $pack) {
                        Text("Choose pack").tag("")
                        if !pack.isEmpty, !availablePacks.contains(where: { $0.id == pack }) { Text(pack).tag(pack) }
                        ForEach(availablePacks) { Text($0.title).tag($0.id) }
                    }.disabled(request != nil)
                } else { Notice("This prepares a new draft. The previous issued report stays unchanged.") }
                if let p = availablePacks.first(where: { $0.id == pack }) { Text(p.capability).font(.callout); DisclosureGroup("Source and version") { JSONFields(data: p.data) } }
            }
            if pack == "pt-ppp-surface-journal" {
                Section("Choose literal Portuguese journal rows") {
                    NavigationLink("Open the Portuguese journal row selector") { PortugueseJournalView(initialFarmID: farm, reissue: reissue, request: request) }.disabled(farm.isEmpty || !store.sessionVerified)
                    Notice("Use the journal selector to explicitly check its source revision, actual dates, row order and unknown cells. The generic fact and work selections below do not substitute for that review. No operation or date is inferred.")
                }
            }
            Section("Choose confirmed facts") {
                let facts = store.records("facts").filter { $0.value("farm_id") == farm && $0.state == "confirmed" }
                if facts.isEmpty { Notice("No confirmed facts are available for this farm. Review proposed facts first.", warning: true) }
                ForEach(facts) { item in
                    VStack(alignment: .leading) {
                        Toggle(isOn: membership(item.id, set: $selectedFacts)) {
                            VStack(alignment: .leading) {
                            Text(item.title)
                            Text("\(factSummary(item.data["value"])) · \(item.value("period")) · revision \(item.revision)").font(.caption)
                            }
                        }
                        NavigationLink("Review complete source fact") { DetailView(collection: "facts", id: item.id) }
                    }
                }
            }
            Section("Selected evidence only") {
                ForEach(store.records("documents").filter { $0.value("farm_id") == farm }) { item in Toggle(item.title, isOn: membership(item.id, set: $selectedDocuments)) }
                Text("Only the selected evidence is requested for this draft. Review the service's snapshot before approval.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Explicitly selected application / work entries") {
                if journalPack { Notice("Select each confirmed Czech application to retain in this journal. Same field and date do not merge records. Holder identity is a separately selected confirmed fact.") }
                if reissue != nil, !journalPack {
                    Toggle("Replace this report's retained work selection", isOn: $replaceRetainedOperations)
                    if !replaceRetainedOperations { Notice("The service will preserve the issued report's existing work selection. Turn replacement on only to choose a new explicit selection below.") }
                }
                ForEach(eligibleOperations) { operation in
                    VStack(alignment: .leading) {
                        Toggle(operation.title + " · " + operation.value("date") + " · revision \(operation.revision)", isOn: membership(operation.id, set: $selectedOperations)).disabled(reissue != nil && !journalPack && !replaceRetainedOperations)
                        NavigationLink("Review this application or work source") { DetailView(collection: "operations", id: operation.id) }
                    }
                }
                Text("\(selectedOperations.count) entries selected. No application, quantity, dose or treated total is inferred from a purchase or an unselected entry.").font(.footnote)
            }
            Section("Preparation checks for this selection") {
                if actualRequestID != nil {
                    Button("Check these exact selected records") { runPreflight() }.disabled(working || !store.sessionVerified || farm.isEmpty || pack.isEmpty || contextRequest == nil)
                    if contextRequest == nil { Notice("The existing linked letter has not loaded. Reload this workspace before checking its selected records; the app does not replace or fabricate the letter.", warning: true) }
                    if let preflight {
                        LabeledContent("Preparation state", value: preflight["status"]?.text ?? "Unavailable")
                        ForEach(Array((preflight["issues"]?.array ?? []).enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? "Review the selected source record.", warning: issue.object["severity"]?.text == "error") }
                        Notice(preflight["notice"]?.text ?? "Preparation checks do not establish authority acceptance. The draft still requires exact snapshot review and explicit approval.")
                    }
                } else { Notice("No letter is linked. Check this journal before approving it. Preparing the selected entries creates a service-checked draft; approval remains a separate decision.") }
            }
            Section { Button(journalPack ? "Check selected entries in a journal preview" : reissue == nil ? "Prepare draft" : "Prepare reissue") { create() }.buttonStyle(.borderedProminent).disabled(pack == "pt-ppp-surface-journal" || working || !store.sessionVerified || farm.isEmpty || pack.isEmpty || (journalPack && selectedOperations.isEmpty) || (journalPack && actualRequestID != nil && checkedSelection != preparation)); if working { ProgressView("Preparing snapshot…") }; if let error { Notice(error, warning: true) } }
        }.navigationTitle(reissue == nil ? "Prepare report" : "Reissue report")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } } }
            .onAppear {
                guard !initialized else { return }; initialized = true
                let source = request ?? reissue
                farm = source?.value("farm_id") ?? initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "")
                selectionFarm = farm
                pack = source?.value("pack_id") ?? initialPackID ?? ""
                if let source, case .number(let n)? = source.data["reporting_year"] { year = Int(n) }
                else if let initialYear { year = initialYear }
                if let request { country = request.value("country") }
                else { country = store.record("farms", farm)?.value("country") ?? country }
                selectedOperations = initialOperationIDs
            }
            .onChange(of: farm) { next in if selectionFarm != next { selectedFacts = []; selectedDocuments = []; selectedOperations = []; selectionFarm = next }; country = store.record("farms", farm)?.value("country") ?? country }
            .onChange(of: selectedFacts) { _ in submissionKey = UUID() }
            .onChange(of: selectedDocuments) { _ in submissionKey = UUID() }
            .onChange(of: year) { _ in submissionKey = UUID() }
            .onChange(of: pack) { _ in submissionKey = UUID() }
            .onChange(of: preparation) { _ in submissionKey = UUID(); preflight = nil; checkedSelection = nil }
            .onChange(of: eligibleOperations) { records in selectedOperations.formIntersection(Set(records.map(\.id))); preflight = nil; checkedSelection = nil }
            .onChange(of: sourceRevisions) { _ in preflight = nil; checkedSelection = nil }
    }
    private func membership(_ id: String, set: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { set.wrappedValue.contains(id) }, set: { selected in if selected { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) } })
    }
    private func factSummary(_ value: JSONValue?) -> String {
        guard let value else { return "Unknown" }
        switch value {
        case .object(let cells): return "Retained source row: \(cells.count) columns"
        case .array(let values): return "Retained collection: \(values.count) items"
        case .string(let text): return text.count > 160 ? "Long source text — open the complete fact" : text
        default: return value.text
        }
    }
    private func create() {
        guard pack != "pt-ppp-surface-journal" else { error = "Choose the Portuguese journal's exact source revision and ordered dated rows in its dedicated selector."; return }
        working = true; error = nil
        Task {
            do {
                var body = preparation
                if let reissue {
                    let operations = body["operation_ids"]
                    body = ["expected_revision": .number(Double(reissue.revision)), "snapshot_checksum": .string(reissue.value("checksum")), "fact_ids": body["fact_ids"]!, "selected_document_ids": body["selected_document_ids"]!]
                    if let operations { body["operation_ids"] = operations }
                    try await store.mutate("/reports/\(reissue.id)/reissue", body: body, idempotency: submissionKey.uuidString)
                } else { try await store.mutate("/reports", body: body, idempotency: submissionKey.uuidString) }
                dismiss()
            } catch { self.error = error.localizedDescription }
            working = false
        }
    }
    private func runPreflight() {
        guard let request = contextRequest else { return }
        let body = preparation, revisions = sourceRevisions; working = true; error = nil
        var url = URLComponents(); url.path = "/requests/\(request.id)/checks"
        url.queryItems = [URLQueryItem(name: "selected_fact_ids", value: selectedFacts.sorted().joined(separator: ",")), URLQueryItem(name: "selected_document_ids", value: selectedDocuments.sorted().joined(separator: ",")), URLQueryItem(name: "selected_operation_ids", value: selectedOperations.sorted().joined(separator: ","))]
        Task {
            do {
                let result = try await store.scopedValue(url.string ?? "").object
                guard preparation == body, sourceRevisions == revisions, result["request_id"] == .string(request.id), result["request_revision"] == .number(Double(request.revision)), result["scope"]?.object["farm_id"] == .string(farm), result["scope"]?.object["pack_id"] == .string(pack), result["scope"]?.object["reporting_year"] == .number(Double(year)), case .array(let ids)? = result["selection"]?.object["operation_ids"], Set(ids.map(\.text)) == selectedOperations else { throw ServiceError(status: 409, message: "The service checked a different request revision, scope or application selection. Reload the selected records and check again.") }
                preflight = result; checkedSelection = body
            } catch { preflight = nil; checkedSelection = nil; error = SourceText.error(error) }
            working = false
        }
    }
}
