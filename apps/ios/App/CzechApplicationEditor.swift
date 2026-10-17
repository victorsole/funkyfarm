import SwiftUI

struct CzechApplicationEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let farmID: String
    var existing: RecordItem? = nil
    var correction: RecordItem? = nil
    var deviceDraft: PendingEdit? = nil
    @State private var values: [String: JSONValue] = [:]
    @State private var details: [String: JSONValue] = [:]
    @State private var originals: [String: JSONValue] = [:]
    @State private var decimal = ""
    @State private var note = ""
    @State private var loaded = false
    @State private var dateChecked = false
    @State private var exemptionsChecked = false
    @State private var check: CaptureCheck?
    @State private var acknowledged: Set<String> = []
    @State private var busy = false
    @State private var problem: String?
    @State private var boundRevision: Int?
    @State private var boundState: String?
    private var formKey: String { "cz-journal:application:" + (deviceDraft?.id.uuidString ?? existing?.id ?? correction.map { $0.id + ":correction" } ?? farmID + ":new") }
    private var location: String { CzechJournalData.text(details["location_kind"]) }
    private var subject: String { CzechJournalData.text(details["subject_kind"]) }
    private var treeExemption: Bool { ["tree", "forest"].contains(subject) }
    private var data: [String: JSONValue] {
        var result = values.filter { CzechJournalData.operationKeys.contains($0.key) }
        result["farm_id"] = .string(farmID); result["type"] = .string("pesticide_application"); result["review_status"] = .string("proposed")
        result["note"] = .string(note); result["temporal_basis"] = .string("calendar_date"); result["period"] = result["date"]
        var cz = details
        for key in ["dose", "treated_size", "quantity"] {
            let raw = CzechJournalData.text(originals[key])
            result[key] = raw.isEmpty ? .null : .string(CzechJournalData.canonical(raw, decimal: decimal))
        }
        let area = CzechJournalData.text(originals["sown_area_ha"])
        if !area.isEmpty { let canonical = CzechJournalData.canonical(area, decimal: decimal); if let number = Double(canonical), number.isFinite { cz["sown_area_ha"] = .number(number) } else { cz["sown_area_ha"] = .string(canonical) } }
        else { cz.removeValue(forKey: "sown_area_ha") }
        cz["original_numbers"] = .object(originals.filter { !CzechJournalData.text($0.value).isEmpty })
        result["cz_ppp"] = .object(cz)
        var sources = values["sources"]?.array ?? []
        let manual: JSONValue = .object(["kind": .string("manual"), "note": .string(note)])
        if !note.isEmpty, !sources.contains(manual) { sources.append(manual) }
        if let correction { result["supersedes_id"] = .string(correction.id); let source: JSONValue = .object(["kind": .string("correction"), "record_kind": .string("operations"), "record_id": .string(correction.id), "revision": .number(Double(boundRevision ?? correction.revision)), "note": .string(note)]); if !sources.contains(source) { sources.append(source) } }
        result["sources"] = .array(sources)
        return result
    }
    private var request: [String: JSONValue] {
        var body: [String: JSONValue] = ["kind": .string("operations"), "data": .object(data)]
        if let year = Int(String(CzechJournalData.text(values["date"]).prefix(4))) { body["reporting_year"] = .number(Double(year)) }
        if let existing { body["record_id"] = .string(existing.id); body["expected_revision"] = .number(Double(boundRevision ?? existing.revision)) }
        else if let id = deviceDraft?.payload["record_id"], let revision = deviceDraft?.payload["expected_revision"] { body["record_id"] = id; body["expected_revision"] = revision }
        return body
    }
    private var readyToCheck: Bool { [".", ","].contains(decimal) && dateChecked && (!treeExemption || exemptionsChecked) && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !CzechJournalData.text(values["title"]).isEmpty }
    private var canSave: Bool { readyToCheck && check?.can_save == true && Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged) }
    private func text(_ key: String) -> Binding<String> { Binding(get: { CzechJournalData.text(values[key]) }, set: { values[key] = $0.isEmpty ? nil : .string($0) }) }
    private func cz(_ path: [String]) -> Binding<String> { Binding(get: { CzechJournalData.text(CzechJournalData.get(details, path)) }, set: { CzechJournalData.put(&details, path, $0.isEmpty ? nil : .string($0)) }) }
    private func raw(_ key: String) -> Binding<String> { Binding(get: { CzechJournalData.text(originals[key]) }, set: { originals[key] = $0.isEmpty ? nil : .string($0) }) }
    var body: some View {
        Form {
            Section("One actual application") {
                Notice("Each application has its own record identity, even when another application used the same field and date. Do not reconstruct use from an invoice.")
                if let correction { Notice("This is a new proposed correction of application " + correction.id + ", revision \(correction.revision). The confirmed original stays active until this successor is separately confirmed.", warning: true) }
                TextField("Application description", text: text("title"))
                TextField("Actual application date (YYYY-MM-DD)", text: text("date")).autocorrectionDisabled().textInputAutocapitalization(.never)
                Toggle("I checked the actual application date", isOn: $dateChecked)
                TextField("Product as recorded", text: text("product"))
                TextField("Crop or treated subject as recorded", text: text("crop"))
                TextField("Private field or site label (optional)", text: text("parcel"))
            }
            locationSection
            numberSection
            cropSection
            PesticideRecordFields(details: $values, excludedKeys: ["dose", "dose_unit", "treated_size", "treated_unit"])
            Section("Source and review") {
                Picker("Supporting original document", selection: text("document_id")) {
                    Text("No document linked").tag("")
                    ForEach(store.records("documents").filter { $0.value("farm_id") == farmID || $0.value("farm_id").suppliedValue.isEmpty }) { document in Text(document.title).tag(document.id) }
                }
                TextField("Source checked and what needs follow-up", text: $note, axis: .vertical)
                Button("Check this application") { runCheck() }.disabled(busy || !readyToCheck || !store.sessionVerified)
                if let check {
                    ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                    ForEach(check.requires_acknowledgement, id: \.self) { code in Toggle(check.issues.first { $0.code == code }?.message ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                    DisclosureGroup("Compare the normalized proposal before sending") { CzechStructuredValues(data: check.normalized_data) }
                }
                Button("Save checked application proposal") { save(checked: true) }.buttonStyle(.borderedProminent).disabled(busy || !canSave)
                Button("Keep unfinished application on this device") { save(checked: false) }.disabled(busy || CzechJournalData.text(values["title"]).isEmpty)
                Notice("A proposal still needs a separate human confirmation. Pending efficacy and crop-end observations are follow-up work, not completed annual obligations.")
                if busy { ProgressView("Checking or saving application…") }
                if let problem { Notice(problem, warning: true) }
            }
        }.autocorrectionDisabled().textInputAutocapitalization(.never)
            .navigationTitle(correction == nil ? "Czech application" : "Propose correction")
            .disabled(busy)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            .onAppear { fill() }
            .onChange(of: values["date"]) { _ in dateChecked = false }
            .onChange(of: subject) { _ in exemptionsChecked = false }
            .onChange(of: request) { _ in changed() }
            .onChange(of: decimal) { _ in changed() }
            .onChange(of: details["crop_end"]?.object["status"]) { status in if status != .string("recorded") { CzechJournalData.put(&details, ["crop_end", "date"], nil) } }
            .onChange(of: details["efficacy"]?.object["status"]) { status in if status != .string("recorded") { CzechJournalData.put(&details, ["efficacy", "value"], nil) } }
    }
    private var locationSection: some View {
        Section("Exact location references") {
            Picker("Recorded location type", selection: cz(["location_kind"])) { Text("Not established").tag(""); Text("LPIS land").tag("lpis_land"); Text("Other land").tag("other_land"); Text("Forest").tag("forest"); Text("Object / facility").tag("object") }
            TextField("Cadastral area exactly as recorded", text: cz(["cadastral_area"]))
            if location == "lpis_land" { TextField("LPIS square", text: cz(["dpb_square"])); TextField("DPB code", text: cz(["dpb_code"])) }
            if location == "other_land" || location == "object" {
                TextField("Cadastral parcel identifiers — one per line", text: Binding(get: { (details["cadastral_parcel_numbers"]?.array ?? []).map(\.text).joined(separator: "\n") }, set: { details["cadastral_parcel_numbers"] = .array($0.components(separatedBy: "\n").filter { !$0.isEmpty }.map(JSONValue.string)) }), axis: .vertical)
            }
            if location == "forest" {
                TextField("LHC code", text: cz(["lhc_code"]))
                ForEach(["oddeleni", "dilec", "porost", "porostni_skupina"], id: \.self) { key in TextField(CzechJournalData.label(key), text: cz(["jprl", key])) }
            }
            if location == "object" { TextField("Object type", text: cz(["object_type"])); TextField("Object description", text: cz(["object_description"]), axis: .vertical) }
            DisclosureGroup("Review or clear references from a different location type") {
                Notice("Changing location type does not erase your identifiers. Clear an inapplicable reference explicitly rather than reinterpreting it.")
                if location != "lpis_land" { TextField("Previously entered LPIS square", text: cz(["dpb_square"])); TextField("Previously entered DPB code", text: cz(["dpb_code"])) }
                if !["other_land", "object"].contains(location) { TextField("Previously entered parcel identifiers — one per line", text: Binding(get: { (details["cadastral_parcel_numbers"]?.array ?? []).map(\.text).joined(separator: "\n") }, set: { details["cadastral_parcel_numbers"] = .array($0.components(separatedBy: "\n").filter { !$0.isEmpty }.map(JSONValue.string)) }), axis: .vertical) }
                if location != "forest" { TextField("Previously entered LHC code", text: cz(["lhc_code"])); ForEach(["oddeleni", "dilec", "porost", "porostni_skupina"], id: \.self) { key in TextField("Previously entered " + CzechJournalData.label(key), text: cz(["jprl", key])) } }
                if location != "object" { TextField("Previously entered object type", text: cz(["object_type"])); TextField("Previously entered object description", text: cz(["object_description"])) }
            }
            Text("Copy the actual official identifiers. A saved boundary or a private field name does not establish an LPIS, parcel or forest reference.").font(.footnote)
        }
    }
    private var numberSection: some View {
        Section("Numbers exactly from the application record") {
            Picker("Decimal mark in this source", selection: $decimal) { Text("Choose from the source").tag(""); Text("Point (.)").tag("."); Text("Comma (,)").tag(",") }
            TextField("Original dose text — up to 3 decimal places", text: raw("dose")).keyboardType(.numbersAndPunctuation)
            TextField("Dose unit from the source", text: text("dose_unit"))
            TextField("Original treated extent text — up to 2 decimal places", text: raw("treated_size")).keyboardType(.numbersAndPunctuation)
            TextField("Treated extent unit from the source", text: text("treated_unit"))
            TextField("Original total quantity text, only if supplied", text: raw("quantity")).keyboardType(.numbersAndPunctuation)
            TextField("Total quantity unit, only if supplied", text: text("unit"))
            Notice("Original numeric text is retained separately. Decimal notation is made explicit for checking; no dose × area total, unit conversion or silent rounding is performed.")
        }
    }
    private var cropSection: some View {
        Section("Crop and later observations") {
            Picker("Subject recorded", selection: cz(["subject_kind"])) { Text("Not established").tag(""); Text("Crop").tag("crop"); Text("Trees").tag("tree"); Text("Forest").tag("forest"); Text("Other").tag("other") }
            if location != "object" { TextField("Original sown area (ha) text — up to 2 decimals", text: raw("sown_area_ha")).keyboardType(.numbersAndPunctuation) }
            if treeExemption { Toggle("I checked the tree / forest crop-date exemption against the source", isOn: $exemptionsChecked); Notice("Leave exempt dates absent. Explicitly choose not applicable for crop end; the app does not invent crop dates.") }
            TextField("Actual sowing date if applicable (YYYY-MM-DD)", text: cz(["sowing_date"]))
            Picker("Crop-end observation", selection: cz(["crop_end", "status"])) { Text("Not established").tag(""); Text("Pending observation").tag("pending"); Text("Recorded actual date").tag("recorded"); Text("Explicitly not applicable").tag("not_applicable") }
            if CzechJournalData.get(details, ["crop_end", "status"]) == .string("recorded") { TextField("Actual crop-end date (YYYY-MM-DD)", text: cz(["crop_end", "date"])) }
            TextField("Target organism or purpose", text: cz(["target_organism_or_purpose"]))
            Picker("Mixture as recorded", selection: cz(["mixture"])) { Text("Not established").tag(""); Text("S").tag("S"); Text("TM").tag("TM") }
            Picker("Efficacy observation", selection: cz(["efficacy", "status"])) { Text("Not established").tag(""); Text("Pending observation").tag("pending"); Text("Recorded value").tag("recorded") }
            if CzechJournalData.get(details, ["efficacy", "status"]) == .string("recorded") {
                Picker("Actual efficacy value", selection: Binding(get: { details["efficacy"]?.object["value"] ?? .null }, set: { CzechJournalData.put(&details, ["efficacy", "value"], $0 == .null ? nil : $0) })) { Text("Not supplied").tag(JSONValue.null); Text("0 — observed ineffective").tag(JSONValue.number(0)); Text("1 — observed effective").tag(JSONValue.number(1)) }
            }
        }
    }
    private func fill() {
        guard !loaded else { return }; loaded = true
        do {
            let form = try store.loadForm(formKey)
            let body = form?["request"]?.object ?? deviceDraft?.payload ?? [:]
            let source = body["data"]?.object ?? (existing ?? correction)?.data ?? [:]
            boundRevision = SourceText.year(body["expected_revision"]).flatMap { Int($0) } ?? (existing ?? correction)?.revision
            boundState = (existing ?? correction)?.state
            values = source.filter { CzechJournalData.operationKeys.contains($0.key) && $0.key != "cz_ppp" }
            details = source["cz_ppp"]?.object ?? [:]; originals = details.removeValue(forKey: "original_numbers")?.object ?? [:]
            decimal = form?["decimal_separator"]?.text ?? deviceDraft?.reviewContext?["decimal_separator"]?.text ?? ""
            note = CzechJournalData.text(source["note"])
        } catch { problem = SourceText.error(error) }
    }
    private func changed() {
        check = nil; acknowledged = []
        guard loaded, !busy else { return }
        do { try store.saveForm(formKey, value: ["request": .object(request), "decimal_separator": .string(decimal)]) }
        catch { problem = "The private unfinished application could not be saved: " + SourceText.error(error) }
    }
    private func runCheck() {
        let body = request; busy = true; problem = nil
        Task {
            do {
                let mark = decimal == "," ? "," : "\\."
                let pattern = "^[+-]?(?:[0-9]+(?:" + mark + "[0-9]+)?|" + mark + "[0-9]+)$"
                for (key, value) in originals where !CzechJournalData.text(value).isEmpty {
                    guard CzechJournalData.text(value).trimmingCharacters(in: .whitespacesAndNewlines).range(of: pattern, options: .regularExpression) != nil else { throw ServiceError(status: 422, message: "Check the original " + CzechJournalData.label(key).lowercased() + " text and selected decimal mark. Group separators, exponent notation and mixed decimal marks are not interpreted or silently converted.") }
                }
                if let source = existing ?? correction { let current = try await store.refreshDetail("operations", source.id); guard current.revision == boundRevision, current.state == boundState, CzechJournalData.isActive(current) else { throw ServiceError(status: 409, message: "The application source revision or active successor changed. Keep this draft and reopen the current entry before checking it.") } }
                else if let id = data["supersedes_id"]?.text { let predecessor = try await store.refreshDetail("operations", id); guard predecessor.state == "confirmed", predecessor.value("farm_id") == farmID, CzechJournalData.isActive(predecessor) else { throw ServiceError(status: 409, message: "This saved correction's predecessor is no longer the active confirmed application. Open its current successor instead of silently replacing the correction link.") } }
                let result = try await store.checkCapture(body); if request == body { check = result; acknowledged = [] }
            } catch { check = nil; problem = SourceText.error(error) }
            busy = false
        }
    }
    private func save(checked: Bool) {
        do {
            guard !checked || canSave else { return }
            let id = try store.saveCaptureDraft(body: request, review: checked ? check : nil, acknowledged: acknowledged, replacing: deviceDraft?.id, reviewContext: ["type": .string("cz_journal_application"), "decimal_separator": .string(decimal)])
            try? store.clearForm(formKey)
            if checked { busy = true; Task { await store.sync(onlyID: id); busy = false; dismiss() } }
            else { dismiss() }
        } catch { problem = SourceText.error(error) }
    }
}
