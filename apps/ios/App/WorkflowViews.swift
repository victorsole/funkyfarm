import SwiftUI

struct WorkflowHomeView: View {
    @EnvironmentObject private var store: AppStore
    @State private var setup = false
    private var home: [String: JSONValue] { store.disk.workflowHome ?? [:] }
    var body: some View {
        List {
            Section {
                HStack(spacing: 16) { BrandMark(); VStack(alignment: .leading, spacing: 5) { Text("Your farm, at a glance").font(.title2.bold()); Text(store.account?.workspace.name ?? "").foregroundStyle(.secondary) } }.padding(.vertical, 6)
                if store.records("farms").isEmpty {
                    Notice("Set up your farm to see the requests, records and reporting formats that apply to you.")
                    Button("Set up my farm") { setup = true }.buttonStyle(.borderedProminent)
                } else {
                    NavigationLink { WorkCaptureView() } label: { Label("Record work", systemImage: "square.and.pencil") }
                    NavigationLink { DocumentIntakeView() } label: { Label("Add document", systemImage: "doc.badge.plus") }
                }
            }
            SyncBanner()
            if !store.records("farms").isEmpty {
                Section("Farm administration") {
                    NavigationLink("My paperwork cases") { CaseListView() }
                    NavigationLink("What needs attention?") { FarmComplianceView() }
                    NavigationLink("Tasks and checklists") { FarmTaskListView() }
                    NavigationLink("Questions from my adviser") { AdviserQuestionListView() }
                    NavigationLink("Official-source updates") { RegulatoryUpdatesView() }
                    NavigationLink("Get help") { FarmerHelpView() }
                }
                Section("What do you need to do?") { CaseStartLinks() }
            }
            if !home.isEmpty {
                if let preview = home["task_preview"]?.object {
                    Section("Recorded unfinished tasks") {
                        if let count = preview["total"] { LabeledContent("Unfinished tasks in the loaded Home scope", value: count.text) }
                        if let overdue = preview["overdue_total"] { LabeledContent("Recorded deadlines already passed", value: overdue.text) }
                        if preview["actions_truncated"] == .bool(true) || preview["deadlines_truncated"] == .bool(true) { Notice("Home shows only a bounded preview. Open the paged task list to reach the remaining tasks and recorded deadlines.") }
                        if let href = preview["href"] { WorkflowActionLink(action: ["href": href, "title": .string("Open all saved tasks in this scope"), "message": .string("The list includes all recorded task states, with explicit next and previous pages.")]) }
                    }
                }
                Section("Next steps") {
                    let actions = home["next_actions"]?.array ?? []
                    if actions.isEmpty { Text("The service has no next action recorded for this farm.").foregroundStyle(.secondary) }
                    ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                        WorkflowActionLink(action: action.object)
                    }
                }
                Section("Missing information") {
                    let missing = home["missing_information"]?.array ?? []
                    if missing.isEmpty { Text("No missing information is listed by the service.").foregroundStyle(.secondary) }
                    ForEach(Array(missing.enumerated()), id: \.offset) { _, item in
                        WorkflowActionLink(action: item.object)
                    }
                }
                Section("This reporting year") {
                    let annual = home["annual_review"]?.object ?? [:]
                    if let year = annual["year"] { LabeledContent("Year", value: year.text) }
                    if let reusable = annual["reusable_count"] { LabeledContent("Reusable reviewed facts", value: reusable.text) }
                    if let missing = annual["missing_count"] { LabeledContent("Items still needed", value: missing.text) }
                    Text("Previously recorded facts keep their original period and source. Reuse does not make them newly observed facts.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Awaiting review") {
                    ForEach(store.reviewFacts.prefix(4)) { fact in NavigationLink { DetailView(collection: "facts", id: fact.id) } label: { RecordRow(item: fact) } }
                    let summary = home["summary"]?.object ?? [:]
                    if let count = summary["proposed_operations"] { LabeledContent("Work proposals", value: count.text) }
                    if let count = summary["proposed_purchases"] { LabeledContent("Purchase proposals", value: count.text) }
                    if let count = summary["proposed_sales"] { LabeledContent("Sales proposals", value: count.text) }
                }
            } else if !store.records("farms").isEmpty {
                Section { Notice("The service's home summary has not loaded. Your saved records and device drafts remain available.", warning: true); Button("Load next steps") { Task { await store.loadHome() } } }
            }
        }.navigationTitle("Home").refreshable { await store.verifyAndRefresh() }
            .task { if store.disk.workflowHome == nil { await store.loadHome() } }
            .sheet(isPresented: $setup) { NavigationStack { FarmSetupView() }.environmentObject(store) }
    }
}

struct WorkflowActionLink: View {
    @EnvironmentObject private var store: AppStore
    let action: [String: JSONValue]
    private var routeURL: URLComponents? { URLComponents(string: action["href"]?.text ?? "") }
    private var components: [String] { (routeURL?.path ?? "").split(separator: "/").map(String.init).filter { $0 != "app" } }
    private var title: String { action["title"]?.text ?? action["label"]?.text ?? "Review information" }
    private var linkedFarm: String? {
        let value = action["farm_id"]?.text ?? routeURL?.queryItems?.first(where: { $0.name == "farm_id" })?.value ?? (components.first == "fields" && components.count > 1 ? components[1] : nil)
        return value.flatMap { store.record("farms", $0) != nil ? $0 : nil }
    }
    private var requestedTaskFarm: String? {
        if let query = routeURL?.queryItems?.first(where: { $0.name == "farm_id" }) { let value = query.value ?? ""; return value.isEmpty ? "invalid-empty-farm-filter" : value }
        if case .string(let id)? = action["farm_id"] { return id.isEmpty ? "invalid-empty-farm-filter" : id }
        return nil
    }
    var body: some View {
        NavigationLink { destination } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.headline)
                if let message = action["message"]?.text { Text(message).font(.subheadline).foregroundStyle(.secondary) }
            }.padding(.vertical, 5)
        }
    }
    @ViewBuilder private var destination: some View {
        if components.first == "cases", components.count > 1, UUID(uuidString: components[1]) != nil {
            CaseDetailView(caseID: components[1])
        } else if components.first == "cases" {
            CaseListView(initialFarmID: linkedFarm)
        } else if components.first == "tasks", components.count > 1, UUID(uuidString: components[1]) != nil {
            TaskAnswerView(taskID: components[1])
        } else if components.first == "tasks", components.count == 1 {
            NativeTaskListView(initialFarmID: requestedTaskFarm).id(requestedTaskFarm ?? "all-task-farms")
        } else if let requestID = action["request_id"]?.text {
            GuidedRequestView(requestID: requestID)
        } else if components.first == "paperwork", components.count > 1, UUID(uuidString: components[1]) != nil {
            DetailView(collection: "requests", id: components[1])
        } else if components.count >= 2, ["requests", "reports", "facts", "documents", "farms", "operations", "purchases", "sales", "tasks", "checklists"].contains(components[0]), UUID(uuidString: components[1]) != nil {
            if components[0] == "requests", action["fact_key"] != nil { GuidedRequestView(requestID: components[1]) }
            else { DetailView(collection: components[0], id: components[1]) }
        } else if components.first == "documents" || action["kind"]?.text == "capture" {
            DocumentIntakeView()
        } else if components.first == "record-work" || components.first == "work" {
            if routeURL?.queryItems?.contains(where: { $0.name == "review" && $0.value == "1" }) == true { WorkListView(farmID: linkedFarm) }
            else { WorkCaptureView(initialFarmID: linkedFarm) }
        } else if components.first == "fields" || components.first == "farm" {
            if routeURL?.fragment == "facts", let farmID = linkedFarm, let farm = store.record("farms", farmID) { FarmDetail(item: farm) }
            else { FieldsView(initialFarmID: linkedFarm) }
        } else if components.first == "requests" || components.first == "paperwork" {
            PaperworkView()
        } else if components.first == "onboard" || components.first == "setup" {
            FarmSetupView()
        } else if components.first == "compliance" || components.first == "checks" {
            FarmComplianceView(initialFarmID: linkedFarm)
        } else if components.first == "tasks" || components.first == "checklists" {
            FarmTaskListView(initialFarmID: linkedFarm)
        } else if components.first == "regulatory" || components.first == "updates" {
            RegulatoryUpdatesView(initialFarmID: linkedFarm)
        } else if components.first == "help" || components.first == "assistant" {
            FarmerHelpView()
        } else if components.first == "community" {
            FarmerCommunityView()
        } else if components.first == "adviser" {
            PrivateAdviceView(initialFarmID: linkedFarm)
        } else {
            List { Notice(action["message"]?.text ?? "Review the related farm or request before continuing."); JSONFields(data: action) }.navigationTitle(title)
        }
    }
}

struct PaperworkView: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        List {
            SyncBanner()
            Section("Start with the job you need") { CaseStartLinks(); NavigationLink("My paperwork cases and recorded history") { CaseListView() }; Notice(CaseTransport.notice) }
            Section {
                NavigationLink { RequestEditor() } label: { Label("Add a request", systemImage: "envelope.open") }
                NavigationLink { ReportComposer() } label: { Label("Prepare a report", systemImage: "doc.richtext") }
            }
            Section("Requests") {
                if store.records("requests").isEmpty { Text("Add the letter or form you need to answer. Its requested facts, country and period guide the next questions.").foregroundStyle(.secondary) }
                ForEach(store.records("requests")) { request in NavigationLink { DetailView(collection: "requests", id: request.id) } label: { RecordRow(item: request) } }
            }
            Section("Reports and responses") {
                if store.records("reports").isEmpty { Text("A prepared report appears here after the service creates its snapshot.").foregroundStyle(.secondary) }
                ForEach(store.records("reports")) { report in NavigationLink { DetailView(collection: "reports", id: report.id) } label: { RecordRow(item: report) } }
            }
            Section("Farm setup and help") {
                NavigationLink("Import existing records") { ImportRecordsView() }
                NavigationLink("Help and assistant connections") { FarmerHelpView() }
                NavigationLink("Country format and connection availability") { CountryAvailabilityView() }
            }
            Section("Farm administration") {
                NavigationLink("Review farm obligations") { FarmComplianceView() }
                NavigationLink("Tasks and checklists") { FarmTaskListView() }
                NavigationLink("Official-source updates") { RegulatoryUpdatesView() }
            }
        }.navigationTitle("Paperwork").refreshable { await store.verifyAndRefresh() }
    }
}

struct FarmSetupView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    var existing: RecordItem? = nil
    @State private var name = ""
    @State private var country = "DE"
    @State private var region = ""
    @State private var farmType = "arable"
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var previous: Set<String> = []
    @State private var working = false
    @State private var problem: String?
    @State private var saved: RecordItem?
    @State private var saveKey = UUID()
    @State private var countryProfile: [String: JSONValue] = [:]
    @State private var profileProblem: String?
    private let countries = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]
    var body: some View {
        Form {
            if saved == nil {
                Section(existing == nil ? "Tell us about your farm" : "Farm details") {
                    TextField("Farm name", text: $name)
                    Picker("Country", selection: $country) { ForEach(countries, id: \.self) { Text(Locale.current.localizedString(forRegionCode: $0) ?? $0).tag($0) } }
                    TextField("Region", text: $region)
                    Picker("Farm type", selection: $farmType) {
                        Text("Arable crops").tag("arable"); Text("Livestock").tag("livestock"); Text("Mixed farm").tag("mixed"); Text("Horticulture").tag("horticulture"); Text("Other").tag("other")
                    }
                    Stepper("Reporting year \(String(year))", value: $year, in: 2000...2100)
                    Notice("Country, region and reporting year determine which source-backed formats can be offered. Farm type describes your context; it does not establish scheme eligibility.")
                    if !countryProfile.isEmpty { DisclosureGroup("Country sources and available coverage") { JSONFields(data: countryProfile) } }
                    if let profileProblem { Notice(profileProblem, warning: true) }
                }
                if !store.records("documents").isEmpty {
                    Section("Previous applications already in your library") {
                        ForEach(store.records("documents").filter { $0.value("farm_id").suppliedValue.isEmpty || $0.value("farm_id") == existing?.id }) { document in
                            Toggle(document.title, isOn: Binding(get: { previous.contains(document.id) }, set: { if $0 { previous.insert(document.id) } else { previous.remove(document.id) } }))
                        }
                        Text("Only choose originals you have checked. Adding a past application is evidence, not a current eligibility decision.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button(existing == nil ? "Save farm and continue" : "Save reviewed farm details") { save() }.buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working || !store.sessionVerified)
                    if working { ProgressView("Saving farm…") }
                    if !store.sessionVerified { Notice("Reconnect before creating or changing the farm. Existing device drafts are preserved.", warning: true) }
                }
            } else {
                Section("Choose where to start") {
                    Text("Your farm is saved. Bring in what you already have, or begin recording your own work.")
                    NavigationLink { DocumentIntakeView() } label: { Label("Add a previous application", systemImage: "doc.badge.plus") }
                    NavigationLink { ImportRecordsView() } label: { Label("Import existing farm records", systemImage: "tray.and.arrow.down") }
                    NavigationLink { AdviserHelpView() } label: { Label("Ask an adviser to help", systemImage: "person.2") }
                    NavigationLink { FieldsView() } label: { Label("Add my fields", systemImage: "map") }
                    Button("Continue to Home") { dismiss() }
                }
            }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle(saved == nil ? (existing == nil ? "Set up my farm" : "Farm details") : "A useful starting point")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(working) } }
            .onAppear {
                if let existing {
                    name = existing.title; country = existing.value("country"); region = existing.value("region").suppliedValue
                    farmType = existing.value("farm_type").isEmpty ? "other" : existing.value("farm_type")
                    if case .number(let number)? = existing.data["reporting_year"] { year = Int(number) }
                }
            }
            .task(id: country) {
                countryProfile = [:]; profileProblem = nil
                let selected = country
                do { let profile = try await store.scopedValue("/countries/\(selected)").object; if country == selected { countryProfile = profile } }
                catch { profileProblem = "The country source profile could not be loaded. Farm setup alone does not establish format availability. \(error.localizedDescription)" }
            }
    }
    private func save() {
        working = true; problem = nil
        Task {
            do {
                var body: [String: JSONValue] = ["name": .string(name), "country": .string(country), "region": region.isEmpty ? .null : .string(region), "farm_type": .string(farmType), "reporting_year": .number(Double(year)), "previous_document_ids": .array(previous.sorted().map(JSONValue.string))]
                if let existing { body["farm_id"] = .string(existing.id); body["expected_revision"] = .number(Double(existing.revision)) }
                let result = try await store.scopedValue("/workflow/onboard", method: "POST", body: body, idempotency: saveKey.uuidString)
                guard let farmValue = result.object["farm"] else { throw ServiceError(status: 0, message: "The service returned no saved farm. No setup completion was assumed.") }
                saved = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(farmValue))
                await store.refresh()
                if existing != nil { dismiss() }
            } catch { problem = error.localizedDescription }
            working = false
        }
    }
}
