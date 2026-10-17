import SwiftUI

struct WorkListView: View {
    @EnvironmentObject private var store: AppStore
    var farmID: String? = nil
    @State private var filter = "all"
    private func items(_ collection: String) -> [RecordItem] { store.records(collection).filter { farmID == nil || $0.value("farm_id") == farmID } }
    var body: some View {
        List {
            Section {
                NavigationLink { WorkCaptureView(initialFarmID: farmID) } label: { Label("Record work, a purchase or a sale", systemImage: "square.and.pencil") }
                if store.records("farms").contains(where: { $0.value("country") == "CZ" && (farmID == nil || $0.id == farmID) }) { NavigationLink("Czech application journal — repeated entries") { CzechJournalView(initialFarmID: farmID) } }
                if store.records("farms").contains(where: { $0.value("country") == "PT" && (farmID == nil || $0.id == farmID) }) { NavigationLink("Portuguese surface-treatment journal — literal rows") { PortugueseJournalView(initialFarmID: farmID) } }
                Text("Check quantities, dates and source evidence before saving. New records remain proposals until a separate review.").font(.callout).foregroundStyle(.secondary)
                Picker("Show", selection: $filter) { Text("All records").tag("all"); Text("Work").tag("operations"); Text("Purchases").tag("purchases"); Text("Sales").tag("sales") }.pickerStyle(.menu)
            }
            SyncBanner()
            if filter == "all" || filter == "operations" {
                Section("Work records") {
                    if items("operations").isEmpty { Text("No work records are loaded yet.").foregroundStyle(.secondary) }
                    ForEach(items("operations")) { record in NavigationLink { if CzechJournalData.isEntry(record) { CzechApplicationDetail(initial: record) } else { WorkRecordDetail(collection: "operations", record: record) } } label: { RecordRow(item: record) } }
                }
            }
            if filter == "all" || filter == "purchases" {
                Section("Purchases") {
                    if items("purchases").isEmpty { Text("No purchases are loaded yet.").foregroundStyle(.secondary) }
                    ForEach(items("purchases")) { record in NavigationLink { WorkRecordDetail(collection: "purchases", record: record) } label: { RecordRow(item: record) } }
                }
            }
            if filter == "all" || filter == "sales" {
                Section("Sales") {
                    if items("sales").isEmpty { Text("No sales are loaded yet.").foregroundStyle(.secondary) }
                    ForEach(items("sales")) { record in NavigationLink { WorkRecordDetail(collection: "sales", record: record) } label: { RecordRow(item: record) } }
                    NavigationLink("Record a sale or sales invoice") { WorkCaptureView(initialFarmID: farmID, initialKind: "sales") }
                }
            }
        }.navigationTitle("Record work").refreshable { await store.verifyAndRefresh() }
    }
}

struct WorkRecordDetail: View {
    @EnvironmentObject private var store: AppStore
    let collection: String
    let record: RecordItem
    @State private var note = ""
    @State private var working = false
    @State private var problem: String?
    @State private var decision = "confirmed"
    @State private var confirm = false
    @State private var affectedReports: [RecordItem]?
    @State private var history: JSONValue?
    private var current: RecordItem { store.record(collection, record.id) ?? record }
    var body: some View {
        List {
            Section { Text(current.title).font(.title2.bold()); LabeledContent("Review state", value: current.state.isEmpty ? "Not recorded" : current.state); JSONFields(data: current.data) }
            Section {
                if current.value("temporal_basis").isEmpty || current.value("temporal_basis") == "calendar_date" { NavigationLink("Review and edit this record") { WorkCaptureView(existing: current, initialKind: collection) } }
                else { Notice("This is a summary or static source record. Preserve its time basis when editing it through its source import.") }
                Notice("Edits pass the current date, quantity, unit and duplicate checks. Confirmation is a separate server-recorded review.")
                if current.state == "proposed" {
                    TextField("Review note and source checked", text: $note, axis: .vertical)
                    Button("Confirm checked record") { decision = "confirmed"; confirm = true }.buttonStyle(.borderedProminent).disabled(note.isEmpty || working || !store.sessionVerified)
                    Button("Reject proposal", role: .destructive) { decision = "rejected"; confirm = true }.disabled(note.isEmpty || working || !store.sessionVerified)
                }
                if ["sales", "operations"].contains(collection) {
                    Button("Check reports using this record") {
                        working = true; problem = nil
                        Task {
                            do {
                                let page = try await store.scopedValue("/\(collection)/\(current.id)/reports")
                                guard case .array(let items)? = page.object["items"] else { throw ServiceError(status: 0, message: "Dependent report summaries were not returned.") }
                                affectedReports = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(JSONValue.array(items))).map(ReportTransport.compact)
                            }
                            catch { problem = error.localizedDescription }
                            working = false
                        }
                    }.disabled(working || !store.sessionVerified)
                    if let affectedReports {
                        if affectedReports.isEmpty { Text("The service found no reports linked to this record.").font(.footnote).foregroundStyle(.secondary) }
                        ForEach(affectedReports) { report in NavigationLink { DetailView(collection: "reports", id: report.id) } label: { RecordRow(item: report) } }
                    }
                }
                if collection == "sales" {
                    Button("View recorded sale history") {
                        working = true; problem = nil
                        Task { do { history = try await store.scopedValue("/sales/\(current.id)/history") } catch { problem = error.localizedDescription }; working = false }
                    }.disabled(working || !store.sessionVerified)
                    if let history { DisclosureGroup("Retained sale revisions") { Text(history.text).font(.callout).textSelection(.enabled) } }
                    Notice("A reviewed sale can support an explicitly entered reporting fact. It does not automatically create income, tax or stock totals, and issued report snapshots stay in history.")
                }
                if working { ProgressView("Recording review…") }
                if let problem { Notice(problem, warning: true) }
                RecordMetadata(item: current)
            }
        }.navigationTitle(collection == "sales" ? "Sale" : collection == "purchases" ? "Purchase" : "Work record")
            .task { do { _ = try await store.refreshDetail(collection, record.id) } catch { problem = error.localizedDescription } }
            .confirmationDialog(decision == "confirmed" ? "Confirm this record and its source evidence?" : "Reject this proposal?", isPresented: $confirm, titleVisibility: .visible) {
                Button(decision == "confirmed" ? "Confirm record" : "Reject proposal", role: decision == "rejected" ? .destructive : nil) {
                    working = true
                    Task { do { try await store.mutate("/\(collection)/\(current.id)/review", body: ["expected_revision": .number(Double(current.revision)), "decision": .string(decision), "note": .string(note)]) } catch { problem = error.localizedDescription }; working = false }
                }
            }
    }
}

struct WorkCaptureView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    var existing: RecordItem? = nil
    var deviceDraft: PendingEdit? = nil
    var initialFarmID: String? = nil
    var initialDocumentID: String? = nil
    var initialKind: String? = nil
    @State private var kind = "operations"
    @State private var farm = ""
    @State private var title = ""
    @State private var type = "work"
    @State private var date = Date()
    @State private var dateReviewed = false
    @State private var quantity = ""
    @State private var unit = ""
    @State private var hours = ""
    @State private var parcel = ""
    @State private var parcelID = ""
    @State private var product = ""
    @State private var crop = ""
    @State private var note = ""
    @State private var amount = ""
    @State private var category = ""
    @State private var supplier = ""
    @State private var buyer = ""
    @State private var currency = ""
    @State private var taxAmount = ""
    @State private var taxRate = ""
    @State private var invoiceNumber = ""
    @State private var credit = false
    @State private var pesticideDetails: [String: JSONValue] = [:]
    @State private var documentID = ""
    @State private var fields: [[String: JSONValue]] = []
    @State private var check: CaptureCheck?
    @State private var acknowledged: Set<String> = []
    @State private var checking = false
    @State private var saving = false
    @State private var problem: String?
    @State private var loaded = false
    @State private var restoredLegacyForm = false
    private let types: [(String, String)] = [("work", "Work and time"), ("fertiliser_application", "Fertiliser application"), ("pesticide_application", "Pesticide application"), ("irrigation", "Irrigation"), ("harvest", "Harvest"), ("observation", "Observation"), ("animal_birth", "Animal birth"), ("animal_death", "Animal death"), ("animal_purchase", "Animal movement: purchase"), ("animal_sale", "Animal movement: sale"), ("animal_movement", "Animal movement"), ("animal_treatment", "Animal treatment")]
    private var formKey: String { "work:" + (existing?.id ?? deviceDraft?.id.uuidString ?? ((initialKind ?? "choose") + ":" + (initialDocumentID ?? initialFarmID ?? "new"))) }
    private var legacyFormKey: String { "work:" + (existing?.id ?? deviceDraft?.id.uuidString ?? initialDocumentID ?? initialFarmID ?? "new") }
    private var financial: Bool { kind == "purchases" || kind == "sales" }
    private var formatter: DateFormatter {
        let formatter = DateFormatter(); formatter.calendar = Calendar(identifier: .gregorian); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"; return formatter
    }
    private var data: [String: JSONValue] {
        var value = existing?.data ?? deviceDraft?.payload["data"]?.object ?? [:]
        value["farm_id"] = .string(farm); value["title"] = .string(title); value["date"] = .string(formatter.string(from: date))
        if value["temporal_basis"] == .string("calendar_date") { value["period"] = .string(formatter.string(from: date)) }
        value["note"] = .string(note)
        if kind == "operations" {
            value["type"] = .string(type); value["quantity"] = quantity.isEmpty ? .null : .string(quantity)
            value["unit"] = unit.isEmpty ? .null : .string(unit)
            value["parcel"] = parcel.isEmpty ? .null : .string(parcel)
            value["parcel_id"] = parcelID.isEmpty ? .null : .string(parcelID)
            value.removeValue(forKey: "field_id"); value.removeValue(forKey: "group_id")
            value["product"] = product.isEmpty ? .null : .string(product)
            value["crop"] = crop.isEmpty ? .null : .string(crop)
            if !hours.isEmpty { value["hours"] = .string(hours) } else { value.removeValue(forKey: "hours") }
            for key in PesticideRecordFields.keys { value.removeValue(forKey: key) }
            if type == "pesticide_application" { for (key, detail) in pesticideDetails { value[key] = detail } }
        } else {
            value["amount"] = .string(amount); value["currency"] = .string(currency); value["category"] = .string(category)
            if kind == "sales" { value["buyer"] = buyer.isEmpty ? .null : .string(buyer); value.removeValue(forKey: "supplier") }
            else { value["supplier"] = supplier.isEmpty ? .null : .string(supplier); value.removeValue(forKey: "buyer") }
            value["invoice_number"] = invoiceNumber.isEmpty ? .null : .string(invoiceNumber)
            value["credit"] = .bool(credit)
            value["quantity"] = quantity.isEmpty ? .null : .string(quantity); value["unit"] = unit.isEmpty ? .null : .string(unit)
            value["tax_amount"] = taxAmount.isEmpty ? .null : .string(taxAmount)
            value["tax_rate"] = taxRate.isEmpty ? .null : .string(taxRate)
            value.removeValue(forKey: "type")
        }
        if documentID.isEmpty { value.removeValue(forKey: "document_id") } else { value["document_id"] = .string(documentID) }
        return value
    }
    private var bodyValue: [String: JSONValue] {
        var body: [String: JSONValue] = ["kind": .string(kind), "data": .object(data), "reporting_year": .number(Double(Calendar.current.component(.year, from: date)))]
        if let existing { body["record_id"] = .string(existing.id); body["expected_revision"] = .number(Double(existing.revision)) }
        else if let id = deviceDraft?.payload["record_id"], let revision = deviceDraft?.payload["expected_revision"] { body["record_id"] = id; body["expected_revision"] = revision }
        return body
    }
    private var canQueue: Bool { dateReviewed && (check.map { $0.can_save && Set($0.requires_acknowledgement).isSubset(of: acknowledged) } ?? false) }
    var body: some View {
        Form {
            Section("What did you record?") {
                Picker("Record type", selection: $kind) { Text("Work or observation").tag("operations"); Text("Purchase or purchase credit").tag("purchases"); Text("Sale or sales credit").tag("sales") }.disabled(existing != nil || deviceDraft != nil)
                FarmPicker(selected: Binding(get: { farm }, set: { selected in
                    if selected != farm { farm = selected; parcelID = ""; parcel = "" }
                }))
                TextField("Short description", text: $title)
                DatePicker("Actual recorded date", selection: $date, displayedComponents: .date)
                Toggle("I checked this actual date against the record", isOn: $dateReviewed)
                if kind == "operations" { Picker("Activity", selection: $type) { ForEach(Array(types.enumerated()), id: \.offset) { _, entry in Text(LocalizedStringKey(entry.1)).tag(entry.0) } } }
                if kind == "sales" { Notice("This records money owed or received from a buyer. An animal sale or movement record is separate, and an invoice does not establish product use or stock changes.") }
            }
            if kind == "operations" {
                Section("Place, quantity and time") {
                    TextField("Field or site name as recorded", text: Binding(get: { parcel }, set: { parcel = $0; parcelID = "" }))
                    if !fields.isEmpty {
                        Picker("Link a saved field", selection: Binding(get: { parcelID }, set: { selected in
                            parcelID = selected
                            parcel = fields.first(where: { $0["id"]?.text == selected })?["name"]?.text ?? ""
                        })) {
                            Text("No saved field linked").tag("")
                            ForEach(Array(fields.enumerated()), id: \.offset) { _, field in Text(field["name"]?.text ?? "Unnamed field").tag(field["id"]?.text ?? "") }
                        }
                    }
                    Text(parcelID.isEmpty ? "A typed name is a source label, not a link to a saved boundary." : "This record is linked to the selected saved field. Editing its name here removes that link.").font(.footnote).foregroundStyle(.secondary)
                    TextField("Recorded quantity", text: $quantity).keyboardType(.numbersAndPunctuation)
                    TextField("Recorded unit", text: $unit)
                    if type == "work" { TextField("Hours worked", text: $hours).keyboardType(.decimalPad) }
                    TextField("Product, if applicable", text: $product)
                    TextField("Crop, if applicable", text: $crop)
                    Text("Use the unit from the original record. Unspecified quantities stay unknown until checked; they are not recorded as zero.").font(.footnote).foregroundStyle(.secondary)
                    if type.hasPrefix("animal_") { Notice("This is an animal event record. Record the financial purchase or sale separately using its actual invoice or payment evidence.") }
                }
                if type == "pesticide_application" { PesticideRecordFields(details: $pesticideDetails) }
            } else {
                Section(kind == "sales" ? "Sale details" : "Purchase details") {
                    TextField("Actual total amount from the source", text: $amount).keyboardType(.numbersAndPunctuation)
                    TextField("Currency code from the source", text: $currency).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    Toggle("This is a credit", isOn: $credit)
                    TextField("Category", text: $category)
                    if kind == "sales" { TextField("Buyer", text: $buyer) }
                    else { TextField("Supplier", text: $supplier) }
                    TextField("Invoice number", text: $invoiceNumber)
                    TextField("Quantity, if supplied", text: $quantity).keyboardType(.numbersAndPunctuation)
                    TextField("Unit, if supplied", text: $unit)
                    DisclosureGroup("Tax values supplied by the source") {
                        TextField("Tax amount exactly as supplied", text: $taxAmount).keyboardType(.numbersAndPunctuation)
                        TextField("Tax rate exactly as supplied", text: $taxRate).keyboardType(.numbersAndPunctuation)
                        Text("Leave missing tax fields unknown. No tax calculation, rate conversion, stock total or currency conversion is performed here.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            Section("Evidence and notes") {
                Picker("Source document", selection: $documentID) { Text("No document selected").tag(""); ForEach(store.records("documents").filter { $0.value("farm_id") == farm || $0.value("farm_id").suppliedValue.isEmpty }) { document in Text(document.title).tag(document.id) } }
                TextField("What should the reviewer know?", text: $note, axis: .vertical)
            }
            Section("Check before saving") {
                Button("Check this record") { runCheck() }.disabled(checking || saving || !store.sessionVerified || farm.isEmpty || title.isEmpty || !dateReviewed)
                if checking { ProgressView("Checking the current records…") }
                if let check {
                    ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                    ForEach(check.requires_acknowledgement, id: \.self) { code in
                        let issue = check.issues.first { $0.code == code }
                        Toggle(issue?.message ?? "Acknowledge \(code)", isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } }))
                    }
                    DisclosureGroup("Values that will be saved") { JSONFields(data: check.normalized_data) }
                    if check.can_save { Text("This can be saved as a proposal after the warnings above are reviewed.").font(.footnote).foregroundStyle(.secondary) }
                } else { Text("Changes clear the previous check. The current service checks must be reviewed before upload.").font(.footnote).foregroundStyle(.secondary) }
                Button("Save checked proposal") { save(checked: true) }.buttonStyle(.borderedProminent).disabled(!canQueue || saving)
                Button("Save unfinished draft on this device") { save(checked: false) }.disabled(farm.isEmpty || title.isEmpty || saving)
                Text("Your unfinished form is kept privately on this device as you enter it. Upload requires the checks and review above.").font(.footnote).foregroundStyle(.secondary)
                if saving { ProgressView("Saving your record…") }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle(kind == "sales" ? "Record sale" : kind == "purchases" ? "Record purchase" : "Record work")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(saving) } }
            .onAppear { fill() }
            .onChange(of: date) { _ in dateReviewed = false }
            .onChange(of: kind) { _ in dateReviewed = false }
            .onChange(of: bodyValue) { value in
                check = nil; acknowledged = []
                guard loaded, !saving else { return }
                do { try store.saveForm(formKey, value: value) } catch { problem = "The device could not keep the unfinished form: \(error.localizedDescription)" }
            }
            .task(id: farm) {
                fields = []
                guard !farm.isEmpty, store.sessionVerified else { return }
                let selectedFarm = farm
                do {
                    let loadedFields = try await store.scopedValue("/farms/\(selectedFarm)/fields").object["items"]?.array.map(\.object) ?? []
                    guard !Task.isCancelled, farm == selectedFarm else { return }
                    fields = loadedFields.filter { $0["active"] != .bool(false) && !($0["id"]?.text ?? "").isEmpty }
                }
                catch { /* A typed site name remains a valid manual input; field service errors are not treated as a saved boundary. */ }
            }
    }
    private func fill() {
        guard !loaded else { return }; loaded = true
        let form: [String: JSONValue]?
        do {
            if let current = try store.loadForm(formKey) { form = current }
            else if formKey != legacyFormKey, let legacy = try store.loadForm(legacyFormKey), initialKind == nil || legacy["kind"]?.text == initialKind { form = legacy; restoredLegacyForm = true }
            else { form = nil }
        }
        catch { problem = "The saved unfinished form could not be opened: \(error.localizedDescription)"; return }
        let value = form?["data"]?.object ?? deviceDraft?.payload["data"]?.object ?? existing?.data ?? [:]
        kind = form?["kind"]?.text ?? deviceDraft?.payload["kind"]?.text ?? initialKind ?? (["sales", "sale"].contains(existing?.kind ?? "") ? "sales" : ["purchases", "purchase"].contains(existing?.kind ?? "") ? "purchases" : "operations")
        farm = value["farm_id"]?.text ?? initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "")
        title = value["title"]?.text ?? ""; type = value["type"]?.text ?? "work"
        if let day = value["date"]?.text, let parsed = formatter.date(from: day) { date = parsed }
        func editable(_ key: String) -> String { guard let raw = value[key], raw != .null else { return "" }; if case .number(let number) = raw { return String(number) }; return raw.text }
        quantity = editable("quantity"); unit = editable("unit"); hours = editable("hours"); parcel = editable("parcel"); product = editable("product"); crop = editable("crop"); note = editable("note")
        parcelID = editable("parcel_id"); if parcelID.isEmpty { parcelID = editable("field_id") }; if parcelID.isEmpty { parcelID = editable("group_id") }
        amount = editable("amount"); category = editable("category"); supplier = editable("supplier"); buyer = editable("buyer"); currency = editable("currency"); taxAmount = editable("tax_amount"); taxRate = editable("tax_rate"); invoiceNumber = editable("invoice_number"); documentID = editable("document_id").isEmpty ? initialDocumentID ?? "" : editable("document_id"); credit = value["credit"] == .bool(true)
        pesticideDetails = value.filter { PesticideRecordFields.keys.contains($0.key) && $0.value != .null }
    }
    private func runCheck() {
        checking = true; problem = nil
        let checkedBody = bodyValue
        Task {
            do { let result = try await store.checkCapture(checkedBody); guard checkedBody == bodyValue else { checking = false; return }; check = result; acknowledged = [] }
            catch { problem = error.localizedDescription }
            checking = false
        }
    }
    private func save(checked: Bool) {
        saving = true; problem = nil
        do {
            guard !checked || canQueue else { throw ServiceError(status: 0, message: "Review the actual date, current checks and all required warnings before saving this proposal.") }
            let id = try store.saveCaptureDraft(body: bodyValue, review: checked ? check : nil, acknowledged: acknowledged, replacing: deviceDraft?.id)
            try? store.clearForm(formKey)
            if restoredLegacyForm { try? store.clearForm(legacyFormKey) }
            if checked {
                Task { await store.sync(onlyID: id); saving = false; dismiss() }
            } else { saving = false; dismiss() }
        } catch { problem = error.localizedDescription; saving = false }
    }
}
