import SwiftUI
import UIKit

struct ReportDetail: View {
    @EnvironmentObject private var store: AppStore
    @StateObject private var review = ReportReviewModel()
    let item: RecordItem
    @State private var section: ReportSection = .fields
    @State private var working = false
    @State private var error: String?
    @State private var approve = false
    @State private var export: ExportFile?
    @State private var cleanup: ExportFile?
    @State private var downloadTask: Task<Void, Never>?
    @State private var downloading = false
    @State private var receipt = false
    @State private var reissue = false
    private var current: RecordItem { review.record ?? item }
    private var page: ReportReviewPage { review.pages[section] ?? ReportReviewPage() }
    private var formats: [String] { (review.record?.data["supported_formats"]?.array ?? []).map(\.text).filter { ["pdf", "csv", "json", "xlsx"].contains($0) } }
    private var canApprove: Bool { review.record?.state == "draft" && review.record?.data["can_approve"] == .bool(true) && review.binding?.scope == store.account?.scope && review.binding?.counts[.blockers] == 0 && review.contentReviewed && review.acknowledged && store.sessionVerified && !working && !review.busy }
    private var canAmend: Bool { ["owner", "adviser"].contains(store.account?.workspace.role ?? "") && store.sessionVerified && review.binding?.scope == store.account?.scope && !working && !review.busy }
    var body: some View {
        List {
            Section {
                Text(current.title).font(.title2.bold())
                NavigationLink("Correct a submitted mistake using this original report") { CaseEditor(job: .correction, initialFarmID: current.value("farm_id"), initialReference: CaseReference(source: .reports, record: current, role: "original")) }
                LabeledContent("State", value: current.state == "issued" ? "Approved / issued snapshot" : current.state.capitalized)
                LabeledContent("Reporting year", value: current.value("reporting_year"))
                if let notice = current.data["snapshot"]?.object["capability_notice"] { Notice(notice.text) }
                Notice("Approval records your review of this snapshot. Sharing a file or recording a response does not establish authority acceptance.")
                Button("Reload exact report review") { Task { await review.load(id: item.id, store: store) } }.disabled(working || review.busy || !store.sessionVerified)
                if !store.sessionVerified { Notice("Reconnect to load authorized review pages. Cached summaries cannot authorize approval.", warning: true) }
                if let problem = review.problem { Notice(problem, warning: true) }
            }
            if let binding = review.binding {
                Section("Review complete ranges") {
                    Picker("Section", selection: $section) {
                        ForEach(ReportSection.allCases, id: \.self) { value in Text(value.title + " (" + String(binding.counts[value] ?? 0) + ")").tag(value) }
                    }.disabled(review.busy)
                    if page.loaded {
                        Text(page.items.isEmpty ? "The service returned an empty section (0 items)." : "Items \(page.offset + 1)–\(page.offset + page.items.count) of \(binding.counts[section] ?? 0)").font(.footnote)
                        ForEach(Array(page.items.enumerated()), id: \.offset) { index, value in ReportPageItem(section: section, value: value, position: page.offset + index + 1).id(binding.identity + ":" + section.rawValue + ":" + String(page.offset + index)) }
                        HStack {
                            Button("Previous range") { Task { await review.move(section, direction: -1, id: item.id, store: store) } }.disabled(review.busy || page.previous.isEmpty)
                            Spacer()
                            Button("Next range") { Task { await review.move(section, direction: 1, id: item.id, store: store) } }.disabled(review.busy || page.next == nil)
                        }
                        if section.needsHumanReview {
                            Button(page.items.isEmpty ? "I checked this empty section" : "I reviewed this complete range") { review.markReviewed(section) }.disabled(review.busy || !store.sessionVerified)
                            Text("Explicitly reviewed: \(review.visited[section]?.count ?? 0) of \(binding.counts[section] ?? 0) items" + ((binding.counts[section] == 0 && review.checkedEmpty.contains(section)) ? " — empty section checked" : "")).font(.footnote).foregroundStyle(.secondary)
                        }
                    } else {
                        Notice(page.problem ?? "This section has not been loaded. Its contents are not assumed to be empty.", warning: true)
                        Button("Retry this exact range") { Task { await review.retry(section, id: item.id, store: store) } }.disabled(review.busy || !store.sessionVerified)
                    }
                    Text("Each range contains at most five complete items and may be smaller to stay within the page budget. Retained source values are not truncated or converted.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Your approval") {
                    if let reason = review.record?.data["approval_blocked_reason"], reason != .null { Notice(reason.text, warning: current.state == "draft") }
                    if let approval = current.data["approval"], approval != .null { DisclosureGroup("Recorded approval") { SourceRowCells(value: approval.object) } }
                    if current.state == "draft" {
                        if !review.reviewAvailable { Notice("Every review section must be available before approval. Retry unavailable ranges or reload the review.", warning: true) }
                        if !review.contentReviewed { Text("Visit and explicitly review every range in Report values, Recorded work and Selected evidence, including empty sections.").font(.callout) }
                        Toggle("I checked the values, work and selected evidence in this exact review", isOn: $review.acknowledged).disabled(!review.contentReviewed || review.busy || !store.sessionVerified)
                        Button("Approve reviewed snapshot") { approve = true }.buttonStyle(.borderedProminent).disabled(!canApprove)
                        if current.data["pack_id"] == .string(CzechJournalData.pack) {
                            Button("Prepare a corrected journal preview") { reissue = true }.disabled(!canAmend)
                            Text("The blocked original remains retained. Select the reviewed successor applications and holder in a new preview, then review and approve that version separately.").font(.footnote)
                        } else if current.data["pack_id"] == .string("pt-ppp-surface-journal") {
                            Button("Prepare a corrected Portuguese journal preview") { reissue = true }.disabled(!canAmend)
                            Text("The original preview stays in history. Separately confirm any source-journal correction, then explicitly select the current source revision, actual dated rows and output order for a new review.").font(.footnote)
                        }
                    }
                    if let amendment = current.data["amendment"]?.object, let message = amendment["message"] { Notice(message.text, warning: amendment["needed"] == .bool(true)); if amendment["needed"] == .bool(true) { Button("Review corrections") { section = .changes } } }
                    if current.state == "issued" {
                        Menu("Export and share approved report") { ForEach(formats, id: \.self) { format in Button(format.uppercased()) { download(format) } } }.disabled(formats.isEmpty || working || !store.sessionVerified || review.busy)
                        Button("Record manual response reference") { receipt = true }.disabled(!canAmend)
                        Button("Prepare correction / reissue") { reissue = true }.disabled(!canAmend)
                    }
                    LabeledContent("Reviewed revision", value: String(binding.revision))
                    DisclosureGroup("Snapshot and current-check identity") { Text(binding.checksum).font(.caption.monospaced()).textSelection(.enabled); Text(binding.fingerprint).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            if review.busy { ProgressView("Loading bounded report review…") }
            if working { ProgressView(downloading ? "Downloading protected file…" : "Waiting for service…") }
            if downloading { Button("Cancel download", role: .cancel) { downloadTask?.cancel(); store.cancelExportDownloads() }; Text("Exports use private protected storage, up to 512 MiB while keeping 64 MiB free. A partial file is never shared.").font(.footnote) }
            if let error { Notice(error, warning: true) }
        }.navigationTitle("Report review")
            .task(id: item.id) { await review.load(id: item.id, store: store) }
            .onChange(of: item.revision) { _ in review.invalidate("The report revision changed. Reload and review its complete ranges again."); downloadTask?.cancel() }
            .onChange(of: item.data["checksum"]) { _ in review.invalidate("The retained snapshot changed. Reload and review its complete ranges again."); downloadTask?.cancel() }
            .onChange(of: store.account?.scope) { _ in review.invalidate("The account or workspace changed. Reload this review."); downloadTask?.cancel() }
            .onChange(of: store.sessionVerified) { verified in if !verified { review.invalidate("Reconnect before continuing this review."); downloadTask?.cancel() } }
            .onDisappear { review.invalidate(); downloadTask?.cancel(); if export == nil, let cleanup { store.removeExport(cleanup); self.cleanup = nil } }
            .confirmationDialog("Approve this exact revision, snapshot and current checks?", isPresented: $approve, titleVisibility: .visible) { Button("Approve snapshot") { approveCurrent() } }
            .sheet(item: $export, onDismiss: { if let cleanup { store.removeExport(cleanup); self.cleanup = nil } }) { file in ShareSheet(items: [file.url]) }
            .sheet(isPresented: $receipt, onDismiss: { Task { await review.load(id: item.id, store: store) } }) { NavigationStack { ReceiptEditor(report: current) }.environmentObject(store) }
            .sheet(isPresented: $reissue, onDismiss: { Task { await review.load(id: item.id, store: store) } }) { NavigationStack { if current.data["pack_id"] == .string("pt-ppp-surface-journal") { PortugueseJournalView(initialFarmID: current.value("farm_id"), reissue: current) } else { ReportComposer(reissue: current) } }.environmentObject(store) }
    }
    private func approveCurrent() {
        guard canApprove, let binding = review.binding else { return }
        let body: [String: JSONValue] = ["expected_revision": .number(Double(binding.revision)), "snapshot_checksum": .string(binding.checksum), "check_fingerprint": .string(binding.fingerprint)]
        let formKey = "report-approval-intent:" + item.id
        do {
            let saved = try store.loadForm(formKey)
            let key = saved?["body"] == .object(body) ? saved?["retry_key"]?.text ?? UUID().uuidString : UUID().uuidString
            try store.saveForm(formKey, value: ["body": .object(body), "retry_key": .string(key)])
            working = true; error = nil
            Task {
                do { try await store.mutate("/reports/\(item.id)/approve", body: body, idempotency: key); try store.clearForm(formKey); await review.load(id: item.id, store: store) }
                catch { review.invalidate("Approval was not established on this device. Reload current state before deciding again."); self.error = SourceText.error(error) }
                working = false
            }
        } catch { self.error = SourceText.error(error) }
    }
    private func download(_ format: String) {
        guard current.state == "issued", review.record != nil, formats.contains(format), store.sessionVerified, !working else { return }
        working = true; downloading = true; error = nil
        downloadTask = Task {
            do {
                let file = try await store.export("/reports/\(item.id)/download?format=\(format)", suffix: format)
                if Task.isCancelled { store.removeExport(file) } else { cleanup = file; export = file }
            } catch { self.error = (error is CancellationError || (error as? URLError)?.code == .cancelled) ? "Download cancelled. No partial file was shared." : SourceText.error(error) }
            downloading = false; working = false; downloadTask = nil
        }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct ReceiptEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let report: RecordItem
    @State private var reference = ""
    @State private var date = Date()
    @State private var retryKey = UUID()
    @State private var working = false
    @State private var error: String?
    var body: some View {
        Form {
            Section { Notice("Record a reference from a response you actually sent or received. This manual note does not certify transport or authority acceptance."); TextField("Response reference", text: $reference).disabled(working); DatePicker("Response date", selection: $date, displayedComponents: .date).disabled(working) }
            Section {
                Button("Record reference") {
                    working = true
                    Task {
                        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
                        do { try await store.mutate("/reports/\(report.id)/receipts", body: ["expected_revision": .number(Double(report.revision)), "snapshot_checksum": .string(report.value("checksum")), "reference": .string(reference), "date": .string(formatter.string(from: date))], idempotency: retryKey.uuidString); dismiss() }
                        catch { self.error = SourceText.error(error) }
                        working = false
                    }
                }.disabled(reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || working || !store.sessionVerified)
                if working { ProgressView("Saving reference…") }
                if let error { Notice(error, warning: true) }
            }
        }.navigationTitle("Response reference").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() }.disabled(working) } }
            .onChange(of: reference) { _ in retryKey = UUID() }.onChange(of: date) { _ in retryKey = UUID() }
    }
}
