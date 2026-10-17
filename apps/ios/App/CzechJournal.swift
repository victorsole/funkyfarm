import SwiftUI

struct CzechJournalView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    var requestID: String? = nil
    var initialYear: Int? = nil
    var initialDefinition: [String: JSONValue]? = nil
    @State private var farmID = ""
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var adding = false
    @State private var applicationSession = UUID()
    @State private var holder = false
    @State private var prepare = false
    @State private var selected: Set<String> = []
    @State private var definition: [String: JSONValue] = [:]
    @State private var problem: String?
    @State private var pageRows: [RecordItem] = []
    @State private var offset = 0
    @State private var totalWork = 0
    @State private var pageLoaded = false
    @State private var loading = false
    @State private var pageLoadID = UUID()
    @State private var definitionLoading = false
    @State private var definitionLoadID = UUID()
    @State private var requestLoading = false
    private var farms: [RecordItem] { store.records("farms").filter { $0.value("country") == "CZ" } }
    private var entries: [RecordItem] { pageRows.compactMap { store.record("operations", $0.id) ?? $0 }.filter { $0.value("farm_id") == farmID && CzechJournalData.isEntry($0) && CzechJournalData.year($0) == year } }
    private var holders: [RecordItem] { store.records("facts").filter { $0.value("farm_id") == farmID && $0.value("key") == CzechJournalData.holderKey } }
    private var linkedRequest: RecordItem? {
        guard let requestID, let request = store.record("requests", requestID), request.id == requestID,
              request.workspace_id == store.account?.workspace.id, request.value("farm_id") == farmID,
              request.value("pack_id") == CzechJournalData.pack, SourceText.year(request.data["reporting_year"]) == String(year) else { return nil }
        return request
    }
    var body: some View {
        List {
            Section("Czech crop-protection journal") {
                Picker("Farm", selection: $farmID) { Text("Choose a Czech farm").tag(""); ForEach(farms) { Text($0.title).tag($0.id) } }.disabled(requestID != nil)
                Stepper("Journal year \(String(year))", value: $year, in: 2000...2200).disabled(requestID != nil)
                Notice("Record actual repeated applications, then complete and review each one. This prepares a manual journal, not JUDPOR transmission or a legal-compliance certificate.")
                Button("Add another actual application") { applicationSession = UUID(); adding = true }.buttonStyle(.borderedProminent).disabled(farmID.isEmpty)
                NavigationLink("Device drafts and unsent applications") { OutboxView() }
                if let counts = definition["counts"]?.object {
                    ForEach(["total", "confirmed", "proposed", "incomplete", "pending"], id: \.self) { key in if let count = counts[key] { LabeledContent("Last loaded service count: " + key, value: count.text) } }
                }
            }
            if requestID != nil { completionMetadata }
            Section("Holder identity — separate fact review") {
                if holders.isEmpty { Notice("No holder identity is recorded. It is not inferred from the farm name.", warning: true) }
                ForEach(holders) { fact in
                    NavigationLink { DetailView(collection: "facts", id: fact.id) } label: { VStack(alignment: .leading) { Text(CzechJournalData.text(fact.data["value"]?.object["name"]).isEmpty ? "Holder proposal" : CzechJournalData.text(fact.data["value"]?.object["name"])); Text(fact.state + " · revision \(fact.revision)").font(.caption) } }
                    if fact.state == "proposed" || (fact.state == "confirmed" && fact.data["superseded_by"] == nil) { NavigationLink(fact.state == "confirmed" ? "Propose a holder correction" : "Complete holder proposal") { CzechHolderEditor(farmID: farmID, existing: fact) } }
                }
                if !holders.contains(where: { ["confirmed", "proposed"].contains($0.state) && $0.data["superseded_by"] == nil }) { Button("Enter a holder from the source") { holder = true }.disabled(farmID.isEmpty) }
                else { Text("Use the existing proposal or correction link above instead of creating another holder identity.").font(.footnote) }
            }
            Section("Application entries — separate identities") {
                if loading { ProgressView("Loading this farm work page…") }
                if !pageLoaded { Notice("This farm work page is unavailable or has not loaded. It is not an empty or complete journal.", warning: true); Button("Retry this farm work page") { Task { await loadPage(offset) } }.disabled(loading || !store.sessionVerified || farmID.isEmpty) }
                else {
                Text(pageRows.isEmpty ? "The service returned no farm work records for this range." : "Farm work items \(offset + 1)–\(offset + pageRows.count) of \(totalWork). Only this page's Czech applications in \(String(year)) appear below.").font(.footnote)
                if entries.isEmpty { Text("No matching journal applications occur on this loaded work page. Other work pages may contain them.").foregroundStyle(.secondary) }
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        NavigationLink { CzechApplicationDetail(initial: entry) } label: { RecordRow(item: entry) }
                        Text(entry.value("date") + " · " + entry.value("product")).font(.caption)
                        ForEach(Array((entry.journal_issues ?? []).enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? "Complete and check this entry.", warning: true) }
                        if entry.state == "confirmed", CzechJournalData.isActive(entry) { Toggle("Include this reviewed active application", isOn: Binding(get: { selected.contains(entry.id) }, set: { if $0 { selected.insert(entry.id) } else { selected.remove(entry.id) } })) }
                        else { Text(entry.active == false ? "Retained superseded history — not selected for a new journal" : entry.active == nil ? "Current active identity is not established. Reload this page before selection." : "Complete and separately confirm this proposal before selection").font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                HStack {
                    Button("Previous farm work page") { Task { await loadPage(max(0, offset - 20)) } }.disabled(loading || offset == 0)
                    Spacer()
                    Button("Next farm work page") { Task { await loadPage(offset + pageRows.count) } }.disabled(loading || pageRows.isEmpty || offset + pageRows.count >= totalWork)
                }
                }
            }
            Section("Prepare selected entries") {
                Text("\(selected.count) applications explicitly selected. Entries are not grouped by field or date, and none are included automatically.")
                Button("Prepare journal from selected applications") { if requestID == nil || linkedRequest != nil { prepare = true } }.disabled(selected.isEmpty || !store.sessionVerified || loading || !pageLoaded || requestLoading || (requestID != nil && linkedRequest == nil))
                if requestID == nil { Text("No letter is linked. Check this journal before approving it.").font(.footnote) }
                else if linkedRequest == nil {
                    Notice("The linked letter has not loaded or no longer matches this farm and year. Reload it before preparing the journal; it will not be replaced with a letterless preview.", warning: true)
                    Button("Reload the exact linked letter") { Task { await reloadLinkedRequest() } }.disabled(requestLoading || !store.sessionVerified)
                }
                Button("Refresh saved entries, holder reviews and completion counts") { Task { await refresh() } }.disabled(store.busy)
                if let problem { Notice(problem, warning: true) }
            }
            Section("Journal previews and retained issued reports") {
                let reports = store.records("reports").filter { $0.value("farm_id") == farmID && $0.value("pack_id") == CzechJournalData.pack && SourceText.year($0.data["reporting_year"]) == String(year) }
                if reports.isEmpty { Text("No journal preview is loaded for this farm and year. Preparing a selection creates a draft, not an approval.").foregroundStyle(.secondary) }
                ForEach(reports) { report in NavigationLink { DetailView(collection: "reports", id: report.id) } label: { RecordRow(item: report) } }
            }
        }.navigationTitle("Czech journal")
            .onAppear { if farmID.isEmpty { farmID = initialFarmID ?? (farms.count == 1 ? farms[0].id : ""); year = initialYear ?? year; definition = initialDefinition ?? [:] }; reconcile() }
            .onChange(of: farmID) { _ in selected = [] }
            .onChange(of: year) { _ in selected = [] }
            .onChange(of: store.records("operations")) { _ in reconcile() }
            .task(id: farmID + ":" + String(year)) { guard !farmID.isEmpty else { return }; if requestID != nil && linkedRequest == nil { await reloadLinkedRequest() }; await loadPage(0); if requestID != nil { await loadDefinition(0) } }
            .sheet(isPresented: $adding) { NavigationStack { CzechApplicationEditor(farmID: farmID).id(applicationSession) }.environmentObject(store) }
            .sheet(isPresented: $holder) { NavigationStack { CzechHolderEditor(farmID: farmID) }.environmentObject(store) }
            .sheet(isPresented: $prepare) {
                NavigationStack {
                    if requestID == nil { ReportComposer(initialFarmID: farmID, initialPackID: CzechJournalData.pack, initialYear: year, initialOperationIDs: selected) }
                    else if let linkedRequest { ReportComposer(request: linkedRequest, initialFarmID: farmID, initialPackID: CzechJournalData.pack, initialYear: year, initialOperationIDs: selected) }
                    else { List { Notice("The linked letter is unavailable. Close this preview and reload that exact letter before continuing.", warning: true); Button("Close") { prepare = false } } }
                }.environmentObject(store)
            }
    }
    private func reconcile() { selected.formIntersection(Set(store.records("operations").filter { $0.value("farm_id") == farmID && CzechJournalData.year($0) == year && $0.state == "confirmed" && CzechJournalData.isActive($0) }.map(\.id))) }
    private func refresh() async {
        await store.verifyAndRefresh(); reconcile()
        if requestID != nil && linkedRequest == nil { await reloadLinkedRequest() }
        await loadPage(offset)
        if requestID != nil { await loadDefinition(0) } else { definition = [:] }
    }
    private func reloadLinkedRequest() async {
        guard let requestID, !requestLoading else { return }
        requestLoading = true; defer { requestLoading = false }
        do {
            _ = try await store.refreshDetail("requests", requestID)
            guard linkedRequest != nil else { throw ServiceError(status: 409, message: "The linked letter now has a different farm, reporting year or journal format. Return to its details before preparing a new selection.") }
        } catch { problem = SourceText.error(error) }
    }
    private var completionMetadata: some View {
        Section("Paged service completion notes") {
            if definitionLoading { ProgressView("Loading completion notes…") }
            if let page = definition["pagination"]?.object {
                Text("Completion metadata offset " + (page["offset"]?.text ?? "unavailable") + "; " + String(definition["entries"]?.array.count ?? 0) + " loaded of " + (page["total"]?.text ?? "unavailable") + ". Counts above cover the service's full active year ledger, not just this metadata page.").font(.footnote)
                ForEach(Array((definition["entries"]?.array ?? []).enumerated()), id: \.offset) { _, entry in
                    if let id = entry.object["operation_id"]?.text, UUID(uuidString: id) != nil { NavigationLink(entry.object["title"]?.text ?? "Open application completion") { DetailView(collection: "operations", id: id) } }
                }
                HStack {
                    Button("Previous completion notes") { if let value = SourceText.year(page["offset"]).flatMap({ Int($0) }) { Task { await loadDefinition(max(0, value - 20)) } } }.disabled(definitionLoading || page["offset"] == .number(0))
                    Spacer()
                    Button("Next completion notes") { if let value = SourceText.year(page["next_offset"]).flatMap({ Int($0) }) { Task { await loadDefinition(value) } } }.disabled(definitionLoading || page["next_offset"] == .null || page["next_offset"] == nil)
                }
            } else { Notice("Completion metadata is not loaded; no completion claim is inferred.", warning: true); Button("Retry completion notes") { Task { await loadDefinition(0) } }.disabled(definitionLoading || !store.sessionVerified) }
        }
    }
    private func loadPage(_ requested: Int) async {
        let stamp = UUID(), selectedFarm = farmID, selectedYear = year; pageLoadID = stamp; loading = true; pageLoaded = false; pageRows = []; offset = requested; problem = nil
        defer { if stamp == pageLoadID { loading = false } }
        guard !selectedFarm.isEmpty else { return }
        do {
            let page = try await store.operationPage(farmID: selectedFarm, offset: requested)
            guard stamp == pageLoadID, selectedFarm == farmID, selectedYear == year, !Task.isCancelled else { return }
            pageRows = page.items; totalWork = page.total; pageLoaded = true; reconcile()
        } catch { if stamp == pageLoadID { problem = SourceText.error(error) } }
    }
    private func loadDefinition(_ requested: Int) async {
        guard let requestID else { definition = [:]; return }
        let stamp = UUID(); definitionLoadID = stamp; definitionLoading = true; definition = [:]
        defer { if stamp == definitionLoadID { definitionLoading = false } }
        do {
            let response = try await store.scopedValue("/workflow/questions?request_id=\(requestID)&journal_limit=20&journal_offset=\(requested)")
            guard stamp == definitionLoadID, !Task.isCancelled, let value = response.object["journals"]?.array.first(where: { $0.object["schema_id"] == .string(CzechJournalData.schema) })?.object, case .array(let entries)? = value["entries"], let total = SourceText.year(value["pagination"]?.object["total"]).flatMap({ Int($0) }), value["pagination"]?.object["offset"] == .number(Double(requested)), value["pagination"]?.object["limit"] == .number(20), entries.count <= 20, requested + entries.count <= total, !entries.isEmpty || requested == total else { throw ServiceError(status: 0, message: "The completion metadata page was unavailable or did not establish its exact range.") }
            let next = requested + entries.count
            guard value["pagination"]?.object["next_offset"] == (next < total ? .number(Double(next)) : .null) else { throw ServiceError(status: 0, message: "The next completion metadata range was not established.") }
            definition = value
        } catch { if stamp == definitionLoadID { problem = SourceText.error(error) } }
    }
}

struct CzechApplicationDetail: View {
    @EnvironmentObject private var store: AppStore
    let initial: RecordItem
    @State private var note = ""
    @State private var check: CaptureCheck?
    @State private var checkedRevision: Int?
    @State private var busy = false
    @State private var problem: String?
    @State private var confirm = false
    @State private var correction: RecordItem?
    @State private var acknowledged: Set<String> = []
    @State private var decision = "confirmed"
    @State private var reports: [RecordItem]?
    private var current: RecordItem { store.record("operations", initial.id) ?? initial }
    var body: some View {
        List {
            Section("Actual application identity") {
                Text(current.title).font(.title2.bold())
                LabeledContent("Application", value: current.id).font(.caption).textSelection(.enabled)
                LabeledContent("Revision", value: String(current.revision)); LabeledContent("Review state", value: current.state)
                CzechStructuredValues(data: current.data.filter { ["date", "product", "crop", "dose", "dose_unit", "treated_size", "treated_unit", "quantity", "unit", "operator"].contains($0.key) })
                if let details = current.data["cz_ppp"]?.object { CzechStructuredValues(data: details) }
                ForEach(Array((current.journal_issues ?? []).enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? "Complete and check this journal entry.", warning: true) }
                ReportSourceLinks(sources: current.data["sources"]?.array ?? [])
            }
            Section("Complete, check, then confirm") {
                if current.state == "proposed" {
                    NavigationLink("Complete or edit this proposed application") { CzechApplicationEditor(farmID: current.value("farm_id"), existing: current) }
                    Button("Check this current entry") { checkCurrent() }.disabled(busy || !store.sessionVerified)
                    if let check {
                        ForEach(Array(check.issues.enumerated()), id: \.offset) { _, issue in Notice(issue.message, warning: issue.severity == "error") }
                        ForEach(check.requires_acknowledgement, id: \.self) { code in Toggle(check.issues.first { $0.code == code }?.message ?? code, isOn: Binding(get: { acknowledged.contains(code) }, set: { if $0 { acknowledged.insert(code) } else { acknowledged.remove(code) } })) }
                    }
                    TextField("What source and pending follow-ups did you check?", text: $note, axis: .vertical)
                    Button("Confirm this application separately") { decision = "confirmed"; confirm = true }.buttonStyle(.borderedProminent).disabled(busy || !store.sessionVerified || checkedRevision != current.revision || check?.can_save != true || !Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged) || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Reject this application proposal", role: .destructive) { decision = "rejected"; confirm = true }.disabled(busy || !store.sessionVerified || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Notice("Pending efficacy or crop-end dates remain pending after record confirmation. Journal approval still runs the current completion and source checks.")
                } else if current.state == "confirmed", CzechJournalData.isActive(current) {
                    Button("Propose a separate correction successor") {
                        busy = true; problem = nil
                        Task { do { let fresh = try await store.refreshDetail("operations", current.id); guard fresh.state == "confirmed", CzechJournalData.isActive(fresh) else { throw ServiceError(status: 409, message: "This application changed. Review its current successor before correcting it.") }; correction = fresh } catch { problem = SourceText.error(error) }; busy = false }
                    }.disabled(busy || !store.sessionVerified)
                }
                if let id = current.data["supersedes_id"]?.text { NavigationLink("Compare the retained predecessor") { DetailView(collection: "operations", id: id) } }
                if let id = current.confirmed_successor_id { NavigationLink("Open confirmed successor") { DetailView(collection: "operations", id: id) } }
                Notice("Confirmed originals and issued reports remain in history. A successor proposal does not silently retire a confirmed application.")
                if busy { ProgressView("Checking this entry…") }
                if let problem { Notice(problem, warning: true) }
            }
            Section("Reports retaining this application") {
                Button("Load affected report summaries") {
                    busy = true; problem = nil
                    Task { do { let value = try await store.scopedValue("/operations/\(current.id)/reports"); reports = try JSONDecoder().decode(RecordPage.self, from: JSONEncoder().encode(value)).items } catch { problem = SourceText.error(error) }; busy = false }
                }.disabled(busy || !store.sessionVerified)
                if let reports {
                    if reports.isEmpty { Text("The service found no linked reports.") }
                    ForEach(reports) { report in NavigationLink { DetailView(collection: "reports", id: report.id) } label: { RecordRow(item: report) } }
                } else { Text("Affected reports have not been loaded; none are assumed absent.").font(.footnote) }
            }
        }.navigationTitle("Review application")
            .task { do { _ = try await store.refreshDetail("operations", initial.id) } catch { problem = SourceText.error(error) } }
            .onChange(of: current.revision) { _ in check = nil; checkedRevision = nil; acknowledged = [] }
            .confirmationDialog(decision == "confirmed" ? "Confirm this exact application revision and its checked source?" : "Reject this application proposal?", isPresented: $confirm, titleVisibility: .visible) { Button(decision == "confirmed" ? "Confirm application" : "Reject proposal", role: decision == "rejected" ? .destructive : nil) { review() } }
            .sheet(item: $correction) { predecessor in NavigationStack { CzechApplicationEditor(farmID: predecessor.value("farm_id"), correction: predecessor) }.environmentObject(store) }
    }
    private func checkCurrent() {
        busy = true; problem = nil; check = nil; checkedRevision = nil; acknowledged = []
        Task {
            do {
                let fresh = try await store.refreshDetail("operations", current.id)
                let body: [String: JSONValue] = ["kind": .string("operations"), "record_id": .string(fresh.id), "expected_revision": .number(Double(fresh.revision)), "data": .object(fresh.data.filter { CzechJournalData.operationKeys.contains($0.key) })]
                let result = try await store.checkCapture(body)
                guard current.revision == fresh.revision else { throw ServiceError(status: 409, message: "The entry changed during the check. Check the current revision again.") }
                check = result; checkedRevision = fresh.revision
            } catch { problem = SourceText.error(error) }
            busy = false
        }
    }
    private func review() {
        guard store.sessionVerified, current.state == "proposed", !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if decision == "confirmed" { guard checkedRevision == current.revision, check?.can_save == true, Set(check?.requires_acknowledgement ?? []).isSubset(of: acknowledged) else { return } }
        busy = true; problem = nil
        Task { do { try await store.mutate("/operations/\(current.id)/review", body: ["expected_revision": .number(Double(current.revision)), "decision": .string(decision), "note": .string(note)]); check = nil; checkedRevision = nil; acknowledged = [] } catch { problem = SourceText.error(error) }; busy = false }
    }
}
