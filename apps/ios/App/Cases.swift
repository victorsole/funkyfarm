import SwiftUI
import UIKit

enum CaseJob: String, CaseIterable {
    case fields, correction, inspection
    var title: String { switch self { case .fields: return "Check my fields"; case .correction: return "Correct a submitted mistake"; case .inspection: return "Prepare for an inspection" } }
    var explanation: String { switch self { case .fields: return "Compare the actual field records and save a reviewed field-change proposal before preparing a response."; case .correction: return "Keep the original submission reference, explain the mistake and select the actual correction or approved response."; case .inspection: return "Start with the notice or request. List the records requested, findings and follow-up actions, with evidence for each resolved item." } }
}

enum CaseSource: String, CaseIterable {
    case documents, requests, reports, fieldChanges = "field_change_proposals", facts, operations, checklists, tasks
    var title: String { switch self { case .documents: return "Documents"; case .requests: return "Letters and requests"; case .reports: return "Reports"; case .fieldChanges: return "Field-change proposals"; case .facts: return "Farm facts"; case .operations: return "Work records"; case .checklists: return "Checklists"; case .tasks: return "Tasks" } }
    func path(_ id: String) -> String { self == .fieldChanges ? "/field-proposals/\(id)" : "/\(rawValue)/\(id)" }
    func page(farmID: String, offset: Int) -> String { self == .fieldChanges ? "/farms/\(farmID)/field-proposals?limit=5&offset=\(offset)" : "/\(rawValue)?farm_id=\(farmID)&limit=5&offset=\(offset)" }
}

struct CaseReference: Hashable {
    let source: CaseSource
    let id: String
    let revision: Int
    let role: String
    var title: String
    var identity: String { source.rawValue + ":" + id + ":" + role }
    var wire: JSONValue { .object(["kind": .string(source.rawValue), "id": .string(id), "revision": .number(Double(revision)), "role": .string(role)]) }
    var saved: JSONValue { var value = wire.object; value["display_title"] = .string(title); return .object(value) }
    init(source: CaseSource, record: RecordItem, role: String) { self.source = source; id = record.id; revision = record.revision; self.role = role; title = record.title }
    init?(_ value: JSONValue) {
        let data = value.object
        guard let source = CaseSource(rawValue: data["kind"]?.text ?? ""), let id = data["id"]?.text, UUID(uuidString: id) != nil, let revision = SourceText.year(data["revision"]).flatMap({ Int($0) }), revision > 0, let role = data["role"]?.text, ["original", "notice", "change", "response", "evidence"].contains(role) else { return nil }
        self.source = source; self.id = id; self.revision = revision; self.role = role; title = data["display_title"]?.text ?? data["title"]?.text ?? source.title
    }
}

enum CaseTransport {
    static func answer(_ value: JSONValue?) -> String { guard let value else { return "Not recorded" }; switch value { case .null: return "Not recorded"; case .string(let raw): return raw.isEmpty ? "Empty recorded text" : raw; case .bool(let flag): return flag ? "Yes" : "No"; default: return SourceText.literal(value) } }
    static let notice = "Sending and response statuses are recorded by a person, not verified with an authority. Preparation, app review and downloads do not submit anything or establish legal completeness."
    @MainActor static func record(_ value: JSONValue, store: AppStore) throws -> RecordItem {
        let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value))
        guard record.kind == "admin_cases", record.workspace_id == store.account?.workspace.id else { throw ServiceError(status: 0, message: "The case did not match this private workspace. Nothing was saved locally.") }
        return record
    }
    static func state(_ raw: String) -> String {
        ["draft": "Draft — not sent", "ready_to_send": "Reviewed for my own next step — not sent", "sent": "Sending recorded by a person", "receipt_saved": "Receipt recorded by a person", "needs_changes": "Changes requested / work reopened", "accepted_recorded": "Decision recorded by a person — not verified", "cancelled": "Cancelled in this workspace"][raw] ?? raw.replacingOccurrences(of: "_", with: " ")
    }
    static func nextAction(_ value: JSONValue?) -> String { guard let value else { return "Load the current source checks before reviewing this case." }; if case .string(let text) = value { return text }; return value.object["title"]?.text ?? value.object["label"]?.text ?? value.object["message"]?.text ?? "Review the current source checks and remaining items." }
    struct PacketBinding { let caseID: String; let revision: Int; let retained: Bool; let fingerprint: String }
    struct Download: Identifiable {
        let id: String; let label: String; let path: String; let suffix: String
        let packetBinding: PacketBinding?
        var isPacket: Bool { packetBinding != nil }
        var maximumBytes: Int64 { isPacket ? 128 * 1024 * 1024 : ProtectedFileTransfer.maximumBytes }
        func matches(caseID: String, fingerprint: JSONValue?, origin: JSONValue?, revision: JSONValue?) -> Bool {
            guard let binding = packetBinding else { return true }
            return binding.caseID == caseID && fingerprint == .string(binding.fingerprint) && revision == .number(Double(binding.revision)) && origin == .string(binding.retained ? "sealed_sent_bundle" : "current_review")
        }
    }
    static func download(_ value: JSONValue) -> Download? {
        guard let raw = value.object["href"]?.text, var url = URLComponents(string: raw), url.scheme == nil, url.host == nil, url.user == nil, url.password == nil, url.fragment == nil else { return nil }
        var parts = url.path.split(separator: "/").map(String.init)
        if parts.starts(with: ["api", "v1"]) { parts.removeFirst(2) }
        guard parts.count == 3, UUID(uuidString: parts[1]) != nil, let query = url.queryItems, Set(query.map(\.name)).count == query.count else { return nil }
        let suffix: String
        var packetBinding: PacketBinding? = nil
        if parts[0] == "cases" && parts[2] == "packet" {
            let versions = query.filter { ["expected_revision", "retained_revision"].contains($0.name) }
            guard query.count == 2, versions.count == 1, query.allSatisfy({ ["expected_revision", "retained_revision", "reference_fingerprint"].contains($0.name) }), let rawRevision = versions.first?.value, rawRevision.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil, let revision = Int(rawRevision), revision > 0, let fingerprint = query.first(where: { $0.name == "reference_fingerprint" })?.value, fingerprint.utf8.count == 64, fingerprint.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
            suffix = "zip"
            packetBinding = PacketBinding(caseID: parts[1], revision: revision, retained: versions[0].name == "retained_revision", fingerprint: fingerprint)
        } else if parts[0] == "reports" && parts[2] == "download" {
            guard query.count == 1, query[0].name == "format", let format = query[0].value, ["pdf", "csv", "json", "xlsx"].contains(format) else { return nil }; suffix = format
        } else if parts[0] == "field-proposals" && parts[2] == "export" {
            let versions = query.filter { ["expected_revision", "retained_revision"].contains($0.name) }
            guard query.count == 2, let format = query.first(where: { $0.name == "format" })?.value, ["geojson", "correction", "kml"].contains(format), versions.count == 1, let rawRevision = versions.first?.value, let revision = Int(rawRevision), revision > 0 else { return nil }; suffix = format == "correction" ? "json" : format
        }
        else { return nil }
        url.path = "/" + parts.joined(separator: "/")
        return Download(id: raw, label: value.object["label"]?.text ?? "Download selected file", path: url.string ?? "", suffix: suffix, packetBinding: packetBinding)
    }
}

struct CaseDetailView: View {
    @EnvironmentObject private var store: AppStore
    let caseID: String
    @State private var checks: [String: JSONValue]?
    @State private var acknowledged = false
    @State private var reviewDialog = false
    @State private var busy = false
    @State private var problem: String?
    @State private var edit = false
    @State private var addItem = false
    @State private var selectedItem: CaseItemSelection?
    @State private var handoff = false
    @State private var event = false
    @State private var history: [RecordItem] = []
    @State private var historyOffset = 0
    @State private var historyTotal = 0
    @State private var historyLoaded = false
    @State private var detailLoaded = false
    private var current: RecordItem? { store.record("cases", caseID) }
    private var editable: Bool { detailLoaded && (current.map { ["draft", "needs_changes"].contains($0.state) } ?? false) }
    private var checksCurrent: Bool { guard let current, let checks else { return false }; return checks["case_id"] == .string(caseID) && checks["case_revision"] == .number(Double(current.revision)) && !(checks["fingerprint"]?.text ?? "").isEmpty }
    var body: some View {
        List {
            if let current {
                Section {
                    Text(current.title).font(.title2.bold()); Text(CaseTransport.state(current.state)).font(.headline)
                    if let job = CaseJob(rawValue: current.value("job_type")) { Text(job.explanation) }
                    Text(CaseTransport.nextAction(checks?["next_action"]))
                    Notice(current.data["external_status_notice"]?.text ?? CaseTransport.notice)
                    ForEach(["authority", "scheme", "reporting_year", "deadline", "original_reference", "original_submitted_at", "reason"], id: \.self) { key in if let value = current.data[key], value != .null { LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: value.text) } }
                    Button("Reload current case") { Task { await load() } }.disabled(busy || !store.sessionVerified)
                    if editable { Button("Edit draft details and selected sources") { edit = true }.disabled(busy || !store.sessionVerified) }
                    if current.value("job_type") == "correction" { FocusedParcelLink(record: current, destination: .correction, contextLoaded: detailLoaded && !busy) }
                }
                sourceSection(current)
                itemSection(current)
                reviewSection(current)
                Section("My sending and response records") {
                    Button("Record what I actually sent or received") { event = true }.disabled(busy || !detailLoaded || !store.sessionVerified)
                    Notice("An app status is not a delivery receipt or verified authority decision. Record the real date, reference and same-farm evidence document.")
                    if !historyLoaded { Text("History is not loaded; no absence of activity is inferred.").font(.footnote) }
                    ForEach(history) { event in
                        DisclosureGroup(event.value("action").replacingOccurrences(of: "_", with: " ").capitalized + " · " + event.value("date")) {
                            SourceRowCells(value: event.data.filter { !["sealed_bundle"].contains($0.key) })
                            if event.data["sealed_bundle"] != nil { Notice("This event retains the reviewed bundle and original source revisions used when sending was recorded. Current edits do not rewrite that history.") }
                            if let documentID = event.data["document_id"]?.text, UUID(uuidString: documentID) != nil { NavigationLink("Open the recorded response evidence") { DetailView(collection: "documents", id: documentID) } }
                            NavigationLink("Load this exact immutable history entry") { CaseHistoryDetail(caseID: caseID, eventID: event.id, farmID: current.value("farm_id")) }
                        }
                    }
                    Button(historyLoaded ? "Reload this history page" : "Load immutable history") { Task { await loadHistory(historyOffset) } }.disabled(busy || !store.sessionVerified)
                    if historyLoaded { Text("History \(historyOffset) offset · \(history.count) of \(historyTotal) loaded").font(.footnote); HStack { Button("Previous history") { Task { await loadHistory(max(0, historyOffset - 20)) } }.disabled(busy || historyOffset == 0); Spacer(); Button("Next history") { Task { await loadHistory(historyOffset + history.count) } }.disabled(busy || history.isEmpty || historyOffset + history.count >= historyTotal) } }
                }
            } else { Section { Notice("This case has not loaded. A saved draft is not a current authorized case.", warning: true); Button("Load case") { Task { await load() } }.disabled(busy || !store.sessionVerified) } }
            if !store.sessionVerified { Notice("Reconnect before reviewing sources, preparing a handoff or recording an event. Private device drafts remain available.", warning: true) }
            if busy { ProgressView("Loading or saving the current case…") }
            if let problem { Notice(problem, warning: true) }
        }.navigationTitle("Paperwork case").task(id: caseID) { await load() }
            .onChange(of: current?.revision) { revision in if let revision, checks?["case_revision"] != .number(Double(revision)) { checks = nil; acknowledged = false } }
            .onChange(of: store.sessionVerified) { verified in if !verified { checks = nil; acknowledged = false; detailLoaded = false; history = []; historyLoaded = false } }
            .onChange(of: store.account?.scope) { _ in checks = nil; acknowledged = false; detailLoaded = false; history = []; historyLoaded = false }
            .confirmationDialog("Record my review of this exact case and source fingerprint? Nothing will be sent.", isPresented: $reviewDialog, titleVisibility: .visible) { Button("Record my preparation review") { review() } }
            .sheet(isPresented: $edit, onDismiss: { Task { await load() } }) { if let current, let job = CaseJob(rawValue: current.value("job_type")) { NavigationStack { CaseEditor(job: job, initialFarmID: current.value("farm_id"), existing: current) }.environmentObject(store) } }
            .sheet(isPresented: $addItem, onDismiss: { Task { await load() } }) { if let current { NavigationStack { CaseItemEditor(parent: current) }.environmentObject(store) } }
            .sheet(item: $selectedItem, onDismiss: { Task { await load() } }) { selection in if let current { NavigationStack { CaseItemEditor(parent: current, item: selection.value) }.environmentObject(store) } }
            .sheet(isPresented: $event, onDismiss: { Task { await load(); await loadHistory(0) } }) { if let current { NavigationStack { CaseEventEditor(parent: current) }.environmentObject(store) } }
            .sheet(isPresented: $handoff) { if let current { NavigationStack { CaseHandoffView(parent: current) }.environmentObject(store) } }
    }
    private func sourceSection(_ current: RecordItem) -> some View {
        Section("The selected source revisions") {
            if let values = checks?["references"]?.array, checksCurrent {
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                    if let reference = CaseReference(value) {
                        VStack(alignment: .leading) {
                            Text(value.object["title"]?.text ?? reference.title).font(.headline)
                            Text(reference.role + " · pinned revision \(reference.revision) · current revision " + (value.object["current_revision"]?.text ?? "unavailable")).font(.caption)
                            if value.object["current"] != .bool(true) { Notice("This selected source is stale or unavailable. It cannot establish readiness.", warning: true) }
                            NavigationLink("Open the current source (not a replacement of the pinned revision)") { CaseReferenceView(reference: reference, farmID: current.value("farm_id")) }
                        }
                    }
                }
            } else {
                Notice("Current source checks have not loaded. The saved selections below are pins, not proof they are still current.", warning: true)
                ForEach((current.data["references"]?.array ?? []).compactMap(CaseReference.init), id: \.identity) { reference in Text(reference.title + " · " + reference.role + " · revision \(reference.revision)") }
            }
            if current.value("job_type") == "fields" { NavigationLink("Review fields and make a real change proposal") { FieldsView(initialFarmID: current.value("farm_id")) }; Text("Advanced drawing, split, merge and LPIS editing open the actual web editor from My fields with separate sign-in; they are not simulated here.").font(.footnote) }
        }
    }
    private func itemSection(_ current: RecordItem) -> some View {
        Section("Requested records, findings and actions") {
            let items = current.data["items"]?.array ?? []
            if !detailLoaded { Notice("Complete follow-up details have not loaded. Saved or missing rows do not establish readiness.", warning: true) }
            else if items.isEmpty { Text("No structured follow-ups are recorded. This does not mean a national inspection requires none.").font(.footnote) }
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.object["title"]?.text ?? "Follow-up item").font(.headline)
                    LabeledContent("Kind", value: (item.object["kind"]?.text ?? "").replacingOccurrences(of: "_", with: " "))
                    LabeledContent("Recorded state", value: (item.object["status"]?.text ?? "unavailable").replacingOccurrences(of: "_", with: " "))
                    if let description = item.object["description"], description != .null { Text(description.text) }
                    if let due = item.object["due_date"], due != .null { LabeledContent("Recorded due date", value: due.text) }
                    ForEach(Array((item.object["document_pins"]?.array ?? []).enumerated()), id: \.offset) { _, pin in if let id = pin.object["id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Evidence document · revision " + (pin.object["revision"]?.text ?? "unavailable")) { DetailView(collection: "documents", id: id) } } }
                    if editable { Button("Review this follow-up") { selectedItem = CaseItemSelection(value: item.object) }.disabled(busy || !store.sessionVerified) }
                }
            }
            if editable { Button("Add a requested record, finding or action") { addItem = true }.disabled(busy || !store.sessionVerified || items.count >= 100) }
            Notice("Every unresolved visible item blocks this app's preparation review. Resolving one needs an actual note and evidence; it is not certification of a legal duty.")
        }
    }
    private func reviewSection(_ current: RecordItem) -> some View {
        Section("Check, then explicitly review") {
            Button("Check the current case and selected source revisions") { Task { await loadChecks() } }.disabled(busy || !detailLoaded || !store.sessionVerified)
            if checksCurrent, let checks {
                ForEach(Array((checks["issues"]?.array ?? []).enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? "Review the current case issue.", warning: issue.object["severity"]?.text == "error") }
                Notice(checks["notice"]?.text ?? CaseTransport.notice)
                Notice("Documents selected here, attached to completed items or selected in approved reports are included. Other private source files stay in your workspace.")
                Toggle("I checked this exact case, its sources and remaining follow-ups", isOn: $acknowledged).disabled(!editable || checks["can_review"] != .bool(true) || busy || !store.sessionVerified)
                Button("Record my preparation review — do not send") { reviewDialog = true }.buttonStyle(.borderedProminent).disabled(!editable || checks["can_review"] != .bool(true) || !acknowledged || busy || !store.sessionVerified)
            } else { Notice("Review is unavailable until the complete current checks and fingerprint load. Unloaded checks are not treated as clear.", warning: true) }
            if let review = current.data["review"], review != .null { DisclosureGroup("Recorded preparation review") { SourceRowCells(value: review.object) } }
            Button("Open the service-checked handoff and copyable answers") { handoff = true }.disabled(busy || !store.sessionVerified || (current.state != "ready_to_send" && UUID(uuidString: current.value("sent_event_id")) == nil))
        }
    }
    private func load() async {
        busy = true; detailLoaded = false; problem = nil; checks = nil; acknowledged = false
        do { let item = try await store.refreshDetail("cases", caseID); guard item.kind == "admin_cases", case .array(_)? = item.data["references"], case .array(_)? = item.data["items"] else { throw ServiceError(status: 0, message: "The complete case details did not load. Reload before changing this case.") }; detailLoaded = true } catch { problem = SourceText.error(error) }
        busy = false
    }
    private func loadChecks() async {
        guard detailLoaded, let before = current else { problem = "Load the complete current case before checking its source selection."; return }
        busy = true; problem = nil; checks = nil; acknowledged = false
        defer { busy = false }
        do {
            let value = try await store.scopedValue("/cases/\(caseID)/checks").object
            guard store.sessionVerified, detailLoaded, !Task.isCancelled, current?.revision == before.revision, value["case_id"] == .string(caseID), value["case_revision"] == .number(Double(before.revision)), let fingerprint = value["fingerprint"]?.text, !fingerprint.isEmpty, case .array(_)? = value["issues"], case .array(_)? = value["references"], case .bool(_)? = value["can_review"] else { throw ServiceError(status: 409, message: "The complete checks did not match this exact case revision. Reload before reviewing.") }
            checks = value
        } catch { problem = SourceText.error(error) }
    }
    private func review() {
        guard let current, editable, checksCurrent, let checks, checks["can_review"] == .bool(true), acknowledged, store.sessionVerified else { return }
        let body: [String: JSONValue] = ["expected_revision": .number(Double(current.revision)), "expected_fingerprint": checks["fingerprint"]!, "acknowledged": .bool(true)]
        let formKey = "case-review:" + caseID
        do {
            let saved = try store.loadForm(formKey), key = saved?["body"] == .object(body) ? saved?["retry_key"]?.text ?? UUID().uuidString : UUID().uuidString
            try store.saveForm(formKey, value: ["body": .object(body), "retry_key": .string(key)])
            busy = true; problem = nil
            Task {
                do { let record = try CaseTransport.record(try await store.scopedValue("/cases/\(caseID)/review", method: "POST", body: body, idempotency: key), store: store); try store.rememberCase(record); try? store.clearForm(formKey) }
                catch { problem = "The review result was not established on this device. Reload before making another decision. " + SourceText.error(error) }
                self.checks = nil; acknowledged = false; busy = false
            }
        } catch { problem = SourceText.error(error) }
    }
    private func loadHistory(_ requested: Int) async {
        busy = true; historyLoaded = false; history = []; historyOffset = requested; problem = nil
        defer { busy = false }
        do {
            let value = try await store.scopedValue("/cases/\(caseID)/events?limit=20&offset=\(requested)")
            let page = try JSONDecoder().decode(RecordPage.self, from: JSONEncoder().encode(value))
            guard value.object["offset"] == .number(Double(requested)), value.object["limit"] == .number(20), page.items.count <= 20, page.total >= requested + page.items.count, !page.items.isEmpty || requested == page.total, page.items.allSatisfy({ $0.kind == "admin_case_events" && $0.workspace_id == store.account?.workspace.id && $0.value("case_id") == caseID && $0.value("farm_id") == current?.value("farm_id") }) else { throw ServiceError(status: 0, message: "The complete history page did not match this private case.") }
            history = page.items; historyTotal = page.total; historyLoaded = true
        } catch { problem = SourceText.error(error) }
    }
    private struct CaseItemSelection: Identifiable { let id = UUID(); let value: [String: JSONValue] }
}

struct CaseReferenceView: View {
    @EnvironmentObject private var store: AppStore
    let reference: CaseReference
    let farmID: String
    @State private var record: RecordItem?
    @State private var problem: String?
    var body: some View {
        List {
            LabeledContent("Selected revision", value: String(reference.revision))
            if let record { LabeledContent("Current revision", value: String(record.revision)); if record.revision != reference.revision { Notice("The current record differs from the case's pinned source. Opening it does not replace the pin.", warning: true) }; NavigationLink("Open current source review") { CaseSourceDestination(source: reference.source, record: record, farmID: farmID) } }
            else { Notice(problem ?? "Loading the current authorized source…", warning: problem != nil) }
        }.navigationTitle(reference.title).task {
            do { let item = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue(reference.source.path(reference.id)))); guard item.workspace_id == store.account?.workspace.id, item.value("farm_id") == farmID else { throw ServiceError(status: 0, message: "This source is not currently available for the case farm.") }; record = item } catch { problem = SourceText.error(error) }
        }
    }
}

struct CaseStartLinks: View {
    var farmID: String? = nil
    var body: some View { ForEach(CaseJob.allCases, id: \.self) { job in NavigationLink(job.title) { CaseEditor(job: job, initialFarmID: farmID) } } }
}

struct CaseListView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    @State private var farm = ""
    @State private var job = ""
    @State private var rows: [RecordItem] = []
    @State private var total = 0
    @State private var offset = 0
    @State private var loading = false
    @State private var loaded = false
    @State private var problem: String?
    @State private var loadID = UUID()
    private var cached: [RecordItem] { let exact = store.records("cases"), ids = Set(exact.map(\.id)); return (exact + store.records("case_summaries").filter { !ids.contains($0.id) }).filter { (farm.isEmpty || $0.value("farm_id") == farm) && (job.isEmpty || $0.value("job_type") == job) } }
    var body: some View {
        List {
            Section("Start with the job you need") { CaseStartLinks(farmID: farm.isEmpty ? nil : farm); Notice(CaseTransport.notice) }
            Section("Your cases") {
                FarmPicker(selected: $farm, optional: true)
                Picker("Job", selection: $job) { Text("All three jobs").tag(""); ForEach(CaseJob.allCases, id: \.self) { Text($0.title).tag($0.rawValue) } }
                if loading { ProgressView("Loading cases…") }
                if loaded {
                    Text(rows.isEmpty ? "The service returned no cases for this filter." : "Cases \(offset + 1)–\(offset + rows.count) of \(total)").font(.footnote)
                    ForEach(rows) { item in NavigationLink { CaseDetailView(caseID: item.id) } label: { VStack(alignment: .leading) { Text(item.title); Text(CaseTransport.state(item.state)).font(.caption); if let counts = item.data["counts"]?.object { Text("Selected sources: " + CaseTransport.answer(counts["references"]) + " · Follow-ups still open: " + CaseTransport.answer(counts["open_items"])).font(.caption) } } } }
                    HStack { Button("Previous cases") { Task { await load(max(0, offset - 20)) } }.disabled(loading || offset == 0); Spacer(); Button("Next cases") { Task { await load(offset + rows.count) } }.disabled(loading || rows.isEmpty || offset + rows.count >= total) }
                } else {
                    Notice("The current case page has not loaded. Saved device copies below are not a complete or current list.", warning: true)
                    ForEach(cached) { item in NavigationLink(item.title + " · device copy") { CaseDetailView(caseID: item.id) } }
                }
                Button("Reload cases") { Task { await load(offset) } }.disabled(loading || !store.sessionVerified)
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("My paperwork cases")
            .onAppear { if farm.isEmpty { farm = initialFarmID ?? "" }; Task { await load(0) } }
            .task(id: farm + ":" + job) { await load(0) }
    }
    private func load(_ requested: Int) async {
        let stamp = UUID(), selectedFarm = farm, selectedJob = job; loadID = stamp; loading = true; loaded = false; rows = []; offset = requested; problem = nil
        defer { if stamp == loadID { loading = false } }
        do { let page = try await store.casePage(farmID: selectedFarm.isEmpty ? nil : selectedFarm, job: selectedJob.isEmpty ? nil : selectedJob, offset: requested); guard stamp == loadID, !Task.isCancelled else { return }; rows = page.items; total = page.total; loaded = true }
        catch { if stamp == loadID { problem = SourceText.error(error) } }
    }
}

struct CaseSourcePicker: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let farmID: String
    var allowed: [CaseSource] = CaseSource.allCases
    let select: (CaseReference) -> Void
    @State private var source: CaseSource = .documents
    @State private var role = "evidence"
    @State private var rows: [RecordItem] = []
    @State private var total = 0
    @State private var offset = 0
    @State private var loaded = false
    @State private var busy = false
    @State private var problem: String?
    @State private var loadID = UUID()
    var body: some View {
        List {
            Section {
                Picker("Source kind", selection: $source) { ForEach(allowed, id: \.self) { Text($0.title).tag($0) } }
                Picker("How this source is used", selection: $role) { ForEach(["original", "notice", "change", "response", "evidence"], id: \.self) { Text($0.capitalized).tag($0) } }
                Notice("Only this farm's records can be selected. A revision is pinned explicitly; an unassigned document must first be assigned through the document workflow.")
            }.disabled(busy)
            if loaded {
                Section("Choose a current source") {
                    if rows.isEmpty { Text("No records were returned on this source page.") }
                    ForEach(rows) { record in
                        VStack(alignment: .leading) {
                            Text(record.title).font(.headline); Text("Revision \(record.revision) · " + record.state).font(.caption)
                            NavigationLink("Open this source before selecting") { CaseSourceDestination(source: source, record: record, farmID: farmID) }
                            Button("Use this revision as " + role) { choose(record) }.disabled(busy)
                        }
                    }
                    Text("\(offset) offset; \(rows.count) records on this page of \(total)").font(.footnote)
                    HStack { Button("Previous sources") { Task { await load(max(0, offset - 5)) } }.disabled(busy || offset == 0); Spacer(); Button("Next sources") { Task { await load(offset + rows.count) } }.disabled(busy || rows.isEmpty || offset + rows.count >= total) }
                }
            } else { Section { Notice("Sources have not loaded. No missing record is treated as absent.", warning: true); Button("Retry sources") { Task { await load(offset) } }.disabled(busy || !store.sessionVerified) } }
            if busy { ProgressView("Loading the current source revisions…") }
            if let problem { Notice(problem, warning: true) }
        }.navigationTitle("Select farm source").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            .onAppear { if !allowed.contains(source), let first = allowed.first { source = first } }
            .task(id: source.rawValue) { await load(0) }
    }
    private func load(_ requested: Int) async {
        let stamp = UUID(), selectedSource = source; loadID = stamp; busy = true; loaded = false; rows = []; offset = requested; problem = nil
        defer { if stamp == loadID { busy = false } }
        do {
            let value = try await store.scopedValue(selectedSource.page(farmID: farmID, offset: requested))
            let page = try JSONDecoder().decode(RecordPage.self, from: JSONEncoder().encode(value))
            guard stamp == loadID, source == selectedSource, !Task.isCancelled else { return }
            guard value.object["offset"] == .number(Double(requested)), value.object["limit"] == .number(5), page.items.count <= 5, page.total >= requested + page.items.count, !page.items.isEmpty || page.total == requested, page.items.allSatisfy({ $0.workspace_id == store.account?.workspace.id && $0.value("farm_id") == farmID }) else { throw ServiceError(status: 0, message: "These source records did not match the farm or complete page range.") }
            rows = page.items; total = page.total; loaded = true
        } catch { if stamp == loadID { problem = SourceText.error(error) } }
    }
    private func choose(_ record: RecordItem) {
        let selectedSource = source, selectedRole = role; busy = true; problem = nil
        Task {
            do {
                let fresh = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue(selectedSource.path(record.id))))
                guard fresh.workspace_id == store.account?.workspace.id, fresh.value("farm_id") == farmID else { throw ServiceError(status: 0, message: "The source is not available within this farm.") }
                guard fresh.revision == record.revision else { rows = rows.map { $0.id == fresh.id ? fresh : $0 }; throw ServiceError(status: 409, message: "This source changed. Review the refreshed revision and select it again explicitly.") }
                select(CaseReference(source: selectedSource, record: fresh, role: selectedRole)); dismiss()
            } catch { problem = SourceText.error(error) }
            busy = false
        }
    }
}

struct CaseSourceDestination: View {
    let source: CaseSource
    let record: RecordItem
    let farmID: String
    var body: some View { if source == .fieldChanges { FieldProposalReview(proposal: record, farmID: farmID) } else { DetailView(collection: source.rawValue, id: record.id) } }
}

struct CaseEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let job: CaseJob
    var initialFarmID: String? = nil
    var existing: RecordItem? = nil
    var initialReference: CaseReference? = nil
    @State private var farm = ""
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var values: [String: JSONValue] = [:]
    @State private var references: [CaseReference] = []
    @State private var revision: Int?
    @State private var key = UUID().uuidString
    @State private var pending: [String: JSONValue]?
    @State private var picker = false
    @State private var loaded = false
    @State private var selectedFarm = ""
    @State private var createdID: String?
    @State private var rejected = false
    @State private var comparison: RecordItem?
    @State private var busy = false
    @State private var problem: String?
    private var formKey: String { "case-form:" + (existing?.id ?? job.rawValue + ":" + (initialFarmID ?? "choose")) }
    private var editable: [String: JSONValue] {
        var body = values.filter { ["title", "authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason"].contains($0.key) }
        body["references"] = .array(references.map(\.wire)); return body
    }
    private var request: [String: JSONValue] { if existing != nil { return ["expected_revision": .number(Double(revision ?? 0)), "data": .object(editable)] }; var body = editable; body["farm_id"] = .string(farm); body["job_type"] = .string(job.rawValue); body["reporting_year"] = .number(Double(year)); return body }
    private func text(_ key: String) -> Binding<String> { Binding(get: { CzechJournalData.text(values[key]) }, set: { values[key] = $0.isEmpty && key != "title" ? .null : .string($0) }) }
    var body: some View {
        Form {
            Section(job.title) {
                Text(job.explanation)
                FarmPicker(selected: $farm).disabled(existing != nil || initialFarmID != nil || pending != nil)
                Stepper("Reporting year \(String(year))", value: $year, in: 1900...2200).disabled(existing != nil || pending != nil)
                TextField("Case title", text: text("title")); TextField("Authority / recipient, if recorded", text: text("authority")); TextField("Scheme or subject, if recorded", text: text("scheme"))
                TextField("Actual deadline if known (YYYY-MM-DD)", text: text("deadline"))
                TextField("Original submission reference, if known", text: text("original_reference"))
                TextField("Actual original submission date, if known (YYYY-MM-DD)", text: text("original_submitted_at"))
                TextField("What happened and what should change?", text: text("reason"), axis: .vertical)
            }.disabled(busy || pending != nil)
            Section("Select the records this case actually uses") {
                ForEach(references, id: \.identity) { reference in
                    VStack(alignment: .leading) { Text(reference.title); Text(reference.source.title + " · " + reference.role + " · revision \(reference.revision)").font(.caption); Button("Remove this selection", role: .destructive) { references.removeAll { $0.identity == reference.identity } }.disabled(busy || pending != nil) }
                }
                Button("Choose an existing farm source") { picker = true }.disabled(farm.isEmpty || busy || pending != nil || references.count >= 100 || !store.sessionVerified)
                Notice("Selecting records does not confirm them, approve a report or publish a boundary. Changes replace the whole explicit source selection and clear any previous case review.")
            }
            Section {
                Button(pending == nil ? "Save case draft" : "Retry the exact saved request") { save() }.buttonStyle(.borderedProminent).disabled(busy || !store.sessionVerified || farm.isEmpty || CzechJournalData.text(values["title"]).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button("Keep unfinished form privately on this device") { do { try persist(); dismiss() } catch { problem = SourceText.error(error) } }.disabled(busy)
                if pending != nil { Notice("The previous request may have reached the service. Its exact body and retry key are retained. Retry that request or close and inspect your cases; the app will not silently send a changed version.", warning: true) }
                if rejected {
                    if let existing { Button("Load current case before changing the rejected request") { Task { do { comparison = try CaseTransport.record(try await store.scopedValue("/cases/\(existing.id)"), store: store) } catch { problem = SourceText.error(error) } } } }
                    if existing == nil || comparison != nil {
                        if let comparison { CaseComparison(record: comparison) }
                        Button("Edit the rejected request with a new retry key") { if let comparison { guard ["draft", "needs_changes"].contains(comparison.state) else { problem = "Reopen the current case before editing it."; return }; revision = comparison.revision }; pending = nil; rejected = false; key = UUID().uuidString; do { try persist() } catch { problem = SourceText.error(error) } }
                    }
                }
                if !store.sessionVerified { Notice("Reconnect to save to the service. This unfinished form remains bound to the current private account.", warning: true) }
                if busy { ProgressView("Saving the case draft…") }
                if let problem { Notice(problem, warning: true) }
            }
        }.autocorrectionDisabled().textInputAutocapitalization(.never).navigationTitle(existing == nil ? job.title : "Edit case draft")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            .onAppear { fill() }
            .onChange(of: request) { _ in guard loaded, !busy, pending == nil else { return }; key = UUID().uuidString; do { try persist() } catch { problem = SourceText.error(error) } }
            .onChange(of: farm) { next in if loaded, next != selectedFarm { if existing == nil { references = [] }; selectedFarm = next } }
            .sheet(isPresented: $picker) { NavigationStack { CaseSourcePicker(farmID: farm) { reference in references.removeAll { $0.identity == reference.identity }; references.append(reference) } }.environmentObject(store) }
            .navigationDestination(isPresented: Binding(get: { createdID != nil }, set: { if !$0 { createdID = nil; dismiss() } })) { if let createdID { CaseDetailView(caseID: createdID) } }
    }
    private func persist() throws { try store.saveForm(formKey, value: ["request": .object(request), "references": .array(references.map(\.saved)), "retry_key": .string(key), "pending_body": pending.map(JSONValue.object) ?? .null, "rejected": .bool(rejected)]) }
    private func fill() {
        guard !loaded else { return }; loaded = true
        do {
            let saved = try store.loadForm(formKey), body = saved?["request"]?.object
            let content = existing == nil ? body : body?["data"]?.object
            values = content ?? existing?.data ?? ["title": .string(job.title)]
            farm = existing?.value("farm_id") ?? content?["farm_id"]?.text ?? initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "")
            selectedFarm = farm
            year = SourceText.year(existing?.data["reporting_year"] ?? content?["reporting_year"]).flatMap { Int($0) } ?? year
            revision = SourceText.year(body?["expected_revision"]).flatMap { Int($0) } ?? existing?.revision
            references = saved?["references"]?.array.compactMap(CaseReference.init) ?? (existing?.data["references"]?.array ?? []).compactMap(CaseReference.init)
            if saved == nil, existing == nil, let initialReference { references = [initialReference] }
            key = saved?["retry_key"]?.text ?? key; rejected = saved?["rejected"] == .bool(true); if case .object(let body)? = saved?["pending_body"] { pending = body }
        } catch { problem = SourceText.error(error) }
    }
    private func save() {
        let body = pending ?? request; let method = existing == nil ? "POST" : "PATCH", path = existing.map { "/cases/\($0.id)" } ?? "/cases"
        do { pending = body; try persist() } catch { problem = SourceText.error(error); return }
        busy = true; problem = nil
        Task {
            do { let record = try CaseTransport.record(try await store.scopedValue(path, method: method, body: body, idempotency: key), store: store); guard record.value("farm_id") == farm, record.value("job_type") == job.rawValue, existing == nil || record.id == existing?.id else { throw ServiceError(status: 0, message: "The saved case did not match this selected farm and job.") }; try store.rememberCase(record); try? store.clearForm(formKey); if existing == nil { createdID = record.id } else { dismiss() } }
            catch { rejected = [400, 404, 409, 422].contains((error as? ServiceError)?.status ?? 0); try? persist(); problem = SourceText.error(error) }
            busy = false
        }
    }
}

struct CaseItemEditor: View {
    let parent: RecordItem
    var item: [String: JSONValue]? = nil
    var body: some View { CaseActionEditor(parent: parent, item: item, isEvent: false) }
}

struct CaseEventEditor: View {
    let parent: RecordItem
    var body: some View { CaseActionEditor(parent: parent, isEvent: true) }
}

private struct CaseActionEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let parent: RecordItem
    var item: [String: JSONValue]? = nil
    let isEvent: Bool
    @State private var values: [String: JSONValue] = [:]
    @State private var documents: [CaseReference] = []
    @State private var revision = 0
    @State private var acknowledged = false
    @State private var retryKey = UUID().uuidString
    @State private var pending: [String: JSONValue]?
    @State private var loaded = false
    @State private var busy = false
    @State private var picker = false
    @State private var rejected = false
    @State private var comparison: RecordItem?
    @State private var problem: String?
    private var formKey: String { "case-action:" + parent.id + ":" + (isEvent ? "event" : item?["id"]?.text ?? "new-item") }
    private var title: String { isEvent ? "Record what happened" : item == nil ? "Add a follow-up" : "Review a follow-up" }
    private var actions: [String] {
        switch parent.state {
        case "draft": return ["cancelled"]
        case "ready_to_send": return ["sent", "reopen", "cancelled"]
        case "sent", "receipt_saved": return ["receipt", "accepted", "needs_changes", "reopen", "cancelled"]
        case "accepted_recorded": return ["needs_changes", "reopen", "cancelled"]
        case "needs_changes": return ["reopen", "cancelled"]
        case "cancelled": return ["reopen"]
        default: return []
        }
    }
    private func actionLabel(_ action: String) -> String { ["sent": "I sent this myself", "receipt": "I received a receipt", "accepted": "I received an acceptance decision", "needs_changes": "Changes were requested", "reopen": "Reopen for preparation", "cancelled": "Cancel this case"][action] ?? action }
    private func text(_ key: String) -> Binding<String> { Binding(get: { values[key]?.text ?? "" }, set: { values[key] = .string($0) }) }
    private var request: [String: JSONValue] {
        var body: [String: JSONValue] = ["expected_revision": .number(Double(revision))]
        if isEvent {
            for key in ["action", "date", "note"] { body[key] = values[key] ?? .string("") }
            if let reference = values["reference"], !reference.text.isEmpty { body["reference"] = reference }
            if let document = documents.first { body["document_id"] = .string(document.id); body["document_revision"] = .number(Double(document.revision)) }
            body["acknowledged"] = .bool(acknowledged)
        } else if item != nil {
            body["status"] = values["status"] ?? .string("in_progress"); body["note"] = values["note"] ?? .string("")
            body["document_ids"] = .array(documents.map { .string($0.id) }); body["acknowledged"] = .bool(acknowledged)
            body["document_revisions"] = .object(Dictionary(uniqueKeysWithValues: documents.map { ($0.id, .number(Double($0.revision))) }))
        } else {
            body["kind"] = values["kind"] ?? .string("requested_record"); body["title"] = values["title"] ?? .string("")
            for key in ["description", "due_date"] { if let value = values[key], !value.text.isEmpty { body[key] = value } }
        }
        return body
    }
    private var valid: Bool {
        if pending != nil { return true }
        if isEvent { let response = ["receipt", "accepted"].contains(values["action"]?.text ?? ""); return actions.contains(values["action"]?.text ?? "") && acknowledged && !(values["date"]?.text ?? "").isEmpty && !(values["note"]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (!response || (!documents.isEmpty && !(values["reference"]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)) }
        if item != nil { return acknowledged && !(values["note"]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (values["status"] != .string("resolved") || !documents.isEmpty) }
        return !(values["title"]?.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    var body: some View {
        Form {
            Section(title) {
                Text(parent.title).font(.headline)
                Text("Case revision \(revision). A status records your account of events; it is not an independently verified authority result.")
                if isEvent {
                    Picker("What actually happened?", selection: text("action")) { ForEach(actions, id: \.self) { Text(actionLabel($0)).tag($0) } }
                    TextField("Actual event date (YYYY-MM-DD)", text: text("date"))
                    TextField("Actual response or sending reference", text: text("reference"))
                    TextField("What happened?", text: text("note"), axis: .vertical)
                    Notice("Nothing is sent from this screen. Receipt and acceptance records require the actual response reference and its same-farm document.")
                } else if let item {
                    Text(item["title"]?.text ?? "Follow-up item").font(.headline)
                    Text(item["description"]?.text ?? "")
                    Picker("State I am recording", selection: text("status")) { Text("Work in progress").tag("in_progress"); Text("Resolved with evidence").tag("resolved"); Text("Set aside with a reason").tag("cancelled") }
                    TextField("What I checked or why I set it aside", text: text("note"), axis: .vertical)
                    Notice("Resolution needs an actual note and evidence documents. It does not certify compliance or close an authority's inspection.")
                } else {
                    Picker("Kind of follow-up", selection: text("kind")) { Text("Requested record").tag("requested_record"); Text("Finding").tag("finding"); Text("Action").tag("action") }
                    TextField("What is needed?", text: text("title")); TextField("Details from the actual request or finding", text: text("description"), axis: .vertical)
                    TextField("Actual due date, if known (YYYY-MM-DD)", text: text("due_date"))
                }
            }.disabled(busy || pending != nil)
            if isEvent || item != nil {
                Section("Actual supporting documents") {
                    ForEach(documents, id: \.identity) { document in VStack(alignment: .leading) { Text(document.title + " · revision \(document.revision)"); Button("Remove this document") { documents.removeAll { $0.id == document.id } }.disabled(busy || pending != nil) } }
                    Button(isEvent ? "Choose the actual evidence document" : "Choose same-farm evidence") { picker = true }.disabled(busy || pending != nil || !store.sessionVerified)
                    Toggle(isEvent ? "I am recording what actually happened; this does not send or verify anything" : "I reviewed this item and its actual evidence", isOn: $acknowledged).disabled(busy || pending != nil)
                }
            }
            Section {
                Button(pending == nil ? "Save this explicit record" : "Retry the exact saved request") { save() }.buttonStyle(.borderedProminent).disabled(busy || !valid || !store.sessionVerified)
                Button("Keep unfinished form privately") { do { try persist(); dismiss() } catch { problem = SourceText.error(error) } }.disabled(busy)
                if pending != nil { Notice("The exact request and retry key are retained. Do not create a second event to compensate for a lost response; retry this request or inspect the case history first.", warning: true) }
                if rejected {
                    Button("Load the current case before editing this rejected request") { Task { do { comparison = try CaseTransport.record(try await store.scopedValue("/cases/\(parent.id)"), store: store) } catch { problem = SourceText.error(error) } } }.disabled(busy)
                    if let comparison {
                        CaseComparison(record: comparison)
                        Button("Use this reviewed revision for a new request, keeping my text") { guard comparison.state == parent.state, isEvent || ["draft", "needs_changes"].contains(comparison.state) else { problem = "The case state changed. Close this form and reopen it from the current case before choosing another action."; return }; revision = comparison.revision; pending = nil; rejected = false; retryKey = UUID().uuidString; acknowledged = false; try? persist() }
                    }
                }
                if busy { ProgressView("Saving this person-recorded change…") }
                if !store.sessionVerified { Notice("Reconnect to continue. The private form is not queued for automatic review or sending.", warning: true) }
                if let problem { Notice(problem, warning: true) }
            }
        }.autocorrectionDisabled().textInputAutocapitalization(.never).navigationTitle(title)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.disabled(busy) } }
            .onAppear { fill() }.onChange(of: request) { _ in if loaded, pending == nil, !busy { retryKey = UUID().uuidString; do { try persist() } catch { problem = SourceText.error(error) } } }
            .onChange(of: documents) { _ in if pending == nil { acknowledged = false } }
            .onChange(of: values) { _ in if pending == nil { acknowledged = false } }
            .sheet(isPresented: $picker) { NavigationStack { CaseSourcePicker(farmID: parent.value("farm_id"), allowed: [.documents]) { selected in if isEvent { documents = [selected] } else { documents.removeAll { $0.id == selected.id }; if documents.count < 100 { documents.append(selected) } } } }.environmentObject(store) }
    }
    private func persist() throws { try store.saveForm(formKey, value: ["values": .object(values), "revision": .number(Double(revision)), "documents": .array(documents.map(\.saved)), "acknowledged": .bool(acknowledged), "pending": pending.map(JSONValue.object) ?? .null, "retry_key": .string(retryKey), "rejected": .bool(rejected)]) }
    private func fill() {
        guard !loaded else { return }; loaded = true; revision = parent.revision
        do {
            let saved = try store.loadForm(formKey)
            values = saved?["values"]?.object ?? (isEvent ? ["action": .string(actions.first ?? "")] : item == nil ? ["kind": .string("requested_record")] : ["status": .string("in_progress")])
            documents = saved?["documents"]?.array.compactMap(CaseReference.init) ?? []
            revision = SourceText.year(saved?["revision"]).flatMap { Int($0) } ?? parent.revision
            retryKey = saved?["retry_key"]?.text ?? retryKey; rejected = saved?["rejected"] == .bool(true)
            if case .object(let body)? = saved?["pending"] { pending = body; acknowledged = saved?["acknowledged"] == .bool(true) }
        } catch { problem = SourceText.error(error) }
    }
    private func save() {
        guard valid else { return }
        let body = pending ?? request
        let path = "/cases/\(parent.id)/" + (isEvent ? "events" : item == nil ? "items" : "items/\(item?["id"]?.text ?? "")/review")
        do { pending = body; try persist() } catch { problem = SourceText.error(error); return }
        busy = true; problem = nil
        Task {
            do {
                let response = try await store.scopedValue(path, method: "POST", body: body, idempotency: retryKey)
                let record = try CaseTransport.record(isEvent ? response.object["case"] ?? .null : response, store: store)
                guard record.id == parent.id, record.value("farm_id") == parent.value("farm_id") else { throw ServiceError(status: 0, message: "The result did not match this case and farm.") }
                if isEvent { let event = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(response.object["event"] ?? .null)); guard event.kind == "admin_case_events", event.workspace_id == store.account?.workspace.id, event.value("case_id") == parent.id, event.value("farm_id") == parent.value("farm_id") else { throw ServiceError(status: 0, message: "The complete recorded event was not returned for this case.") } }
                try store.rememberCase(record); try? store.clearForm(formKey); dismiss()
            } catch { rejected = [400, 404, 409, 422].contains((error as? ServiceError)?.status ?? 0); try? persist(); problem = SourceText.error(error) }
            busy = false
        }
    }
}

private struct CaseComparison: View {
    let record: RecordItem
    var body: some View {
        DisclosureGroup("Compare the current saved case · revision \(record.revision)") {
            Text(record.title).font(.headline); Text(CaseTransport.state(record.state))
            ForEach(["authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason"], id: \.self) { key in LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: CaseTransport.answer(record.data[key])).textSelection(.enabled) }
            ForEach((record.data["references"]?.array ?? []).compactMap(CaseReference.init), id: \.identity) { reference in Text(reference.source.title + " · " + reference.role + " · revision \(reference.revision)\n" + reference.id).font(.caption).textSelection(.enabled) }
            Notice("Your typed form is not merged automatically. Starting a new request keeps your text and source selections and uses this explicitly chosen revision; current source pins are still checked by the service.")
        }
    }
}

struct CaseHandoffView: View {
    @EnvironmentObject private var store: AppStore
    let parent: RecordItem
    var eventID: String? = nil
    @State private var handoff: [String: JSONValue]?
    @State private var problem: String?
    @State private var loading = false
    @State private var exporting = false
    @State private var export: ExportFile?
    @State private var cleanup: ExportFile?
    @State private var downloadTask: Task<Void, Never>?
    @State private var copied = false
    @State private var loadID = UUID()
    private var downloads: [CaseTransport.Download] { (handoff?["downloads"]?.array ?? []).compactMap(CaseTransport.download).filter { $0.matches(caseID: parent.id, fingerprint: handoff?["reference_fingerprint"], origin: handoff?["origin"], revision: handoff?["native_packet_revision"]) } }
    private var packet: CaseTransport.Download? { let packets = downloads.filter(\.isPacket); return packets.count == 1 ? packets.first : nil }
    private var individualDownloads: [CaseTransport.Download] { downloads.filter { !$0.isPacket } }
    private var officialURL: URL? { guard let raw = handoff?["official_url"]?.text, let url = URLComponents(string: raw), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }; return url.url }
    private var answers: String { (handoff?["fields"]?.array ?? []).map { ($0.object["label"]?.text ?? "Recorded answer") + ": " + CaseTransport.answer($0.object["value"]) }.joined(separator: "\n") }
    var body: some View {
        List {
            Section {
                Notice(CaseTransport.notice)
                Button("Reload the authorized handoff") { Task { await load() } }.disabled(loading || exporting || !store.sessionVerified)
                if let handoff {
                    Notice(handoff["notice"]?.text ?? CaseTransport.notice)
                    Text(handoff["origin"] == .string("sealed_sent_bundle") ? "Historical bundle recorded as sent — not a fresh source review" : "Current reviewed preparation — not sent").font(.headline)
                    if let packet { Button("Download complete prepared folder (ZIP)") { saveFile(packet) }.buttonStyle(.borderedProminent).disabled(loading || exporting || !store.sessionVerified) }
                    else { Notice("The complete prepared folder is not available in this loaded handoff. Reload it before continuing; individual files are not a replacement for a complete folder.", warning: true) }
                    Notice("Documents selected here, attached to completed items or selected in approved reports are included. Other private source files stay in your workspace.")
                    Notice("If a required included file is missing or changed, preparation stops rather than returning a partial folder. Downloading or sharing does not send anything to an authority.")
                    ForEach(Array((handoff["fields"]?.array ?? []).enumerated()), id: \.offset) { _, field in LabeledContent(field.object["label"]?.text ?? "Recorded answer", value: CaseTransport.answer(field.object["value"])).textSelection(.enabled) }
                    Button(copied ? "Answers copied on this device" : "Copy these answers for my own next step") { copyAnswers() }.disabled(loading || exporting || !store.sessionVerified)
                    if let officialURL { Link("Open the official website myself", destination: officialURL); Text("The website opens separately. This app does not fill, send or confirm a submission there.").font(.footnote) } else { Notice("No verified official website is supplied for this farm. Ask the recipient or adviser for the actual process.", warning: true) }
                } else { Notice("The handoff has not loaded. No copyable answers or download are assumed to be available.", warning: true) }
            }
            if let handoff {
                Section("Files for my own next step") {
                    DisclosureGroup("Individual files (optional)") {
                        ForEach(individualDownloads) { download in Button(download.label) { saveFile(download) }.disabled(loading || exporting || !store.sessionVerified) }
                        if individualDownloads.isEmpty { Text("This handoff supplies no separate individual download.") }
                    }
                    if downloads.count != handoff["downloads"]?.array.count { Notice("An unsupported download address was rejected. No file was fetched from it.", warning: true) }
                    Text("The complete ZIP streams into protected private storage, up to 128 MiB. Individual exports remain limited to 512 MiB. Every transfer keeps 64 MiB free; only a completed file can enter the system share sheet.").font(.footnote)
                    if handoff["origin"] == .string("sealed_sent_bundle") { Notice("Historical field files use the exact retained proposal revision, not today's field record. Access is still checked against the current private farm grant.") }
                }
            }
            if exporting { ProgressView("Downloading a protected file…"); Button("Cancel download", role: .cancel) { cancel() } }
            if loading { ProgressView("Checking the current or sealed handoff…") }
            if let problem { Notice(problem, warning: true) }
        }.navigationTitle("My next step").task { await load() }
            .onChange(of: store.account?.scope) { _ in invalidate() }
            .onChange(of: store.sessionVerified) { verified in if !verified { invalidate() } }
            .onChange(of: store.record("cases", parent.id)?.revision) { _ in invalidate() }
            .onDisappear { loadID = UUID(); cancel(); if export == nil, let cleanup { store.removeExport(cleanup); self.cleanup = nil } }
            .sheet(item: $export, onDismiss: { if let cleanup { store.removeExport(cleanup); self.cleanup = nil } }) { file in ShareSheet(items: [file.url]) }
    }
    private func load() async {
        let stamp = UUID(), scope = store.account?.scope, revision = store.record("cases", parent.id)?.revision; loadID = stamp
        handoff = nil; copied = false; loading = true; problem = nil
        defer { if stamp == loadID { loading = false } }
        do { let value = try await fetchHandoff(); guard stamp == loadID, scope == store.account?.scope, revision == store.record("cases", parent.id)?.revision, store.sessionVerified, !Task.isCancelled else { return }; handoff = value } catch { if stamp == loadID { problem = SourceText.error(error) } }
    }
    private func fetchHandoff() async throws -> [String: JSONValue] {
        var value: [String: JSONValue]
        if let eventID {
            let event = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue("/cases/\(parent.id)/events/\(eventID)")))
            guard event.id == eventID, event.kind == "admin_case_events", event.workspace_id == store.account?.workspace.id, event.value("case_id") == parent.id, event.value("farm_id") == parent.value("farm_id"), event.value("action") == "sent", let bundle = event.data["sealed_bundle"]?.object, let retained = bundle["handoff"], let retainedRevision = SourceText.year(bundle["case_revision"]).flatMap({ Int($0) }), retainedRevision > 0 else { throw ServiceError(status: 0, message: "This exact historical sent bundle is unavailable for this private case.") }
            value = retained.object; value["origin"] = .string("sealed_sent_bundle"); value["native_packet_revision"] = .number(Double(retainedRevision))
        } else {
            value = try await store.scopedValue("/cases/\(parent.id)/handoff").object
            if value["origin"] == .string("sealed_sent_bundle") {
                let sentID = store.record("cases", parent.id)?.value("sent_event_id") ?? parent.value("sent_event_id")
                guard UUID(uuidString: sentID) != nil else { throw ServiceError(status: 409, message: "Reload this case before opening its exact retained sending event.") }
                let event = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue("/cases/\(parent.id)/events/\(sentID)")))
                guard event.id == sentID, event.kind == "admin_case_events", event.workspace_id == store.account?.workspace.id, event.value("case_id") == parent.id, event.value("farm_id") == parent.value("farm_id"), event.value("action") == "sent", let bundle = event.data["sealed_bundle"]?.object, let retained = bundle["handoff"]?.object, retained["reference_fingerprint"] == value["reference_fingerprint"], retained["downloads"] == value["downloads"], retained["fields"] == value["fields"], let retainedRevision = SourceText.year(bundle["case_revision"]).flatMap({ Int($0) }), retainedRevision > 0 else { throw ServiceError(status: 409, message: "The retained handoff did not match this case's exact sending event. Reload before continuing.") }
                value["native_packet_revision"] = .number(Double(retainedRevision))
            } else if let revision = store.record("cases", parent.id)?.revision { value["native_packet_revision"] = .number(Double(revision)) }
        }
        guard value["case_id"] == .string(parent.id), !(value["reference_fingerprint"]?.text ?? "").isEmpty, case .array(_)? = value["fields"], case .array(_)? = value["downloads"], ["current_review", "sealed_sent_bundle"].contains(value["origin"]?.text ?? "") else { throw ServiceError(status: 0, message: "The complete handoff did not match this case. Reload before continuing.") }
        return value
    }
    private func copyAnswers() {
        guard let handoff, !loading, !exporting, store.sessionVerified else { return }
        let stamp = loadID, scope = store.account?.scope, revision = store.record("cases", parent.id)?.revision
        loading = true; problem = nil
        Task {
            defer { if stamp == loadID { loading = false } }
            do { let fresh = try await fetchHandoff(); guard stamp == loadID, scope == store.account?.scope, revision == store.record("cases", parent.id)?.revision, store.sessionVerified, !Task.isCancelled else { return }; guard fresh["reference_fingerprint"] == handoff["reference_fingerprint"], fresh["origin"] == handoff["origin"], fresh["fields"] == handoff["fields"] else { throw ServiceError(status: 409, message: "The authorized answers changed. Reload and read them before copying.") }; UIPasteboard.general.setItems([["public.utf8-plain-text": answers]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)]); copied = true }
            catch { if stamp == loadID { self.handoff = nil; copied = false; problem = SourceText.error(error) } }
        }
    }
    private func saveFile(_ download: CaseTransport.Download) {
        guard let handoff, !loading, !exporting, store.sessionVerified else { return }
        let stamp = loadID, scope = store.account?.scope, revision = store.record("cases", parent.id)?.revision
        exporting = true; problem = nil
        downloadTask = Task {
            do {
                let fresh = try await fetchHandoff()
                guard stamp == loadID, scope == store.account?.scope, revision == store.record("cases", parent.id)?.revision, store.sessionVerified, !Task.isCancelled else { throw CancellationError() }
                guard fresh["reference_fingerprint"] == handoff["reference_fingerprint"], fresh["origin"] == handoff["origin"], (fresh["downloads"]?.array ?? []).compactMap(CaseTransport.download).contains(where: { $0.id == download.id && $0.path == download.path && $0.matches(caseID: parent.id, fingerprint: fresh["reference_fingerprint"], origin: fresh["origin"], revision: fresh["native_packet_revision"]) }) else { throw ServiceError(status: 409, message: "The reviewed file selection changed. Reload the handoff before downloading.") }
                let file = try await store.export(download.path, suffix: download.suffix, maximumBytes: download.maximumBytes, expectedContentType: download.isPacket ? "application/zip" : nil)
                if Task.isCancelled || stamp != loadID || scope != store.account?.scope || revision != store.record("cases", parent.id)?.revision { store.removeExport(file) } else { cleanup = file; export = file }
            } catch { if stamp == loadID { self.handoff = nil; problem = (error is CancellationError || (error as? URLError)?.code == .cancelled) ? "Download cancelled. No partial file was shared." : SourceText.error(error) } }
            exporting = false; downloadTask = nil
        }
    }
    private func cancel() { downloadTask?.cancel(); store.cancelExportDownloads() }
    private func invalidate() { loadID = UUID(); loading = false; handoff = nil; copied = false; cancel(); export = nil; if let cleanup { store.removeExport(cleanup); self.cleanup = nil }; problem = "The case, account or session changed. Reload the authorized handoff." }
}

struct CaseHistoryDetail: View {
    @EnvironmentObject private var store: AppStore
    let caseID: String
    let eventID: String
    let farmID: String
    @State private var event: RecordItem?
    @State private var problem: String?
    @State private var loading = false
    var body: some View {
        List {
            Section {
                Notice(CaseTransport.notice)
                Button("Reload this exact history entry") { Task { await load() } }.disabled(loading || !store.sessionVerified)
                if let event {
                    ForEach(["action", "date", "note", "reference", "actor_id", "recorded_at", "case_revision"], id: \.self) { key in if let value = event.data[key] { LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: CaseTransport.answer(value)).textSelection(.enabled) } }
                    if let bundle = event.data["sealed_bundle"]?.object, let content = bundle["content"]?.object {
                        Section("The original selection recorded as sent") {
                            Notice("This immutable selection is historical. Later edits do not rewrite it; it is not evidence of delivery or authority acceptance.")
                            ForEach(["title", "reporting_year", "authority", "scheme", "deadline", "original_reference", "original_submitted_at", "reason"], id: \.self) { key in if let value = content[key] { LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: CaseTransport.answer(value)).textSelection(.enabled) } }
                            ForEach((content["references"]?.array ?? []).compactMap(CaseReference.init), id: \.identity) { reference in VStack(alignment: .leading) { Text(reference.source.title + " · " + reference.role + " · retained revision \(reference.revision)"); Text(reference.id).font(.caption.monospaced()).textSelection(.enabled); NavigationLink("Compare current source — does not replace the historical selection") { CaseReferenceView(reference: reference, farmID: farmID) } } }
                            ForEach(Array((content["items"]?.array ?? []).enumerated()), id: \.offset) { _, item in DisclosureGroup(item.object["title"]?.text ?? "Retained follow-up") { SourceRowCells(value: item.object) } }
                            if let current = store.record("cases", caseID) { NavigationLink("Open this exact event's retained answers and files") { CaseHandoffView(parent: current, eventID: eventID) } }
                            DisclosureGroup("Recorded seal and preparation review") { if let review = bundle["review"] { SourceRowCells(value: review.object) }; LabeledContent("Case revision recorded as sent", value: CaseTransport.answer(bundle["case_revision"])) }
                        }
                    }
                    if let changes = event.data["changes"] { DisclosureGroup("Exact recorded changes") { SourceRowCells(value: changes.object) } }
                    if let item = event.data["item"] { DisclosureGroup("Exact retained follow-up item") { SourceRowCells(value: item.object) } }
                } else { Notice(problem ?? "The exact immutable history detail has not loaded. A list summary is not its full retained selection.", warning: true) }
                if loading { ProgressView("Loading one retained history entry…") }
                if event != nil, let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("Recorded case history").task { await load() }
            .onChange(of: store.sessionVerified) { verified in if !verified { event = nil } }
            .onChange(of: store.account?.scope) { _ in event = nil }
    }
    private func load() async {
        loading = true; event = nil; problem = nil; defer { loading = false }
        do { let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue("/cases/\(caseID)/events/\(eventID)"))); guard record.id == eventID, record.kind == "admin_case_events", record.workspace_id == store.account?.workspace.id, record.value("case_id") == caseID, record.value("farm_id") == farmID else { throw ServiceError(status: 0, message: "The retained event did not match this private case and farm.") }; event = record } catch { problem = SourceText.error(error) }
    }
}
