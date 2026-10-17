import SwiftUI
import UIKit

struct ReportDetail: View {
    @EnvironmentObject private var store: AppStore
    let item: RecordItem
    @State private var working = false
    @State private var error: String?
    @State private var approve = false
    @State private var export: ExportFile?
    @State private var cleanup: ExportFile?
    @State private var receipt = false
    @State private var reissue = false
    private var snapshot: [String: JSONValue] { item.data["snapshot"]?.object ?? [:] }
    private var blockers: [JSONValue] { item.data["current_blockers"]?.array ?? item.data["blockers"]?.array ?? [] }
    private var retainedSaleSources: [JSONValue] {
        var seen: Set<String> = []
        return (snapshot["facts"]?.array ?? []).flatMap { $0.object["data"]?.object["sources"]?.array ?? [] }.filter { source in
            guard let reference = RecordEvidenceReference(source), reference.collection == "sales" else { return false }
            return seen.insert(reference.id + ":" + (reference.revision ?? "")).inserted
        }
    }
    var body: some View {
        List {
            Section {
                Text(item.title).font(.title2.bold())
                LabeledContent("State", value: item.state == "issued" ? "Approved / issued snapshot" : item.state.capitalized)
                LabeledContent("Reporting year", value: item.value("reporting_year"))
                if let capability = snapshot["capability_notice"] { Notice(capability.text) }
                Notice("Approval records your review of this snapshot. Exports and manual receipt references do not establish authority acceptance.")
            }
            Section("Check before approval") {
                if blockers.isEmpty { Text("The service reports no blocking prerequisites for this snapshot.") }
                ForEach(Array(blockers.enumerated()), id: \.offset) { _, blocker in Notice(blocker.object["message"]?.text ?? blocker.text, warning: true) }
            }
            Section("Values in this snapshot") {
                let fields = snapshot["fields"]?.array ?? []
                if fields.isEmpty { Notice("The snapshot has no fields. Inspect the pack and prerequisites before approval.", warning: true) }
                ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                    let data = field.object
                    DisclosureGroup(data["label"]?.text ?? data["field"]?.text ?? "Report field") {
                        if let schema = data["row_schema"]?.object, !schema.isEmpty, case .object(let values)? = data["value"] {
                            Notice("These labels and source units are retained in this report snapshot. No current profile catalogue is used to reinterpret them.")
                            SourceRowCells(value: values, schema: schema)
                            if let period = data["period"] { LabeledContent("Retained source period", value: period.text) }
                            if let id = schema["id"] { LabeledContent("Retained source definition", value: id.text) }
                        } else { SourceCellValue(value: data["value"]) }
                        DisclosureGroup("Retained field identity") { JSONFields(data: data.filter { !["value", "label", "row_schema"].contains($0.key) }) }
                        if let factID = data["fact_id"]?.text, UUID(uuidString: factID) != nil { NavigationLink("Review source fact") { DetailView(collection: "facts", id: factID) } }
                    }
                }
            }
            Section("Selected source evidence") {
                ForEach(Array((snapshot["evidence"]?.array ?? []).enumerated()), id: \.offset) { _, source in
                    let object = source.object
                    if let id = object["id"]?.text { NavigationLink(object["name"]?.text ?? "Source document") { DetailView(collection: "documents", id: id) } }
                    else { Text(source.text) }
                }
            }
            if !retainedSaleSources.isEmpty {
                Section("Retained sale source references") {
                    ForEach(Array(retainedSaleSources.enumerated()), id: \.offset) { _, source in RecordEvidenceLink(source: source) }
                    Text("Links open the current sale record. This report retains the source revisions used by its snapshot; opening a source does not rewrite issued values or calculate financial totals.").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("Your approval") {
                if let approval = item.data["approval"], approval != .null { Text(approval.text).font(.callout).textSelection(.enabled) }
                if item.state == "draft" {
                    Button("Approve reviewed snapshot") { approve = true }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || !blockers.isEmpty || (snapshot["fields"]?.array ?? []).isEmpty)
                }
                if item.state == "issued" {
                    Menu("Export and share approved report") {
                        ForEach(["pdf", "csv", "json", "xlsx"], id: \.self) { format in Button(format.uppercased()) { download(format) } }
                    }.disabled(working || !store.sessionVerified)
                    Button("Record manual response reference") { receipt = true }.disabled(working || !store.sessionVerified)
                    Button("Prepare correction / reissue") { reissue = true }.disabled(working || !store.sessionVerified)
                }
                if working { ProgressView("Waiting for service…") }
                if let error { Notice(error, warning: true) }
            }
            Section("Retained response and reissue history") {
                if let receipts = item.data["receipts"] { Text(receipts.text).font(.callout).textSelection(.enabled) }
                if let reissues = item.data["reissues"] { Text(reissues.text).font(.callout).textSelection(.enabled) }
                LabeledContent("Snapshot checksum", value: item.value("checksum")).font(.caption).textSelection(.enabled)
                RecordMetadata(item: item)
            }
        }.navigationTitle("Report review")
            .confirmationDialog("Approve the values and source evidence in this exact revision?", isPresented: $approve, titleVisibility: .visible) {
                Button("Approve snapshot") {
                    run { try await store.mutate("/reports/\(item.id)/approve", body: ["expected_revision": .number(Double(item.revision))]); _ = try await store.refreshDetail("reports", item.id) }
                }
            }
            .sheet(item: $export, onDismiss: { if let cleanup { store.removeExport(cleanup); self.cleanup = nil } }) { file in ShareSheet(items: [file.url]) }
            .sheet(isPresented: $receipt) { NavigationStack { ReceiptEditor(report: item) }.environmentObject(store) }
            .sheet(isPresented: $reissue) { NavigationStack { ReportComposer(reissue: item) }.environmentObject(store) }
    }
    private func run(_ action: @escaping () async throws -> Void) {
        working = true; error = nil
        Task { do { try await action() } catch { self.error = error.localizedDescription }; working = false }
    }
    private func download(_ format: String) {
        run { let file = try await store.export("/reports/\(item.id)/download?format=\(format)", suffix: format); cleanup = file; export = file }
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
    @State private var working = false
    @State private var error: String?
    var body: some View {
        Form {
            Section { Notice("Record a reference from a response you actually sent or received. This manual note does not certify transport or authority acceptance."); TextField("Response reference", text: $reference); DatePicker("Response date", selection: $date, displayedComponents: .date) }
            Section {
                Button("Record reference") {
                    working = true
                    Task {
                        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyy-MM-dd"
                        do { try await store.mutate("/reports/\(report.id)/receipts", body: ["expected_revision": .number(Double(report.revision)), "reference": .string(reference), "date": .string(formatter.string(from: date))]); dismiss() }
                        catch { self.error = error.localizedDescription }
                        working = false
                    }
                }.disabled(reference.isEmpty || working)
                if working { ProgressView("Saving reference…") }
                if let error { Notice(error, warning: true) }
            }
        }.navigationTitle("Response reference").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } } }
    }
}
