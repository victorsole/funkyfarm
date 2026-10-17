import SwiftUI

struct GuidedRequestView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let requestID: String
    var deviceDraft: PendingEdit? = nil
    @State private var request: RecordItem?
    @State private var questions: [[String: JSONValue]] = []
    @State private var index = 0
    @State private var completed = 0
    @State private var total = 0
    @State private var blocked: [JSONValue] = []
    @State private var sourceTables: [[String: JSONValue]] = []
    @State private var text = ""
    @State private var choice: JSONValue = .null
    @State private var unknown = false
    @State private var note = ""
    @State private var documentID = ""
    @State private var actualDate = ""
    @State private var check: CaptureCheck?
    @State private var acknowledged: Set<String> = []
    @State private var working = false
    @State private var problem: String?
    @State private var savedDraft: UUID?
    private var question: [String: JSONValue]? { questions.indices.contains(index) ? questions[index] : nil }
    private var key: String { question?["key"]?.text ?? "" }
    private var questionID: String { question?["id"]?.text ?? "" }
    private var physicalLabel: String { question?["physical_label"]?.text.suppliedValue ?? "" }
    private var formKey: String { "answer:" + requestID + ":question:" + questionID }
    private var suppliedPeriod: String? {
        guard let value = question?["period"], value != .null, !value.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value.text
    }
    private var needsActualDate: Bool { question?["temporal_basis"]?.text == "calendar_date" && suppliedPeriod == nil && (question?["value_type"]?.text != "date" || unknown) }
    private var answerPeriod: String? {
        if let suppliedPeriod { return suppliedPeriod }
        guard question?["temporal_basis"]?.text == "calendar_date" else { return nil }
        let entered = needsActualDate ? actualDate : text
        let trimmed = entered.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    private var canCheck: Bool { !questionID.isEmpty && inputValue != nil && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (question?["temporal_basis"]?.text != "calendar_date" || answerPeriod != nil) }
    private var inputValue: JSONValue? {
        guard !unknown else { return .null }
        switch question?["value_type"]?.text {
        case "number": guard let number = Double(text), number.isFinite else { return nil }; return .number(number)
        case "boolean", "choice": return choice == .null ? nil : choice
        default: return .string(text)
        }
    }
    private var rawAnswer: [String: JSONValue] {
        guard let request, let question else { return [:] }
        var sources: [JSONValue] = []
        if !note.isEmpty { sources.append(.object(["type": .string("manual"), "note": .string(note)])) }
        if let document = store.record("documents", documentID) { sources.append(.object(["document_id": .string(document.id), "revision": .number(Double(document.revision))])) }
        var value: [String: JSONValue] = ["request_id": .string(requestID), "expected_request_revision": .number(Double(request.revision)), "question_id": .string(questionID), "key": .string(key), "value": inputValue ?? .null, "sources": .array(sources), "note": .string(note)]
        for field in ["unit", "temporal_basis", "parcel_id"] { if let supplied = question[field], supplied != .null { value[field] = supplied } }
        if let answerPeriod { value["period"] = .string(answerPeriod) }
        else if question["temporal_basis"]?.text != "calendar_date", let supplied = question["period"] { value["period"] = supplied }
        return value
    }
    var body: some View {
        List {
            Section {
                Text(request?.title ?? "Request questions").font(.headline)
                Text("\(completed) of \(total) required answers confirmed").font(.subheadline).foregroundStyle(.secondary)
                if total > 0 { ProgressView(value: Double(completed), total: Double(total)).accessibilityLabel("Confirmed answers").accessibilityValue("\(completed) of \(total)") }
                Text("Each answer starts as a proposal. Confirming its source is a separate review, and unresolved conflicts remain visible.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(Array(blocked.enumerated()), id: \.offset) { _, reason in Section { Notice(reason.object["message"]?.text ?? reason.text, warning: true) } }
            if !sourceTables.isEmpty {
                Section("Source tables needed for this request") {
                    ForEach(Array(sourceTables.enumerated()), id: \.offset) { _, table in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(table["label"]?.text ?? "Original source table").font(.headline)
                            if let count = table["confirmed_count"] { LabeledContent("Confirmed source rows", value: count.text) }
                            if let count = table["proposed_count"] { LabeledContent("Proposed source rows", value: count.text) }
                            if let profileID = table["profile_id"]?.text, let farmID = request?.data["farm_id"]?.text {
                                NavigationLink("Import the matching source export") { ImportRecordsView(initialProfileID: profileID, initialFarmID: farmID) }
                                NavigationLink("Compare and review existing source facts") { SourceTableFactsView(farmID: farmID, profileID: profileID) }
                            }
                            Text("Import preserves original rows. Review each proposal separately; a source table is not a manually typed summary answer.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    Button("Refresh confirmed source-row counts") { Task { await load() } }.disabled(working)
                }
            }
            if let question {
                Section("Question \(index + 1) of \(questions.count) to review") {
                    Text(question["prompt"]?.text ?? question["label"]?.text ?? key).font(.title3.bold()).accessibilityAddTraits(.isHeader)
                    if !physicalLabel.isEmpty { LabeledContent("Field or event", value: physicalLabel) }
                    if let unit = question["unit"], unit != .null { LabeledContent("Required unit", value: unit.text) }
                    if let suppliedPeriod { LabeledContent(question["temporal_basis"]?.text == "calendar_date" ? "Recorded event date" : "Reporting period", value: suppliedPeriod) }
                    if questionID.isEmpty { Notice("This question has no context identifier. Reload it before checking or saving an answer.", warning: true) }
                    if let proposals = question["proposals"]?.array, !proposals.isEmpty {
                        Text("Proposed answers already exist. Review them before adding another.").font(.callout)
                        ForEach(Array(proposals.enumerated()), id: \.offset) { _, value in
                            if let record = recordValue(value) { NavigationLink { DetailView(collection: "facts", id: record.id) } label: { RecordRow(item: record) } }
                        }
                    }
                    if let confirmed = question["confirmed"]?.array, !confirmed.isEmpty {
                        Notice("The reviewed evidence disagrees. Compare the source revisions before proposing a correction.", warning: true)
                        ForEach(Array(confirmed.enumerated()), id: \.offset) { _, value in if let record = recordValue(value) { NavigationLink { DetailView(collection: "facts", id: record.id) } label: { RecordRow(item: record) } } }
                    }
                }.id(questionID)
                Section("Your answer") {
                    Toggle("I cannot establish this value yet", isOn: $unknown)
                    if !unknown {
                        if question["value_type"]?.text == "boolean" {
                            Picker("Answer", selection: $choice) { Text("Choose an answer").tag(JSONValue.null); Text("Yes").tag(JSONValue.bool(true)); Text("No").tag(JSONValue.bool(false)) }
                        } else if question["value_type"]?.text == "choice" {
                            Picker("Answer", selection: $choice) {
                                Text("Choose an answer").tag(JSONValue.null)
                                ForEach(Array((question["choices"]?.array ?? []).enumerated()), id: \.offset) { _, option in Text(option.object["label"]?.text ?? option.object["value"]?.text ?? option.text).tag(option.object["value"] ?? option) }
                            }
                        } else {
                            TextField(question["value_type"]?.text == "date" ? "Recorded date (YYYY-MM-DD)" : "Recorded value", text: $text, axis: .vertical).keyboardType(question["value_type"]?.text == "number" ? .numbersAndPunctuation : .default)
                        }
                    }
                    if needsActualDate {
                        TextField("Actual recorded date (YYYY-MM-DD)", text: $actualDate).keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                        Text("Enter the date from this field or event's evidence. No date is inferred from the reporting year.").font(.footnote).foregroundStyle(.secondary)
                    }
                    Picker("Supporting document", selection: $documentID) { Text("No document selected").tag(""); ForEach(store.records("documents").filter { $0.value("farm_id") == request?.value("farm_id") || $0.value("farm_id").suppliedValue.isEmpty }) { document in Text(document.title).tag(document.id) } }
                    TextField("Where did this answer come from? (required)", text: $note, axis: .vertical)
                    if let references = question["source_references"] { DisclosureGroup("Requirement source and explanation") { SourceReferences(value: references) } }
                }
                Section("Review this answer") {
                    Button("Check answer") { preview() }.disabled(working || !store.sessionVerified || !canCheck)
                    if let check {
                        ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                        ForEach(check.requires_acknowledgement, id: \.self) { code in Toggle(check.issues.first { $0.code == code }?.message ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                        DisclosureGroup("Proposed fact and source values") { JSONFields(data: check.normalized_data) }
                    }
                    Button("Save checked answer as a proposal") { save(checked: true) }.buttonStyle(.borderedProminent).disabled(working || check?.can_save != true || !(Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged)))
                    Button("Keep unfinished answer on this device") { save(checked: false) }.disabled(working || inputValue == nil || questionID.isEmpty)
                    if let savedDraft {
                        NavigationLink("Open the saved answer") { PendingEditView(editID: savedDraft) }
                        Notice(store.disk.queue.contains { $0.id == savedDraft } ? "The answer is saved in this account's device outbox." : "The service acknowledged the proposed answer. Refresh the question to open its fact review.")
                    }
                }
                Section {
                    HStack {
                        Button("Previous question") { move(-1) }.disabled(index == 0 || working)
                        Spacer()
                        Button("Next question") { move(1) }.disabled(index + 1 >= questions.count || working)
                    }
                    Button("Refresh confirmed progress") { Task { await load() } }.disabled(working)
                }
            } else if !working {
                Section {
                    Notice(!sourceTables.isEmpty ? "Review the original source tables above. Confirmed source rows are separate from ordinary questions, and report prerequisites still apply." : questions.isEmpty && blocked.isEmpty ? "The service has no unresolved questions for this request. Review its report prerequisites before approval." : "Questions are not available until the listed prerequisites are resolved.")
                    NavigationLink("Return to request details") { DetailView(collection: "requests", id: requestID) }
                }
            }
            if working { Section { ProgressView("Waiting for the current service check…") } }
            if let problem { Section { Notice(problem, warning: true); Button("Load questions again") { Task { await load() } } } }
        }.navigationTitle("Missing information")
            .task { await load() }
            .onChange(of: rawAnswer) { value in
                check = nil; acknowledged = []; savedDraft = nil
                guard !questionID.isEmpty else { return }
                do { try store.saveForm(formKey, value: value) } catch { problem = "The device could not keep the unfinished answer: \(error.localizedDescription)" }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: questionID)
    }
    private func recordValue(_ value: JSONValue) -> RecordItem? { try? JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value)) }
    private func load() async {
        working = true; problem = nil; defer { working = false }
        let selectedQuestionID = questionID
        do {
            let value = try await store.scopedValue("/workflow/questions?request_id=\(requestID)").object
            if let requestValue = value["request"] { request = recordValue(requestValue) }
            questions = value["questions"]?.array.map(\.object) ?? []
            if case .number(let number)? = value["completed_count"] { completed = Int(number) }
            if case .number(let number)? = value["total_count"] { total = Int(number) }
            blocked = value["blocked_reasons"]?.array ?? []
            sourceTables = value["source_tables"]?.array.map(\.object) ?? []
            if let savedID = deviceDraft?.payload["question_id"]?.text, let savedIndex = questions.firstIndex(where: { $0["id"]?.text == savedID }) { index = savedIndex }
            else if !selectedQuestionID.isEmpty, let same = questions.firstIndex(where: { $0["id"]?.text == selectedQuestionID }) { index = same }
            else if deviceDraft?.payload["question_id"] == nil, let savedKey = deviceDraft?.payload["key"]?.text {
                let matches = questions.indices.filter { questions[$0]["key"]?.text == savedKey }
                if matches.count == 1 { index = matches[0] }
                else { index = 0; problem = "The saved answer does not identify a unique field or event question. Its original device draft is retained; review the contexts before entering a new answer." }
            } else {
                index = min(index, max(0, questions.count - 1))
                if deviceDraft != nil { problem = "The saved question is no longer among the unresolved contexts. Its original device draft has been retained." }
            }
            resetInput()
            fillSavedAnswer()
        } catch { problem = error.localizedDescription }
    }
    private func fillSavedAnswer() {
        check = nil; acknowledged = []
        guard !questionID.isEmpty else { return }
        let form: [String: JSONValue]?
        do {
            if let identified = try store.loadForm(formKey) { form = identified }
            else if questions.filter({ $0["key"]?.text == key }).count == 1,
                    let legacy = try store.loadForm("answer:" + requestID + ":" + key), matchesCurrentQuestion(legacy) { form = legacy }
            else { form = nil }
        }
        catch { problem = "The saved unfinished answer could not be opened: \(error.localizedDescription)"; return }
        let saved = form ?? (deviceDraft.map { matchesCurrentQuestion($0.payload) } == true ? deviceDraft?.payload : nil)
        guard let saved else { return }
        let value = saved["value"] ?? .null
        unknown = value == .null; choice = value
        if case .number(let number) = value { text = String(number) } else { text = value.text }
        note = saved["note"]?.text ?? ""
        documentID = saved["sources"]?.array.compactMap { $0.object["document_id"]?.text }.first ?? ""
        actualDate = suppliedPeriod == nil ? saved["period"]?.text.suppliedValue ?? "" : ""
    }
    private func matchesCurrentQuestion(_ saved: [String: JSONValue]) -> Bool {
        if let id = saved["question_id"]?.text { return !questionID.isEmpty && id == questionID && saved["parcel_id"] == rawAnswer["parcel_id"] }
        guard saved["key"]?.text == key, questions.filter({ $0["key"]?.text == key }).count == 1 else { return false }
        if let suppliedPeriod, saved["period"]?.text != suppliedPeriod { return false }
        return saved["parcel_id"] == rawAnswer["parcel_id"]
    }
    private func resetInput() {
        text = ""; choice = .null; unknown = false; note = ""; documentID = ""; actualDate = ""; check = nil; acknowledged = []; savedDraft = nil
    }
    private func move(_ offset: Int) {
        index += offset; resetInput()
        fillSavedAnswer()
    }
    private func preview() {
        working = true; problem = nil
        let original = rawAnswer
        Task {
            do {
                var body = original; body["preview"] = .bool(true)
                let result = try await store.scopedValue("/workflow/answer", method: "POST", body: body)
                guard rawAnswer == original, let value = result.object["check"] else { working = false; return }
                check = try JSONDecoder().decode(CaptureCheck.self, from: JSONEncoder().encode(value)); acknowledged = []
            } catch { problem = error.localizedDescription }
            working = false
        }
    }
    private func save(checked: Bool) {
        do {
            guard !questionID.isEmpty, !checked || canCheck else { throw ServiceError(status: 0, message: "Keep the current question context and its actual event date before saving a checked answer.") }
            let replacement = deviceDraft.flatMap { matchesCurrentQuestion($0.payload) ? $0.id : nil }
            let label = (question?["label"]?.text ?? key) + (physicalLabel.isEmpty ? "" : " (\(physicalLabel))")
            let id = try store.saveCaptureDraft(body: rawAnswer, review: checked ? check : nil, acknowledged: acknowledged, replacing: replacement, path: "/workflow/answer", label: label)
            try? store.clearForm(formKey)
            savedDraft = id
            if checked { working = true; Task { await store.sync(onlyID: id); await load(); working = false } }
        } catch { problem = error.localizedDescription }
    }
}

struct SourceReferences: View {
    let value: JSONValue
    var body: some View {
        let sources = value.array.isEmpty ? [value] : value.array
        ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
            VStack(alignment: .leading, spacing: 4) {
                let object = source.object
                if let address = object["url"]?.text, let url = URL(string: address), url.scheme == "https" { Link(object["title"]?.text ?? "Open official source", destination: url) }
                if let edition = object["edition"] { Text(edition.text).font(.caption) }
                Text(source.text).font(.caption).textSelection(.enabled)
            }
        }
    }
}
