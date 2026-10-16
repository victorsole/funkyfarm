import SwiftUI

struct PrivateAdviceView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    @State private var farmID = ""
    var body: some View {
        List {
            Section { FarmPicker(selected: $farmID); Notice("Only a named adviser who already has access to this farm can receive a private question. Nothing is published to the community, and no official mandate is created.") }
            if !farmID.isEmpty { PrivateAdviceFarmSections(farmID: farmID).id(farmID) }
        }.navigationTitle("Private adviser questions")
            .onAppear { if farmID.isEmpty { farmID = initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "") } }
    }
}

private struct PrivateAdviceFarmSections: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    @State private var recipients: [[String: JSONValue]] = []
    @State private var questions: [RecordItem] = []
    @State private var offset = 0
    @State private var total = 0
    @State private var recipient = ""
    @State private var title = ""
    @State private var message = ""
    @State private var actionKey = UUID().uuidString
    @State private var consent = false
    @State private var loaded = false
    @State private var trackedDraft: [String: JSONValue]?
    @State private var working = false
    @State private var problem: String?
    private var formKey: String { "private-adviser-question:" + farmID }
    private var draft: [String: JSONValue] { ["recipient_id": .string(recipient), "title": .string(title), "body": .string(message)] }
    var body: some View {
        Group {
            if store.account?.workspace.role == "owner" { Section("Write a private question") {
                if recipients.isEmpty { Text("No existing adviser recipient is loaded for this farm.").foregroundStyle(.secondary); NavigationLink("Find or invite an adviser") { AdviserHelpView() } }
                Picker("Named adviser", selection: $recipient) { Text("Choose a recipient").tag(""); ForEach(Array(recipients.enumerated()), id: \.offset) { _, item in Text(item["display_name"]?.text ?? "Named adviser").tag(item["user_id"]?.text ?? "") } }
                TextField("Subject", text: $title)
                TextField("Your question", text: $message, axis: .vertical).lineLimit(3...10)
                Text("Only the question text and the selected farm are sent. No evidence file is attached automatically.").font(.footnote).foregroundStyle(.secondary)
                Toggle("Send this question to the selected named adviser", isOn: $consent)
                Button("Send private question") { send() }.buttonStyle(.borderedProminent).disabled(!consent || recipient.isEmpty || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !recipients.contains(where: { $0["user_id"]?.text == recipient }) || !store.sessionVerified)
            }.disabled(working) }
            Section("Farm questions") {
                ForEach(questions) { question in NavigationLink { PrivateQuestionDetailView(initial: question) } label: { RecordRow(item: question) } }
                if questions.isEmpty { Text("No private questions are loaded.").foregroundStyle(.secondary) }
                HStack { Button("Previous questions") { offset = max(0, offset - 20); Task { await refresh() } }.disabled(offset == 0 || working); Spacer(); Text("\(offset + questions.count) of \(total)").font(.caption); Spacer(); Button("More questions") { offset += 20; Task { await refresh() } }.disabled(working || offset + questions.count >= total) }
                Button("Refresh recipients and questions") { Task { await refresh() } }.disabled(working || !store.sessionVerified)
            }
            if working { Section { ProgressView("Waiting for private adviser service…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.task {
            do { if let value = try store.loadForm(formKey) { recipient = value["recipient_id"]?.text ?? ""; title = value["title"]?.text ?? ""; message = value["body"]?.text ?? ""; actionKey = value["action_key"]?.text ?? actionKey } } catch { problem = error.localizedDescription }
            trackedDraft = draft; loaded = true; await refresh()
        }.onChange(of: draft) { value in
            guard loaded, !working, value != trackedDraft else { return }; trackedDraft = value; consent = false; actionKey = UUID().uuidString
            do { var saved = value; saved["action_key"] = .string(actionKey); try store.saveForm(formKey, value: saved) } catch { problem = error.localizedDescription }
        }
    }
    private func refresh() async {
        working = true; defer { working = false }
        do { recipients = try await store.scopedValue("/adviser/recipients?farm_id=\(farmID)").object["items"]?.array.map(\.object) ?? []; let page = try await store.scopedValue("/adviser/questions?farm_id=\(farmID)&limit=20&offset=\(offset)"); questions = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(page.object["items"] ?? .array([]))); if case .number(let n)? = page.object["total"] { total = Int(n) } }
        catch { problem = error.localizedDescription }
    }
    private func send() {
        guard consent, recipients.contains(where: { $0["user_id"]?.text == recipient }) else { return }
        do { var saved = draft; saved["action_key"] = .string(actionKey); try store.saveForm(formKey, value: saved) } catch { problem = error.localizedDescription; return }
        working = true; problem = nil; var body = draft; body["farm_id"] = .string(farmID)
        Task { do { _ = try await store.scopedValue("/adviser/questions", method: "POST", body: body, idempotency: actionKey); try? store.clearForm(formKey); title = ""; message = ""; consent = false; actionKey = UUID().uuidString; await refresh() } catch { problem = error.localizedDescription }; working = false }
    }
}

struct PrivateQuestionDetailView: View {
    @EnvironmentObject private var store: AppStore
    let initial: RecordItem
    @State private var current: RecordItem?
    @State private var reply = ""
    @State private var actionKey = UUID().uuidString
    @State private var attemptedRevision: Int?
    @State private var trackedReply = ""
    @State private var closeKey = UUID().uuidString
    @State private var consent = false
    @State private var close = false
    @State private var working = false
    @State private var loaded = false
    @State private var problem: String?
    private var item: RecordItem { current ?? initial }
    private var formKey: String { "private-question-reply:" + initial.id }
    var body: some View {
        List {
            Section { Text(item.title).font(.title3.bold()); Text(item.value("body")); LabeledContent("Recorded status", value: item.state); Text("Private to the farm owner and named adviser. Replies are advice, not authority acceptance.").font(.footnote).foregroundStyle(.secondary) }
            Section("Replies") { ForEach(Array((item.data["responses"]?.array ?? []).enumerated()), id: \.offset) { _, response in VStack(alignment: .leading, spacing: 5) { Text(response.object["body"]?.text ?? ""); if let date = response.object["at"] { Text(date.text).font(.caption).foregroundStyle(.secondary) } } } }
            if item.state != "closed" {
                Section("Your reply") {
                    TextField("Reply to this private question", text: $reply, axis: .vertical).lineLimit(3...10)
                    Toggle("Send this reply to the private conversation", isOn: $consent)
                    if let attemptedRevision, attemptedRevision != item.revision { Notice("An earlier send used revision \(attemptedRevision). Compare the replies before changing the text. Retrying the unchanged text keeps its original revision and retry key to avoid duplication.", warning: true) }
                    Button("Send private reply") { send() }.disabled(!consent || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || current == nil || !store.sessionVerified)
                    if store.account?.workspace.role == "owner" { Button("Close this question") { close = true }.disabled(current == nil || !store.sessionVerified) }
                }.disabled(working)
            }
            Section { RecordMetadata(item: item); Button("Reload current conversation") { Task { await load() } }.disabled(working || !store.sessionVerified) }
            if working { Section { ProgressView("Waiting for private conversation…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Private question")
            .task { guard !loaded else { await load(); return }; do { if let saved = try store.loadForm(formKey) { reply = saved["body"]?.text ?? ""; actionKey = saved["action_key"]?.text ?? actionKey; if case .number(let n)? = saved["expected_revision"] { attemptedRevision = Int(n) } } } catch { problem = error.localizedDescription }; trackedReply = reply; loaded = true; await load() }
            .onChange(of: reply) { value in guard loaded, !working, value != trackedReply else { return }; trackedReply = value; consent = false; attemptedRevision = nil; actionKey = UUID().uuidString; do { try store.saveForm(formKey, value: ["body": .string(value), "action_key": .string(actionKey)]) } catch { problem = error.localizedDescription } }
            .confirmationDialog("Close this private question at revision \(item.revision)?", isPresented: $close, titleVisibility: .visible) { Button("Close question") { performClose() } }
    }
    private func load() async { working = true; defer { working = false }; do { let value = try await store.scopedValue("/adviser/questions/\(initial.id)"); current = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value)) } catch { problem = error.localizedDescription } }
    private func send() {
        guard let current, consent, current.state != "closed" else { return }
        let revision = attemptedRevision ?? current.revision
        let body: [String: JSONValue] = ["expected_revision": .number(Double(revision)), "body": .string(reply)]
        do { var saved = body; saved["action_key"] = .string(actionKey); try store.saveForm(formKey, value: saved) } catch { problem = error.localizedDescription; return }
        attemptedRevision = revision; working = true; problem = nil
        Task { do { _ = try await store.scopedValue("/adviser/questions/\(initial.id)/reply", method: "POST", body: body, idempotency: actionKey); try? store.clearForm(formKey); reply = ""; consent = false; attemptedRevision = nil; actionKey = UUID().uuidString; await load() } catch { problem = error.localizedDescription }; working = false }
    }
    private func performClose() {
        guard let current, store.account?.workspace.role == "owner" else { return }; working = true
        Task { do { _ = try await store.scopedValue("/adviser/questions/\(initial.id)/close", method: "POST", body: ["expected_revision": .number(Double(current.revision))], idempotency: closeKey); await load() } catch { problem = error.localizedDescription }; working = false }
    }
}
