import SwiftUI

@main struct FunkyFarmApp: App {
    @StateObject private var store = AppStore()
    @StateObject private var labels = NativeLabels()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            Group {
                if let account = store.account { FarmerTabs().id(account.scope) }
                else { SignInView() }
            }
            .environmentObject(store)
            .environmentObject(labels)
            .environment(\.locale, labels.locale)
            .tint(FarmStyle.ink)
            .task { await store.boot() }
            .onOpenURL { store.handleURL($0) }
            .onChange(of: scenePhase) { phase in
                if phase == .active { store.refreshShared() }
            }
        }
    }
}

enum FarmStyle {
    static let ink = Color(red: 0.12, green: 0.24, blue: 0.20)
    static let paper = Color(uiColor: .systemGroupedBackground)
    static let ochre = Color(red: 0.93, green: 0.62, blue: 0.25)
}

struct ElephantMark: View {
    var body: some View {
        Image("elephant-logo").resizable().scaledToFit()
            .frame(width: 70, height: 64).accessibilityHidden(true)
    }
}

struct SignInView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var labels: NativeLabels
    @State private var endpoint = "https://funkyfarm.elfeel.me/api/v1"
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var register = false
    @State private var working = false
    @State private var problem: String?
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) { ElephantMark(); VStack(alignment: .leading) { Text("funkyfarm").font(.title2.bold()); Text("Your farm. Your evidence.").foregroundStyle(.secondary) } }
                    Text("Handle requests with the farm records you already have. Review every new fact and approve each report yourself.")
                }
                Section(register ? "Create your private workspace" : "Open your workspace") {
                    TextField(labels.text("auth.email", fallback: "Email"), text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField(labels.text("auth.password", fallback: "Password"), text: $password).textContentType(register ? .newPassword : .password)
                    if register { TextField(labels.text("auth.displayName", fallback: "Your name"), text: $name).textContentType(.name) }
                    Button(register ? labels.text("auth.createAccount", fallback: "Create account") : labels.text("auth.signIn", fallback: "Sign in")) {
                        working = true; problem = nil
                        Task {
                            do { try await store.authenticate(base: endpoint, email: email, password: password, displayName: name, register: register); password = "" }
                            catch { problem = error.localizedDescription }
                            working = false
                        }
                    }.disabled(working || email.isEmpty || password.isEmpty || (register && name.isEmpty))
                    if working { ProgressView("Connecting…") }
                    Toggle("I need a new account", isOn: $register)
                }
                Section {
                    DisclosureGroup("Use another service") {
                        TextField("Service API address", text: $endpoint).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        Text("Leave this unchanged to use funkyfarm. For local testing, enter your local API address. Your records stay with the service you choose.").font(.footnote).foregroundStyle(.secondary)
                    }
                }.disabled(working)
                if let problem = problem ?? store.error { Section { Notice(problem, warning: true) } }
                Section { NavigationLink(labels.text("common.language", fallback: "Language")) { LanguageSettingsView() } }
            }.navigationTitle("Welcome")
        }
    }
}

struct FarmerTabs: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var labels: NativeLabels
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var settings = false
    var body: some View {
        TabView(selection: $store.tab) {
            stack(tabIndex: 0) { WorkflowHomeView() }.tabItem { Label(labels.text("nav.home", fallback: "Home"), systemImage: "house") }.tag(0)
            stack(tabIndex: 1) { WorkListView() }.tabItem { Label(labels.text("nav.recordWork", fallback: "Record work"), systemImage: "square.and.pencil") }.tag(1)
            stack(tabIndex: 2) { FieldsView() }.tabItem { Label(labels.text("nav.fields", fallback: "My fields"), systemImage: "map") }.tag(2)
            stack(tabIndex: 3) { PaperworkView() }.tabItem { Label(labels.text("nav.paperwork", fallback: "Paperwork"), systemImage: "tray.full") }.tag(3)
            stack(tabIndex: 4) { DocumentsView() }.tabItem { Label(labels.text("nav.documents", fallback: "Documents"), systemImage: "doc.on.doc") }.tag(4)
        }
        .sheet(isPresented: $settings) { NavigationStack { SettingsView() }.environmentObject(store) }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: store.tab)
    }
    private func stack<Content: View>(tabIndex: Int, @ViewBuilder content: () -> Content) -> some View {
        NavigationStack {
            content()
                .toolbar { ToolbarItem(placement: .navigationBarTrailing) { Button { settings = true } label: { Image(systemName: "person.crop.circle") }.accessibilityLabel("Account and device drafts") } }
                .navigationDestination(isPresented: Binding(get: { store.route != nil && routeTab == tabIndex }, set: { if !$0 && routeTab == tabIndex { store.route = nil } })) {
                    if let route = store.route { DetailView(collection: route.collection, id: route.id) }
                }
        }
    }
    private var routeTab: Int {
        guard let route = store.route else { return -1 }
        return ["requests": 3, "documents": 4, "farms": 2, "reports": 3, "operations": 1, "purchases": 1, "sales": 1, "facts": 3, "tasks": 3, "checklists": 3][route.collection] ?? -1
    }
}

struct Notice: View {
    let text: String
    var warning = false
    init(_ text: String, warning: Bool = false) { self.text = text; self.warning = warning }
    var body: some View {
        Label { Text(text).font(.callout).fixedSize(horizontal: false, vertical: true) } icon: {
            Image(systemName: warning ? "exclamationmark.triangle" : "info.circle")
        }.foregroundStyle(warning ? Color.primary : FarmStyle.ink).padding(.vertical, 4).accessibilityElement(children: .combine)
    }
}

struct SyncBanner: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        Section {
            if !store.sessionVerified {
                Notice("Showing this account's saved records. Confirm your connection before syncing or approving.", warning: true)
                Button("Reconnect") { Task { await store.verifyAndRefresh() } }.disabled(store.busy)
            }
            if let error = store.error { Notice(error, warning: true) }
            if store.busy { ProgressView("Refreshing from service…") }
            if let date = store.disk.lastRefresh { Text("Last complete refresh \(date.formatted(date: .abbreviated, time: .shortened))").font(.caption).foregroundStyle(.secondary) }
            if !store.disk.queue.isEmpty {
                NavigationLink { OutboxView() } label: { Label("\(store.disk.queue.count) saved device drafts", systemImage: "internaldrive") }
            }
        }
    }
}

struct TodayView: View {
    @EnvironmentObject private var store: AppStore
    @State private var capture = false
    private var requests: [RecordItem] {
        store.records("requests").filter { $0.state != "responded" }.sorted {
            let a = $0.value("deadline"), b = $1.value("deadline")
            return (a.isEmpty || a == "Not supplied" ? "9999" : a) < (b.isEmpty || b == "Not supplied" ? "9999" : b)
        }
    }
    var body: some View {
        List {
            Section {
                HStack(spacing: 16) { ElephantMark(); VStack(alignment: .leading, spacing: 5) { Text("A little less paperwork.").font(.title2.bold()); Text(store.account?.workspace.name ?? "Your workspace").foregroundStyle(.secondary) } }.padding(.vertical, 8)
                Button { capture = true } label: { Label("Add document", systemImage: "doc.badge.plus") }.buttonStyle(.borderedProminent)
            }
            SyncBanner()
            Section("Next requests") {
                if requests.isEmpty { Text("No open requests in the loaded records. Add one from Requests.").foregroundStyle(.secondary) }
                ForEach(requests.prefix(5)) { item in NavigationLink { DetailView(collection: "requests", id: item.id) } label: { RecordRow(item: item) } }
            }
            Section("Needs your review") {
                if store.reviewFacts.isEmpty { Text("No proposed facts in the loaded records.").foregroundStyle(.secondary) }
                ForEach(store.reviewFacts.prefix(5)) { item in NavigationLink { DetailView(collection: "facts", id: item.id) } label: { RecordRow(item: item) } }
            }
            Section("Prepared reports") {
                ForEach(store.records("reports").prefix(3)) { item in NavigationLink { DetailView(collection: "reports", id: item.id) } label: { RecordRow(item: item) } }
                if store.records("reports").isEmpty { Text("Reviewed facts can be reused in a report when you have a request and a supported pack.").foregroundStyle(.secondary) }
            }
        }.navigationTitle("Today").refreshable { await store.verifyAndRefresh() }
            .sheet(isPresented: $capture) { NavigationStack { DocumentIntakeView() }.environmentObject(store) }
    }
}

struct RecordRow: View {
    @EnvironmentObject private var labels: NativeLabels
    let item: RecordItem
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.title).font(.headline)
            if !item.state.isEmpty { Text(labels.text("status." + item.state, fallback: item.state.replacingOccurrences(of: "_", with: " ").capitalized)).font(.caption.weight(.semibold)).foregroundStyle(FarmStyle.ink) }
            if !item.value("deadline").isEmpty, item.value("deadline") != "Not supplied" { Label(item.value("deadline"), systemImage: "calendar").font(.subheadline).foregroundStyle(.secondary) }
            if !item.value("reporting_year").isEmpty { Text("Period: \(item.value("reporting_year"))").font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 5).accessibilityElement(children: .combine)
    }
}

struct CollectionView: View {
    @EnvironmentObject private var store: AppStore
    let collection: String
    let title: String
    @State private var search = ""
    @State private var add = false
    private var items: [RecordItem] { store.records(collection).filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.state.localizedCaseInsensitiveContains(search) } }
    var body: some View {
        List {
            SyncBanner()
            Section {
                if items.isEmpty { Text(search.isEmpty ? "Nothing here yet. Start with the add action above." : "No matching records.").foregroundStyle(.secondary) }
                ForEach(items) { item in NavigationLink { DetailView(collection: collection, id: item.id) } label: { RecordRow(item: item) } }
            }
        }.navigationTitle(title).searchable(text: $search, prompt: "Search \(title.lowercased())")
            .refreshable { await store.verifyAndRefresh() }
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { Button { add = true } label: { Label("Add", systemImage: "plus") } } }
            .sheet(isPresented: $add) {
                NavigationStack {
                    if collection == "reports" { ReportComposer() }
                    else if collection == "requests" { RequestEditor() }
                    else { RecordEditor(collection: collection) }
                }.environmentObject(store)
            }
    }
}

struct DocumentsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var search = ""
    @State private var intake = false
    var body: some View {
        List {
            SyncBanner()
            Section {
                Button { intake = true } label: { Label("Scan or add document", systemImage: "camera.viewfinder") }
                NavigationLink { SharedIntakeView() } label: { Label("Shared intake (\(store.sharedFiles.count))", systemImage: "square.and.arrow.down") }
            }
            Section("Private evidence library") {
                let items = store.records("documents").filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) }
                if items.isEmpty { Text("Add a receipt, letter or form. You will review it before upload and extraction.").foregroundStyle(.secondary) }
                ForEach(items) { item in NavigationLink { DetailView(collection: "documents", id: item.id) } label: { RecordRow(item: item) } }
            }
        }.navigationTitle("Documents").searchable(text: $search).refreshable { await store.verifyAndRefresh() }
            .sheet(isPresented: $intake) { NavigationStack { DocumentIntakeView() }.environmentObject(store) }
    }
}

struct DetailView: View {
    @EnvironmentObject private var store: AppStore
    let collection: String
    let id: String
    @State private var problem: String?
    var body: some View {
        Group {
            if let item = store.record(collection, id) {
                if collection == "reports" { ReportDetail(item: item) }
                else if collection == "documents" { DocumentDetail(item: item) }
                else if collection == "facts" { FactReview(item: item) }
                else if ["operations", "purchases", "sales"].contains(collection) { WorkRecordDetail(collection: collection, record: item) }
                else if collection == "requests" { RequestDetail(item: item) }
                else if collection == "tasks" { FarmTaskDetailView(initial: item) }
                else if collection == "checklists" { FarmChecklistView(initial: item) }
                else { FarmDetail(item: item) }
            } else {
                List { Notice(problem ?? "Loading this record…"); Button("Try again") { load() } }
                    .navigationTitle("Record")
            }
        }.task { load() }
            .safeAreaInset(edge: .top) {
                if !store.sessionVerified {
                    Text("Saved device record · reconnect before review or approval")
                        .font(.caption).frame(maxWidth: .infinity).padding(8).background(FarmStyle.ochre.opacity(0.25))
                }
            }
    }
    private func load() {
        Task { do { _ = try await store.refreshDetail(collection, id) } catch { problem = error.localizedDescription } }
    }
}

struct RecordMetadata: View {
    let item: RecordItem
    var body: some View {
        DisclosureGroup("History and source detail") {
            LabeledContent("Revision", value: "\(item.revision)")
            LabeledContent("Updated", value: item.updated_at)
            LabeledContent("Record ID", value: item.id).textSelection(.enabled)
            JSONFields(data: item.data)
        }
    }
}

struct JSONFields: View {
    let data: [String: JSONValue]
    var body: some View {
        ForEach(data.keys.sorted(), id: \.self) { key in
            VStack(alignment: .leading, spacing: 4) {
                Text(key.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption).foregroundStyle(.secondary)
                Text(data[key]?.text ?? "Not supplied").font(.callout).textSelection(.enabled)
            }.padding(.vertical, 4)
        }
    }
}

struct RequestDetail: View {
    @EnvironmentObject private var store: AppStore
    let item: RecordItem
    @State private var edit = false
    @State private var report = false
    var body: some View {
        List {
            Section {
                Text(item.title).font(.title2.bold())
                LabeledContent("State", value: item.state)
                LabeledContent("Recipient", value: item.value("recipient"))
                LabeledContent("Country", value: item.value("country"))
                LabeledContent("Reporting year", value: item.value("reporting_year"))
                LabeledContent("Deadline", value: item.value("deadline"))
                Button("Review request details") { edit = true }
                NavigationLink("Answer missing information") { GuidedRequestView(requestID: item.id) }
                Button("Prepare report") { report = true }.buttonStyle(.borderedProminent)
            }
            Section("Requested evidence") {
                let requirements = item.data["requirements"]?.array ?? []
                if requirements.isEmpty { Text("No requirements recorded. Confirm the request against the original letter.").foregroundStyle(.secondary) }
                ForEach(Array(requirements.enumerated()), id: \.offset) { _, value in Text(value.text) }
            }
            Section("Related reports") {
                ForEach(store.records("reports").filter { $0.value("request_id") == item.id }) { report in NavigationLink { DetailView(collection: "reports", id: report.id) } label: { RecordRow(item: report) } }
            }
            Section { Notice("A draft or a manual reference is preparation evidence. It does not mean an authority has accepted a response."); RecordMetadata(item: item) }
        }.navigationTitle("Request").sheet(isPresented: $edit) { NavigationStack { RequestEditor(existing: item) }.environmentObject(store) }
            .sheet(isPresented: $report) { NavigationStack { ReportComposer(request: item) }.environmentObject(store) }
    }
}

struct FarmDetail: View {
    @EnvironmentObject private var store: AppStore
    let item: RecordItem
    @State private var edit = false
    @State private var fact = false
    var body: some View {
        List {
            Section { Text(item.title).font(.title2.bold()); JSONFields(data: item.data); Button("Edit farm details") { edit = true } }
            Section("Farm facts") {
                Button("Record a proposed fact") { fact = true }
                ForEach(store.records("facts").filter { $0.value("farm_id") == item.id }) { fact in NavigationLink { DetailView(collection: "facts", id: fact.id) } label: { RecordRow(item: fact) } }
            }
            Section("Activity and supporting records") {
                NavigationLink("Work records, purchases and sales") { WorkListView(farmID: item.id) }
                ForEach(["tasks", "checklists"], id: \.self) { kind in
                    NavigationLink(kind.capitalized) { FarmActivityView(collection: kind, farmID: item.id) }
                }
            }
            Section { RecordMetadata(item: item) }
        }.navigationTitle("My farm").sheet(isPresented: $edit) { NavigationStack { FarmSetupView(existing: item) }.environmentObject(store) }
            .sheet(isPresented: $fact) { NavigationStack { RecordEditor(collection: "facts", farmID: item.id) }.environmentObject(store) }
    }
}

struct FarmActivityView: View {
    @EnvironmentObject private var store: AppStore
    let collection: String
    let farmID: String
    @State private var add = false
    var body: some View {
        List {
            ForEach(store.records(collection).filter { $0.value("farm_id") == farmID }) { item in DisclosureGroup(item.title) { JSONFields(data: item.data) } }
            Button("Add \(collection.dropLast())") { add = true }
        }.navigationTitle(collection.capitalized).sheet(isPresented: $add) { NavigationStack { RecordEditor(collection: collection, farmID: farmID) }.environmentObject(store) }
    }
}

struct FactReview: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: RecordItem
    @State private var note = ""
    @State private var working = false
    @State private var error: String?
    @State private var confirm = false
    @State private var correctionSource: RecordItem?
    @State private var dependencies: [RecordItem]?
    private var profileImportID: String? {
        guard (item.data["sources"]?.array ?? []).contains(where: { $0.object["kind"] == .string("authority_csv_profile") }) else { return nil }
        return (item.data["sources"]?.array ?? []).compactMap { $0.object["import_id"]?.text }.first
    }
    var body: some View {
        List {
            Section("Review the proposed value") {
                Text(item.title).font(.title2.bold())
                if case .object(let value)? = item.data["value"], (item.data["sources"]?.array ?? []).contains(where: { $0.object["kind"] == .string("authority_csv_profile") }) { SourceRowCells(value: value) }
                else { Text(item.data["value"]?.text ?? "No value supplied").font(.title3).textSelection(.enabled) }
                LabeledContent("Review state", value: item.state)
                LabeledContent("Unit", value: item.value("unit"))
                LabeledContent("Period", value: item.value("period"))
                LabeledContent("Time basis", value: item.value("temporal_basis"))
            }
            Section("Source and uncertainty") {
                let sources = item.data["sources"]?.array ?? []
                if sources.isEmpty { Notice("No source is recorded. Verify the value before confirming it.", warning: true) }
                ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                    VStack(alignment: .leading) {
                        Text(source.text).font(.callout).textSelection(.enabled)
                        RecordEvidenceLink(source: source)
                        if let importID = source.object["import_id"]?.text { NavigationLink("Compare the original import row before confirming") { ImportedFactReviewView(factID: item.id, importID: importID) } }
                        if let documentID = source.object["document_id"]?.text { NavigationLink("Open source document") { DetailView(collection: "documents", id: documentID) } }
                    }
                }
                if let uncertainty = item.data["uncertainty"] { Text(uncertainty.text) }
            }
            Section {
                TextField("Review note", text: $note, axis: .vertical)
                if item.state == "proposed" {
                    if let profileImportID { NavigationLink("Compare original source cells and confirm separately") { ImportedFactReviewView(factID: item.id, importID: profileImportID) } }
                    else { Button("Confirm this fact") { confirm = true }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || (item.data["supersedes_id"] != nil && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
                    Button("Reject proposal", role: .destructive) { review("rejected") }.disabled(working || !store.sessionVerified || note.isEmpty)
                }
                Button("Propose a correction") {
                    working = true; error = nil
                    Task {
                        do {
                            let current = try await store.refreshDetail("facts", item.id)
                            guard current.state == "confirmed" else { throw ServiceError(status: 0, message: "Only a current confirmed fact can be corrected. Review this proposal first.") }
                            correctionSource = current
                        } catch { self.error = error.localizedDescription }
                        working = false
                    }
                }.disabled(working || !store.sessionVerified || item.state != "confirmed")
                if working { ProgressView("Recording your review…") }
                if let error { Notice(error, warning: true) }
            }
            Section("Outputs that use this fact") {
                if let dependencies {
                    if dependencies.isEmpty { Text("The service found no dependent reports.") }
                    ForEach(dependencies) { report in NavigationLink { DetailView(collection: "reports", id: report.id) } label: { RecordRow(item: report) } }
                }
                else { Text("Load the dependent reports before making a correction.").foregroundStyle(.secondary) }
                Button("Check affected reports") {
                    Task {
                        do {
                            let page = try await store.scopedValue("/facts/\(item.id)/reports")
                            guard case .array(let items)? = page.object["items"] else { throw ServiceError(status: 0, message: "Dependent report summaries were not returned.") }
                            dependencies = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(JSONValue.array(items))).map(ReportTransport.compact)
                        }
                        catch { self.error = error.localizedDescription }
                    }
                }.disabled(!store.sessionVerified)
                Notice("Confirmed revisions and issued report snapshots remain in history. A correction needs a new reviewed fact and an explicit report reissue.")
            }
            Section { RecordMetadata(item: item) }
        }.navigationTitle("Review fact")
            .confirmationDialog("Confirm this value and its sources?", isPresented: $confirm, titleVisibility: .visible) { Button("Confirm fact") { review("confirmed") } }
            .sheet(item: $correctionSource) { current in NavigationStack { RecordEditor(collection: "facts", farmID: current.value("farm_id"), correction: current) }.environmentObject(store) }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: item.state)
    }
    private func review(_ decision: String) {
        working = true; error = nil
        Task {
            do { try await store.mutate("/facts/\(item.id)/review", body: ["expected_revision": .number(Double(item.revision)), "decision": .string(decision), "note": .string(note)]) }
            catch { self.error = error.localizedDescription }
            working = false
        }
    }
}
