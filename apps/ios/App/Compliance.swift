import SwiftUI

struct FarmComplianceView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    @State private var farmID = ""
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var evaluation: [String: JSONValue] = [:]
    @State private var selectedRules: Set<String> = []
    @State private var working = false
    @State private var problem: String?
    @State private var result: [String: JSONValue]?
    @State private var actionKey = UUID()
    private var version: String { evaluation["rules_version"]?.text ?? "" }
    private var farmRevision: Int { if case .number(let n)? = evaluation["farm_revision"] { return Int(n) }; return 0 }
    var body: some View {
        List {
            Section("What needs attention?") {
                FarmPicker(selected: $farmID).disabled(working)
                Stepper("Reporting year \(String(year))", value: $year, in: 2000...2100).disabled(working)
                Notice("These checks organize the evidence and actions relevant to the recorded farm profile. Readiness for review is not legal compliance or an authority decision.")
            }
            if !evaluation.isEmpty {
                Section("Farm details still needed") {
                    let questions = evaluation["profile_questions"]?.array ?? []
                    if questions.isEmpty { Text("No additional farm-profile questions are listed by the current check.").foregroundStyle(.secondary) }
                    ForEach(Array(questions.enumerated()), id: \.offset) { _, question in NavigationLink { ComplianceProfileQuestionView(farmID: farmID, question: question.object, ruleVersion: version) } label: { VStack(alignment: .leading, spacing: 5) { Text(question.object["prompt"]?.text ?? question.object["label"]?.text ?? "Review farm detail").font(.headline); Text("Save a proposed answer, then confirm its source separately.").font(.caption).foregroundStyle(.secondary) } } }
                }
                Section("Review the relevant obligations") {
                    let obligations = evaluation["obligations"]?.array ?? []
                    if obligations.isEmpty { Text("The service returned no obligation checks for this selection.").foregroundStyle(.secondary) }
                    ForEach(Array(obligations.enumerated()), id: \.offset) { _, value in
                        let obligation = value.object
                        VStack(alignment: .leading, spacing: 7) {
                            NavigationLink { ComplianceObligationView(obligation: obligation, version: version) } label: { VStack(alignment: .leading, spacing: 4) { Text(obligation["title"]?.text ?? "Obligation").font(.headline); Text(applicability(obligation["applicability"]?.text ?? "unknown")).font(.caption); Text(obligation["status"]?.text.replacingOccurrences(of: "_", with: " ").capitalized ?? "").font(.caption).foregroundStyle(.secondary) } }
                            if let id = obligation["id"]?.text {
                                Toggle("Create review tasks for this item", isOn: Binding(get: { selectedRules.contains(id) }, set: { if $0 { selectedRules.insert(id) } else { selectedRules.remove(id) }; actionKey = UUID() })).disabled(obligation["applicability"] == .string("does_not_apply") || working)
                            }
                        }.padding(.vertical, 4)
                    }
                }
                Section("Your next actions") {
                    Button("Create open checklists and tasks") { createTasks() }.buttonStyle(.borderedProminent).disabled(working || selectedRules.isEmpty || farmRevision <= 0 || !store.sessionVerified)
                    Notice("New tasks and checklist items start open. Completing a task is an explicit record of your work; it does not approve an obligation or change a reviewed fact.")
                    NavigationLink("View farm tasks and checklists") { FarmTaskListView(initialFarmID: farmID) }
                    if let result {
                        let tasks = result["tasks"]?.array.count ?? 0, checklists = result["checklists"]?.array.count ?? 0
                        Text("The service returned \(checklists) checklists and \(tasks) tasks.")
                        if let skipped = result["skipped"], !skipped.array.isEmpty { Text(skipped.text).font(.callout) }
                    }
                }
                Section("Source and unresolved issues") {
                    ForEach(Array((evaluation["issues"]?.array ?? []).enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? issue.text, warning: true) }
                    if let limits = evaluation["limits"] { Text(limits.text).font(.footnote) }
                    DisclosureGroup("Rule version and evidence progress") { JSONFields(data: evaluation.filter { ["rules_version", "rules_updated_at", "rules_hash", "farm_revision", "progress", "overall", "deadlines"].contains($0.key) }) }
                }
            }
            if working { Section { ProgressView("Checking current evidence…") } }
            if let problem { Section { Notice(problem, warning: true); Button("Reload current checks") { Task { await load() } }.disabled(working) } }
        }.navigationTitle("Farm obligations")
            .onAppear { if farmID.isEmpty { farmID = initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "") } }
            .task(id: farmID + ":" + String(year)) { await load() }
            .refreshable { await load() }
    }
    private func applicability(_ value: String) -> String {
        switch value { case "applies": return "Relevant to the recorded profile"; case "does_not_apply": return "Recorded profile indicates this does not apply"; case "conflict": return "Farm-profile evidence disagrees"; default: return "More farm information is needed" }
    }
    private func load() async {
        evaluation = [:]; selectedRules = []; result = nil; problem = nil; actionKey = UUID()
        guard !farmID.isEmpty else { return }
        let selectedFarm = farmID, selectedYear = year
        working = true; defer { working = false }
        do { let value = try await store.scopedValue("/compliance/farms/\(selectedFarm)?year=\(selectedYear)").object; guard farmID == selectedFarm, year == selectedYear else { return }; evaluation = value }
        catch { problem = error.localizedDescription }
    }
    private func createTasks() {
        guard farmRevision > 0, !selectedRules.isEmpty else { return }
        working = true; problem = nil
        Task {
            do { result = try await store.scopedValue("/compliance/farms/\(farmID)/checklist", method: "POST", body: ["rule_ids": .array(selectedRules.sorted().map(JSONValue.string)), "expected_farm_revision": .number(Double(farmRevision)), "year": .number(Double(year))], idempotency: actionKey.uuidString).object; await store.refresh() }
            catch { problem = error.localizedDescription }
            working = false
        }
    }
}

struct ComplianceObligationView: View {
    let obligation: [String: JSONValue]
    let version: String
    var body: some View {
        List {
            Section { Text(obligation["title"]?.text ?? "Obligation").font(.title2.bold()); LabeledContent("Review status", value: obligation["status"]?.text.replacingOccurrences(of: "_", with: " ") ?? "Unknown"); if let deadline = obligation["deadline"] { JSONFields(data: deadline.object) }; Notice("An unknown date stays unknown. A recorded deadline and evidence readiness do not establish legal compliance.") }
            Section("Evidence and missing steps") {
                ForEach(Array((obligation["requirements"]?.array ?? []).enumerated()), id: \.offset) { _, requirement in
                    DisclosureGroup(requirement.object["label"]?.text ?? "Requirement") {
                        if let state = requirement.object["status"] { Text(state.text.replacingOccurrences(of: "_", with: " ").capitalized) }
                        if let issues = requirement.object["issues"] { Text(issues.text).font(.callout) }
                        if let evidence = requirement.object["evidence"] { DisclosureGroup("Recorded evidence") { Text(evidence.text).font(.caption).textSelection(.enabled) } }
                        ForEach(Array((requirement.object["steps"]?.array ?? []).enumerated()), id: \.offset) { _, step in WorkflowActionLink(action: step.object) }
                    }
                }
            }
            Section("Next steps") { ForEach(Array((obligation["steps"]?.array ?? []).enumerated()), id: \.offset) { _, step in WorkflowActionLink(action: step.object) } }
            Section("Sources and limits") { if let citations = obligation["citations"] { SourceReferences(value: citations) }; if let limits = obligation["limits"] { Text(limits.text).font(.footnote) }; LabeledContent("Rule version", value: version) }
        }.navigationTitle("Review obligation")
    }
}

struct ComplianceProfileQuestionView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let farmID: String
    let question: [String: JSONValue]
    let ruleVersion: String
    var deviceDraft: PendingEdit? = nil
    @State private var choice = JSONValue.null
    @State private var choices: Set<JSONValue> = []
    @State private var text = ""
    @State private var note = ""
    @State private var documentID = ""
    @State private var check: CaptureCheck?
    @State private var acknowledged: Set<String> = []
    @State private var working = false
    @State private var loaded = false
    @State private var problem: String?
    private var key: String { question["fact_key"]?.text ?? question["key"]?.text ?? "" }
    private var period: String { question["period"]?.text ?? "" }
    private var formKey: String { "compliance-profile:" + farmID + ":" + period + ":" + key }
    private var multiple: Bool { question["multiple"] == .bool(true) && question["value_type"] == .string("choice") }
    private var value: JSONValue {
        if multiple { return .array((question["choices"]?.array ?? []).compactMap { $0.object["value"] }.filter { choices.contains($0) }) }
        return ["boolean", "choice"].contains(question["value_type"]?.text ?? "") ? choice : .string(text)
    }
    private var bodyValue: [String: JSONValue] {
        var sources: [JSONValue] = [.object(["kind": .string("manual"), "note": .string(note)])]
        if let document = store.record("documents", documentID) { sources.append(.object(["document_id": .string(document.id), "revision": .number(Double(document.revision))])) }
        let data: [String: JSONValue] = ["farm_id": .string(farmID), "key": .string(key), "label": question["label"] ?? .string(key), "value": value, "temporal_basis": question["temporal_basis"] ?? .string("campaign_year"), "period": question["period"] ?? .null, "sources": .array(sources), "review_status": .string("proposed")]
        var body: [String: JSONValue] = ["kind": .string("facts"), "data": .object(data)]
        if let year = Int(period) { body["reporting_year"] = .number(Double(year)) }
        return body
    }
    var body: some View {
        Form {
            Section {
                Text(question["prompt"]?.text ?? question["label"]?.text ?? key).font(.title3.bold())
                LabeledContent("Reporting period", value: period)
                if question["value_type"] == .string("boolean") { Picker("Your answer", selection: $choice) { Text("Not established").tag(JSONValue.null); Text("Yes").tag(JSONValue.bool(true)); Text("No").tag(JSONValue.bool(false)) } }
                else if multiple { ForEach(Array((question["choices"]?.array ?? []).enumerated()), id: \.offset) { _, option in let value = option.object["value"] ?? .null; Toggle(option.object["label"]?.text ?? value.text, isOn: Binding(get: { choices.contains(value) }, set: { if $0 { choices.insert(value) } else { choices.remove(value) } })) }; Text("Select only the types you checked. Unselected types are not recorded as false.").font(.footnote).foregroundStyle(.secondary) }
                else if question["value_type"] == .string("choice") { Picker("Your answer", selection: $choice) { Text("Not established").tag(JSONValue.null); ForEach(Array((question["choices"]?.array ?? []).enumerated()), id: \.offset) { _, option in Text(option.object["label"]?.text ?? option.object["value"]?.text ?? "").tag(option.object["value"] ?? .null) } } }
                else { TextField("Your recorded answer", text: $text, axis: .vertical) }
                TextField("Where did you check this answer?", text: $note, axis: .vertical)
                Picker("Supporting document", selection: $documentID) { Text("No document selected").tag(""); ForEach(store.records("documents").filter { $0.value("farm_id") == farmID || $0.value("farm_id").suppliedValue.isEmpty }) { document in Text(document.title).tag(document.id) } }
                Notice("This records an annual proposed answer for the selected reporting period. Confirmation and a fresh obligation check are separate actions.")
            }
            Section("Existing evidence to compare") {
                ForEach((question["conflicting_fact_ids"]?.array ?? []).map(\.text), id: \.self) { id in NavigationLink("Compare conflicting reviewed fact") { DetailView(collection: "facts", id: id) } }
                ForEach((question["proposal_ids"]?.array ?? []).map(\.text), id: \.self) { id in NavigationLink("Review an existing proposal") { DetailView(collection: "facts", id: id) } }
            }
            Section("Review before saving") {
                Button("Check this answer") { preview() }.disabled(working || !store.sessionVerified || key.isEmpty || period.isEmpty || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let check {
                    ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                    ForEach(check.requires_acknowledgement, id: \.self) { code in Toggle(check.issues.first { $0.code == code }?.message ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                    DisclosureGroup("Proposed values and source") { JSONFields(data: check.normalized_data) }
                }
                Button("Save checked proposal") { save(checked: true) }.buttonStyle(.borderedProminent).disabled(working || check?.can_save != true || !Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged))
                Button("Keep unfinished device draft") { save(checked: false) }.disabled(working || key.isEmpty)
                if working { ProgressView("Checking current records…") }
                if let problem { Notice(problem, warning: true) }
            }
            Section("Question sources") { if let sources = question["sources"] { SourceReferences(value: sources) }; LabeledContent("Rule version", value: ruleVersion) }
        }.navigationTitle("Farm profile answer")
            .onAppear { fill() }
            .onChange(of: bodyValue) { value in check = nil; acknowledged = []; guard loaded else { return }; do { try store.saveForm(formKey, value: value) } catch { problem = error.localizedDescription } }
    }
    private func fill() {
        guard !loaded else { return }; loaded = true
        do {
            let saved = try store.loadForm(formKey) ?? deviceDraft?.payload
            let data = saved?["data"]?.object ?? [:]
            choice = data["value"] ?? .null; text = data["value"]?.text.suppliedValue ?? ""
            if let saved = data["value"] { choices = Set(saved.array.isEmpty && saved != .null ? [saved] : saved.array) }
            note = data["sources"]?.array.compactMap { $0.object["note"]?.text }.first ?? ""
            documentID = data["sources"]?.array.compactMap { $0.object["document_id"]?.text }.first ?? ""
        } catch { problem = error.localizedDescription }
    }
    private func preview() {
        let original = bodyValue; working = true; problem = nil
        Task { do { let value = try await store.checkCapture(original); if bodyValue == original { check = value; acknowledged = [] } } catch { problem = error.localizedDescription }; working = false }
    }
    private func save(checked: Bool) {
        do {
            let id = try store.saveCaptureDraft(body: bodyValue, review: checked ? check : nil, acknowledged: acknowledged, replacing: deviceDraft?.id, label: question["label"]?.text ?? key, reviewContext: ["type": .string("compliance_profile"), "question": .object(question), "rules_version": .string(ruleVersion)])
            try? store.clearForm(formKey)
            if checked { working = true; Task { await store.sync(onlyID: id); working = false; dismiss() } } else { dismiss() }
        } catch { problem = error.localizedDescription }
    }
}
