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
    @State private var farm = ""
    @State private var country = "DE"
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var pack = ""
    @State private var selectedFacts: Set<String> = []
    @State private var selectedDocuments: Set<String> = []
    @State private var submissionKey = UUID()
    @State private var working = false
    @State private var error: String?
    private var availablePacks: [Pack] { store.packs(country: country, year: year) }
    var body: some View {
        Form {
            Section("Prepare a reviewed draft") {
                FarmPicker(selected: $farm)
                TextField("Country code", text: $country).textInputAutocapitalization(.characters)
                Stepper("Reporting year \(String(year))", value: $year, in: 2000...2100)
                if reissue == nil {
                    Button("Load available packs") { Task { do { try await store.loadPacks(country: country, year: year) } catch { self.error = error.localizedDescription } } }
                    Picker("Pack", selection: $pack) {
                        Text("Choose pack").tag("")
                        if !pack.isEmpty, !availablePacks.contains(where: { $0.id == pack }) { Text(pack).tag(pack) }
                        ForEach(availablePacks) { Text($0.title).tag($0.id) }
                    }
                } else { Notice("This prepares a new draft. The previous issued report stays unchanged.") }
                if let p = availablePacks.first(where: { $0.id == pack }) { Text(p.capability).font(.callout); DisclosureGroup("Source and version") { JSONFields(data: p.data) } }
            }
            Section("Choose confirmed facts") {
                let facts = store.records("facts").filter { $0.value("farm_id") == farm && $0.state == "confirmed" }
                if facts.isEmpty { Notice("No confirmed facts are available for this farm. Review proposed facts first.", warning: true) }
                ForEach(facts) { item in Toggle(isOn: membership(item.id, set: $selectedFacts)) { VStack(alignment: .leading) { Text(item.title); Text("\(item.data["value"]?.text ?? "Unknown") · \(item.value("period")) · revision \(item.revision)").font(.caption) } } }
            }
            Section("Selected evidence only") {
                ForEach(store.records("documents").filter { $0.value("farm_id") == farm }) { item in Toggle(item.title, isOn: membership(item.id, set: $selectedDocuments)) }
                Text("Only the selected evidence is requested for this draft. Review the service's snapshot before approval.").font(.footnote).foregroundStyle(.secondary)
            }
            Section { Button(reissue == nil ? "Prepare draft" : "Prepare reissue") { create() }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || farm.isEmpty || pack.isEmpty); if working { ProgressView("Preparing snapshot…") }; if let error { Notice(error, warning: true) } }
        }.navigationTitle(reissue == nil ? "Prepare report" : "Reissue report")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } } }
            .onAppear {
                let source = request ?? reissue
                farm = source?.value("farm_id") ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "")
                pack = source?.value("pack_id") ?? ""
                if let source, case .number(let n)? = source.data["reporting_year"] { year = Int(n) }
                if let request { country = request.value("country") }
            }
            .onChange(of: farm) { _ in selectedFacts = []; selectedDocuments = [] }
            .onChange(of: selectedFacts) { _ in submissionKey = UUID() }
            .onChange(of: selectedDocuments) { _ in submissionKey = UUID() }
            .onChange(of: year) { _ in submissionKey = UUID() }
            .onChange(of: pack) { _ in submissionKey = UUID() }
    }
    private func membership(_ id: String, set: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { set.wrappedValue.contains(id) }, set: { selected in if selected { set.wrappedValue.insert(id) } else { set.wrappedValue.remove(id) } })
    }
    private func create() {
        working = true; error = nil
        Task {
            do {
                var body: [String: JSONValue] = ["farm_id": .string(farm), "pack_id": .string(pack), "reporting_year": .number(Double(year)), "fact_ids": .array(selectedFacts.sorted().map(JSONValue.string)), "selected_document_ids": .array(selectedDocuments.sorted().map(JSONValue.string))]
                if let request { body["request_id"] = .string(request.id) }
                if let reissue {
                    body = ["expected_revision": .number(Double(reissue.revision)), "fact_ids": body["fact_ids"]!, "selected_document_ids": body["selected_document_ids"]!]
                    try await store.mutate("/reports/\(reissue.id)/reissue", body: body, idempotency: submissionKey.uuidString)
                } else { try await store.mutate("/reports", body: body, idempotency: submissionKey.uuidString) }
                dismiss()
            } catch { self.error = error.localizedDescription }
            working = false
        }
    }
}
