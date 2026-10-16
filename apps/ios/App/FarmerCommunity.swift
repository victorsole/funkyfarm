import SwiftUI

private let communityCategories = ["general", "paperwork", "cap", "inspections", "sustainability", "records"]

struct FarmerCommunityView: View {
    @EnvironmentObject private var store: AppStore
    @State private var category = "general"
    @State private var country = ""
    @State private var ownOnly = false
    @State private var items: [[String: JSONValue]] = []
    @State private var offset = 0
    @State private var total = 0
    @State private var working = false
    @State private var problem: String?
    private var query: String { category + ":" + country + ":" + String(ownOnly) + ":" + String(offset) }
    var body: some View {
        List {
            Section { Notice("Public farmer discussions are peer advice, not verified expert guidance or authority decisions. Never post private farm identifiers, personal information or document contents without permission."); NavigationLink("Write a public question") { CommunityQuestionComposer() } }
            Section("Find discussions") {
                Toggle("Only my questions and drafts", isOn: $ownOnly)
                if !ownOnly { Picker("Topic", selection: $category) { ForEach(communityCategories, id: \.self) { Text($0.capitalized).tag($0) } }; TextField("Country code, or leave empty", text: $country).textInputAutocapitalization(.characters).autocorrectionDisabled() }
            }.disabled(working)
            Section(ownOnly ? "Your posts" : "Public questions") {
                if items.isEmpty { Text("No discussions are loaded for this selection.").foregroundStyle(.secondary) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    if ownOnly && (item["kind"] == .string("reply") || item["status"] != .string("published")) { CommunityOwnPost(item: item) }
                    else { NavigationLink { CommunityQuestionView(initial: item) } label: { VStack(alignment: .leading, spacing: 5) { Text(item["data"]?.object["title"]?.text ?? "Farmer question").font(.headline); Text(item["status"]?.text ?? "Public question").font(.caption).foregroundStyle(.secondary) } } }
                }
                HStack { Button("Previous page") { offset = max(0, offset - 20) }.disabled(offset == 0 || working); Spacer(); Text("\(offset + (items.isEmpty ? 0 : 1))–\(offset + items.count) of \(total)").font(.caption); Spacer(); Button("Next page") { offset += 20 }.disabled(offset + items.count >= total || working) }
                Button("Refresh discussions") { Task { await load() } }.disabled(working)
            }
            if working { Section { ProgressView("Loading discussions…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Farmer community").task(id: query) { await load() }
            .onChange(of: category) { _ in offset = 0 }.onChange(of: country) { _ in offset = 0 }.onChange(of: ownOnly) { _ in offset = 0 }
    }
    private func load() async {
        working = true; problem = nil; items = []; let selected = query
        defer { working = false }
        do {
            var parts = URLComponents(); parts.path = ownOnly ? "/community/mine" : "/community"
            parts.queryItems = [URLQueryItem(name: "limit", value: "20"), URLQueryItem(name: "offset", value: String(offset))]
            if !ownOnly { parts.queryItems?.append(URLQueryItem(name: "category", value: category)); if !country.isEmpty { parts.queryItems?.append(URLQueryItem(name: "country", value: country)) } }
            let result = try await store.scopedValue(parts.string ?? "/community").object
            guard query == selected else { return }; items = result["items"]?.array.map(\.object) ?? []; if case .number(let n)? = result["total"] { total = Int(n) } else { total = offset + items.count }
        } catch { if selected == query { problem = error.localizedDescription } }
    }
}

private struct CommunityOwnPost: View {
    @EnvironmentObject private var store: AppStore
    let item: [String: JSONValue]
    @State private var withdrawn = false
    @State private var confirm = false
    @State private var working = false
    @State private var problem: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(item["data"]?.object["title"]?.text ?? "Your public reply").font(.headline)
            Text(item["data"]?.object["body"]?.text ?? "").textSelection(.enabled)
            Text(withdrawn ? "Withdrawn" : item["status"]?.text ?? "Unknown status").font(.caption).foregroundStyle(.secondary)
            if let parent = item["data"]?.object["question_id"]?.text, UUID(uuidString: parent) != nil { NavigationLink("Open the parent discussion") { CommunityQuestionView(initial: ["id": .string(parent)]) } }
            if !withdrawn, item["status"] != .string("withdrawn") { Button("Withdraw this post", role: .destructive) { confirm = true }.disabled(working) }
            if item["status"] != .string("published") { Text("This retained item is not a published discussion. Copy only the text you deliberately want to use in a new public question.").font(.footnote).foregroundStyle(.secondary) }
            if let problem { Notice(problem, warning: true) }
        }.confirmationDialog("Withdraw this exact post from the public community?", isPresented: $confirm, titleVisibility: .visible) { Button("Withdraw my post", role: .destructive) { guard let id = item["id"]?.text else { return }; working = true; Task { do { _ = try await store.scopedValue("/community/\(id)/withdraw", method: "POST", body: [:]); withdrawn = true } catch { problem = error.localizedDescription }; working = false } } }
    }
}

private struct CommunityQuestionComposer: View {
    @EnvironmentObject private var store: AppStore
    @State private var title = ""
    @State private var message = ""
    @State private var category = "general"
    @State private var country = ""
    @State private var publish = false
    @State private var actionKey = UUID().uuidString
    @State private var posted: [String: JSONValue]?
    @State private var working = false
    @State private var loaded = false
    @State private var trackedDraft: [String: JSONValue]?
    @State private var problem: String?
    private let formKey = "public-community-question"
    private var draft: [String: JSONValue] { ["title": .string(title), "body": .string(message), "category": .string(category), "country": country.isEmpty ? .null : .string(country)] }
    var body: some View {
        Form {
            if let posted { Section { Notice("The service returned your published question."); NavigationLink("Open your public question") { CommunityQuestionView(initial: posted) } } }
            else {
                Section("Prepare a public question") {
                    TextField("Public subject", text: $title)
                    TextField("Public question text", text: $message, axis: .vertical).lineLimit(4...12)
                    Picker("Topic", selection: $category) { ForEach(communityCategories, id: \.self) { Text($0.capitalized).tag($0) } }
                    TextField("Country code, if relevant", text: $country).textInputAutocapitalization(.characters).autocorrectionDisabled()
                    Notice("This text will be public. No farm record, private question or attachment is included automatically. You may withdraw your own post; there is no edit action here.")
                }.disabled(working)
                Section("Review publication") {
                    Text(title).font(.headline); Text(message).textSelection(.enabled)
                    Toggle("I want to publish this exact text to the public community", isOn: $publish).disabled(working)
                    Button("Publish public question") { send() }.buttonStyle(.borderedProminent).disabled(working || !publish || title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.sessionVerified)
                    Text("Unfinished text stays in this account's protected device storage. It is never published by background synchronization.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            if working { Section { ProgressView("Publishing your chosen text…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Public question")
            .task { guard !loaded else { return }; do { if let saved = try store.loadForm(formKey) { title = saved["title"]?.text ?? ""; message = saved["body"]?.text ?? ""; category = saved["category"]?.text ?? "general"; country = saved["country"] == .null ? "" : saved["country"]?.text ?? ""; actionKey = saved["action_key"]?.text ?? actionKey } } catch { problem = error.localizedDescription }; trackedDraft = draft; loaded = true }
            .onChange(of: draft) { value in guard loaded, !working, posted == nil, value != trackedDraft else { return }; trackedDraft = value; publish = false; actionKey = UUID().uuidString; do { var saved = value; saved["action_key"] = .string(actionKey); try store.saveForm(formKey, value: saved) } catch { problem = error.localizedDescription } }
    }
    private func send() {
        guard publish else { return }
        do { var saved = draft; saved["action_key"] = .string(actionKey); try store.saveForm(formKey, value: saved) } catch { problem = error.localizedDescription; return }
        var body = draft; body["publish"] = .bool(true); working = true; problem = nil
        Task { do { posted = try await store.scopedValue("/community", method: "POST", body: body, idempotency: actionKey).object; try? store.clearForm(formKey); publish = false } catch { problem = error.localizedDescription }; working = false }
    }
}

private struct CommunityQuestionView: View {
    @EnvironmentObject private var store: AppStore
    let initial: [String: JSONValue]
    @State private var question: [String: JSONValue] = [:]
    @State private var replies: [[String: JSONValue]] = []
    @State private var reply = ""
    @State private var trackedReply = ""
    @State private var publish = false
    @State private var reason = ""
    @State private var report = false
    @State private var withdraw = false
    @State private var actionKey = UUID().uuidString
    @State private var working = false
    @State private var loaded = false
    @State private var problem: String?
    @State private var notice: String?
    private var item: [String: JSONValue] { question.isEmpty ? initial : question }
    private var id: String { initial["id"]?.text ?? "" }
    private var formKey: String { "public-community-reply:" + id }
    var body: some View {
        List {
            Section { Text(item["data"]?.object["title"]?.text ?? "Farmer question").font(.title3.bold()); Text(item["data"]?.object["body"]?.text ?? ""); Notice("Public peer advice. Verify sources and ask a qualified adviser for decisions affecting your farm."); if let status = item["status"] { LabeledContent("Post status", value: status.text) } }
            Section("Public replies") { ForEach(Array(replies.enumerated()), id: \.offset) { _, response in Text(response["data"]?.object["body"]?.text ?? "") } }
            Section("Write a public reply") {
                TextField("Public reply text", text: $reply, axis: .vertical).lineLimit(3...10)
                Toggle("Publish this exact reply publicly", isOn: $publish)
                Button("Publish reply") { sendReply() }.disabled(!publish || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.sessionVerified || item["status"] == .string("withdrawn"))
                Text("No private farm data is attached automatically.").font(.footnote).foregroundStyle(.secondary)
            }.disabled(working)
            Section("Manage this discussion") {
                if item["is_author"] == .bool(true) { Button("Withdraw my public question", role: .destructive) { withdraw = true }.disabled(working || item["status"] == .string("withdrawn")) }
                TextField("Reason for reporting this discussion", text: $reason, axis: .vertical)
                Button("Review report") { report = true }.disabled(working || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Reload discussion") { Task { await load() } }.disabled(working)
            }
            if let notice { Section { Notice(notice) } }
            if working { Section { ProgressView("Waiting for community service…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Community discussion")
            .task { guard !loaded else { await load(); return }; do { if let saved = try store.loadForm(formKey) { reply = saved["body"]?.text ?? ""; actionKey = saved["action_key"]?.text ?? actionKey } } catch { problem = error.localizedDescription }; trackedReply = reply; loaded = true; await load() }
            .onChange(of: reply) { text in guard loaded, !working, text != trackedReply else { return }; trackedReply = text; publish = false; actionKey = UUID().uuidString; do { try store.saveForm(formKey, value: ["body": .string(text), "action_key": .string(actionKey)]) } catch { problem = error.localizedDescription } }
            .confirmationDialog("Withdraw your public question?", isPresented: $withdraw, titleVisibility: .visible) { Button("Withdraw my question", role: .destructive) { action("withdraw", body: [:]) } }
            .confirmationDialog("Send this report reason to the community moderators?", isPresented: $report, titleVisibility: .visible) { Button("Send report") { action("report", body: ["reason": .string(reason)]) } }
    }
    private func load() async {
        guard !id.isEmpty else { return }; working = true; defer { working = false }
        do { let response = try await store.scopedValue("/community/\(id)").object; question = response["question"]?.object ?? [:]; replies = response["replies"]?.array.map(\.object) ?? [] } catch { problem = error.localizedDescription }
    }
    private func sendReply() {
        guard publish, !reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        do { try store.saveForm(formKey, value: ["body": .string(reply), "action_key": .string(actionKey)]) } catch { problem = error.localizedDescription; return }
        working = true; problem = nil
        Task { do { _ = try await store.scopedValue("/community/\(id)/replies", method: "POST", body: ["body": .string(reply), "publish": .bool(true)], idempotency: actionKey); try? store.clearForm(formKey); reply = ""; publish = false; actionKey = UUID().uuidString; await load() } catch { problem = error.localizedDescription }; working = false }
    }
    private func action(_ name: String, body: [String: JSONValue]) {
        working = true; problem = nil
        Task { do { _ = try await store.scopedValue("/community/\(id)/\(name)", method: "POST", body: body); notice = name == "withdraw" ? "The service recorded your withdrawal." : "The service received your report."; await load() } catch { problem = error.localizedDescription }; working = false }
    }
}
