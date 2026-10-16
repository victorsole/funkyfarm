import SwiftUI

struct FarmerHelpView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        List {
            Section("Use your own assistant") {
                Text("Start with your own Claude or ChatGPT account. Use the official connection and consent flow in the web workspace to choose access.")
                if let url = BrowserHandoff.url(account: store.account, path: "/app/assistant/connect") { Link("Open official assistant connection setup", destination: url) }
                if let url = BrowserHandoff.url(account: store.account, path: "/app/help") { Link("Read assistant setup and connection status", destination: url) }
                Text("The browser requires its own sign-in and shows the actual connection status. No provider key is requested or passed by this app.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Other ways to get help") {
                NavigationLink("Ask a local question") { LocalFarmChatView() }
                NavigationLink("Ask your named adviser privately") { PrivateAdviceView() }
                NavigationLink("Find or invite an adviser") { AdviserHelpView() }
                NavigationLink("Ask the public farmer community") { FarmerCommunityView() }
            }
            Section("Keep the decision with you") {
                Text("Check the cited source and your farm's evidence. A chat answer or peer reply does not confirm a fact, approve a report, establish a mandate or record an authority decision.").font(.callout)
            }
        }.navigationTitle("Help")
    }
}

struct LocalFarmChatView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var labels: NativeLabels
    @State private var farmID = ""
    @State private var status: [String: JSONValue] = [:]
    @State private var language = "en"
    @State private var includeContext = false
    @State private var message = ""
    @State private var conversation: [ChatTurn] = []
    @State private var citations: [JSONValue] = []
    @State private var contextNotice: String?
    @State private var responseState: String?
    @State private var checking = false
    @State private var sending = false
    @State private var problem: String?
    private struct ChatTurn: Identifiable { let id = UUID(); let role: String; let content: String }
    private var ready: Bool { status["available"] == .bool(true) && status["enabled"] == .bool(true) && status["external_api_calls"] == .bool(false) && status["hosting"] == .string("owner_hosted") }
    private var formKey: String { "local-chat-message:" + farmID }
    private var languages: [[String: JSONValue]] { status["languages"]?.array.map(\.object) ?? [] }
    private var maximumMessage: Int { if case .number(let n)? = status["limits"]?.object["message_max_chars"] { return Int(n) }; return 2_000 }
    private var maximumBytes: Int { if case .number(let n)? = status["limits"]?.object["message_max_utf8_bytes"] { return Int(n) }; return 1_200 }
    var body: some View {
        List {
            Section("Local, read-only help") {
                if let privacy = status["privacy_notice"] { Notice(privacy.text) }
                if ready { Text("The service reports that local chat is available.") }
                else if !status.isEmpty { Notice(availabilityMessage, warning: true) }
                Button("Check local chat availability") { Task { await loadStatus() } }.disabled(checking || sending || !store.sessionVerified)
                if checking { ProgressView("Checking local service…") }
                Text("There is no external API fallback. Local chat can explain and cite information; it cannot make changes or approvals.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Choose the scope") {
                FarmPicker(selected: Binding(get: { farmID }, set: changeFarm)).disabled(sending)
                if store.records("farms").isEmpty { NavigationLink("Set up my farm") { FarmSetupView() } }
                if !languages.isEmpty {
                    Picker("Answer language", selection: $language) { ForEach(Array(languages.enumerated()), id: \.offset) { _, item in Text(item["name"]?.text ?? item["code"]?.text ?? "").tag(item["code"]?.text ?? "") } }.disabled(sending)
                }
                Toggle("Include this farm's records in this conversation", isOn: $includeContext).disabled(sending || farmID.isEmpty)
                Text(includeContext ? "You chose to include permitted records from the selected farm. Review the context notice and citations returned with each answer." : "Farm records are not requested as chat context. The question text you enter is still sent to your owner-hosted service.").font(.footnote).foregroundStyle(.secondary)
                Text("Changing farm or context consent starts a new conversation. Replies are kept in memory; only an unfinished message is saved privately on this device.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("Ask a question") {
                TextField("What do you need help with?", text: $message, axis: .vertical).lineLimit(3...10).disabled(sending)
                Text("\(message.count) / \(maximumMessage) characters").font(.caption).foregroundStyle(.secondary)
                Text("\(message.utf8.count) / \(maximumBytes) encoded bytes").font(.caption).foregroundStyle(.secondary)
                Button("Ask local assistant") { send() }.buttonStyle(.borderedProminent).disabled(sending || !ready || !store.sessionVerified || farmID.isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.count > maximumMessage || message.utf8.count > maximumBytes)
                if sending { ProgressView("Waiting for the local model…") }
            }
            if !conversation.isEmpty {
                Section("This conversation") {
                    ForEach(conversation) { turn in VStack(alignment: .leading, spacing: 5) { Text(turn.role == "user" ? "Your question" : "Local answer").font(.caption.weight(.semibold)).foregroundStyle(.secondary); Text(turn.content).textSelection(.enabled) } }
                    if responseState == "unknown" { Notice("The local service could not establish an answer. Check the sources or ask a qualified adviser.", warning: true) }
                    if let contextNotice { Notice(contextNotice) }
                }
            }
            if !citations.isEmpty {
                Section("Sources returned with the answer") { ForEach(Array(citations.enumerated()), id: \.offset) { _, citation in SourceReferences(value: citation) } }
            }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Local help")
            .task { language = labels.language; if farmID.isEmpty, store.records("farms").count == 1 { changeFarm(store.records("farms")[0].id) }; await loadStatus() }
            .onChange(of: includeContext) { _ in clearConversation() }
            .onChange(of: language) { _ in clearConversation() }
            .onChange(of: message) { value in
                guard !farmID.isEmpty else { return }
                do { try store.saveForm(formKey, value: ["message": .string(value), "language": .string(language)]) }
                catch { problem = "The unfinished message could not be saved privately: \(error.localizedDescription)" }
            }
    }
    private var availabilityMessage: String {
        switch status["status"]?.text {
        case "disabled": return "Local chat is disabled on this service. Your own assistant connection and adviser help remain available separately."
        case "model_missing": return "The configured local model is not installed on the service. No external model has been substituted."
        case "unreachable": return "The local model could not be reached. Your unfinished message is retained."
        case "configuration_error": return "The local chat service needs configuration before it can answer."
        default: return "The service has not reported a ready local model."
        }
    }
    private func clearConversation() { conversation = []; citations = []; contextNotice = nil; responseState = nil }
    private func changeFarm(_ id: String) {
        if !farmID.isEmpty { try? store.saveForm(formKey, value: ["message": .string(message), "language": .string(language)]) }
        farmID = id; message = ""; includeContext = false; clearConversation()
        do { if let draft = try store.loadForm(formKey) { message = draft["message"]?.text ?? ""; if let savedLanguage = draft["language"]?.text { language = savedLanguage } } }
        catch { problem = "The unfinished message could not be opened: \(error.localizedDescription)" }
    }
    private func loadStatus() async {
        checking = true; defer { checking = false }
        do {
            status = try await store.scopedValue("/assistant/chat/status").object
            if !languages.contains(where: { $0["code"]?.text == language }) { language = languages.first(where: { $0["code"]?.text == "en" })?["code"]?.text ?? languages.first?["code"]?.text ?? "en" }
        } catch { problem = error.localizedDescription }
    }
    private func send() {
        guard ready, !farmID.isEmpty, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, message.count <= maximumMessage, message.utf8.count <= maximumBytes else { return }
        sending = true; problem = nil
        let question = message, selectedFarm = farmID, consent = includeContext
        let history = conversation.suffix(4).map { JSONValue.object(["role": .string($0.role), "content": .string(String($0.content.prefix(800)))]) }
        Task {
            do {
                var body: [String: JSONValue] = ["farm_id": .string(selectedFarm), "message": .string(question), "language": .string(language), "include_farm_context": .bool(consent)]
                if consent { body["history"] = .array(history) }
                let response = try await store.scopedValue("/assistant/chat", method: "POST", body: body).object
                guard farmID == selectedFarm, includeContext == consent else { sending = false; return }
                guard let answer = response["answer"]?.text, let state = response["status"]?.text, ["answered", "unknown"].contains(state) else { throw ServiceError(status: 0, message: "The service returned no usable answer. The message has been retained.") }
                conversation.append(ChatTurn(role: "user", content: question)); conversation.append(ChatTurn(role: "assistant", content: answer))
                citations = response["citations"]?.array ?? []; contextNotice = response["context_notice"]?.text; responseState = state
                message = ""; try? store.clearForm(formKey)
            } catch { problem = error.localizedDescription }
            sending = false
        }
    }
}
