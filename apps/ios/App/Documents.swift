import SwiftUI
import UIKit
import VisionKit
import PDFKit
import UniformTypeIdentifiers
import QuickLook

struct DocumentIntakeView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var scan = false
    @State private var picker = false
    @State private var bytes: Data?
    @State private var filename = ""
    @State private var mime = "application/octet-stream"
    @State private var farm = ""
    @State private var problem: String?
    var body: some View {
        Form {
            Section {
                Notice("Scan a letter, receipt or form. Review the pages, select a farm, then save a private device draft. Upload starts only when you sync the outbox.")
                Button { scan = true } label: { Label("Scan pages with camera", systemImage: "camera.viewfinder") }.disabled(!VNDocumentCameraViewController.isSupported)
                if !VNDocumentCameraViewController.isSupported { Text("Scanning is unavailable on this device. Choose a file instead.").font(.footnote).foregroundStyle(.secondary) }
                Button { picker = true } label: { Label("Choose file", systemImage: "folder") }
            }
            if let bytes {
                Section("Review before assigning") {
                    EvidencePreview(bytes: bytes, mime: mime).frame(minHeight: 250).accessibilityLabel("Selected document preview")
                    TextField("Document filename", text: $filename)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(bytes.count), countStyle: .file)).font(.caption)
                    FarmPicker(selected: $farm, optional: true)
                    Text("Account: \(store.account?.user.email ?? "")\nWorkspace: \(store.account?.workspace.name ?? "")").font(.footnote)
                    Button("Save reviewed device draft") {
                        do { try store.saveDocument(bytes: bytes, filename: filename, mime: mime, farmID: farm.isEmpty ? nil : farm); dismiss() }
                        catch { problem = error.localizedDescription }
                    }.buttonStyle(.borderedProminent).disabled(filename.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Add document")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", role: .cancel) { dismiss() } } }
            .sheet(isPresented: $scan) {
                DocumentScanner { result in
                    scan = false
                    switch result {
                    case .success(let data): bytes = data; filename = "Scan-\(Date().formatted(.iso8601.year().month().day())).pdf"; mime = "application/pdf"
                    case .failure(let error): if !(error is CancellationError) { problem = error.localizedDescription }
                    }
                }
            }
            .fileImporter(isPresented: $picker, allowedContentTypes: [.pdf, .image, .plainText, .commaSeparatedText, .spreadsheet], allowsMultipleSelection: false) { result in
                do {
                    guard let url = try result.get().first else { return }
                    let granted = url.startAccessingSecurityScopedResource(); defer { if granted { url.stopAccessingSecurityScopedResource() } }
                    let attributes = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
                    guard (attributes.fileSize ?? 0) <= IntakeInbox.maximumFileBytes else { throw ServiceError(status: 0, message: "Choose a file no larger than 20 MB.") }
                    let data = try Data(contentsOf: url)
                    guard data.count <= IntakeInbox.maximumFileBytes else { throw ServiceError(status: 0, message: "Choose a file no larger than 20 MB.") }
                    bytes = data; filename = url.lastPathComponent; mime = attributes.contentType?.preferredMIMEType ?? "application/octet-stream"
                } catch { problem = error.localizedDescription }
            }
    }
}

struct DocumentScanner: UIViewControllerRepresentable {
    let completion: (Result<Data, Error>) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(completion: completion) }
    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController(); controller.delegate = context.coordinator; return controller
    }
    func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}
    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let completion: (Result<Data, Error>) -> Void
        init(completion: @escaping (Result<Data, Error>) -> Void) { self.completion = completion }
        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { completion(.failure(CancellationError())) }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) { completion(.failure(error)) }
        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            guard scan.pageCount > 0, scan.pageCount <= 20 else { completion(.failure(ServiceError(status: 0, message: "Scan between one and twenty pages per document."))); return }
            let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842))
            let data = renderer.pdfData { context in
                for page in 0..<scan.pageCount {
                    context.beginPage()
                    let image = scan.imageOfPage(at: page)
                    let scale = min(555 / image.size.width, 802 / image.size.height)
                    let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                    image.draw(in: CGRect(x: (595 - size.width) / 2, y: (842 - size.height) / 2, width: size.width, height: size.height))
                }
            }
            guard data.count <= IntakeInbox.maximumFileBytes else { completion(.failure(ServiceError(status: 0, message: "The scan exceeds 20 MB. Scan fewer pages or use a smaller PDF."))); return }
            completion(.success(data))
        }
    }
}

struct EvidencePreview: View {
    let bytes: Data
    let mime: String
    var body: some View {
        if mime == "application/pdf" { PDFEvidenceView(bytes: bytes) }
        else if let image = UIImage(data: bytes) { Image(uiImage: image).resizable().scaledToFit() }
        else if let text = String(data: bytes.prefix(20_000), encoding: .utf8) { ScrollView { Text(text).font(.callout).textSelection(.enabled) } }
        else { Notice("This format has no inline preview. Check the selected filename and original in its source application before assigning it.", warning: true) }
    }
}

struct PDFEvidenceView: UIViewRepresentable {
    let bytes: Data
    func makeCoordinator() -> Coordinator { Coordinator(bytes: bytes) }
    func makeUIView(context: Context) -> PDFView { let view = PDFView(); view.autoScales = true; view.document = PDFDocument(data: bytes); return view }
    func updateUIView(_ view: PDFView, context: Context) {
        if context.coordinator.bytes != bytes { context.coordinator.bytes = bytes; view.document = PDFDocument(data: bytes) }
    }
    final class Coordinator {
        var bytes: Data
        init(bytes: Data) { self.bytes = bytes }
    }
}

struct DocumentDetail: View {
    @EnvironmentObject private var store: AppStore
    let item: RecordItem
    @State private var working = false
    @State private var error: String?
    @State private var transcript = ""
    @State private var type = "unknown"
    @State private var request = false
    @State private var selectedProposal: ProposalSelection?
    @State private var original: ExportFile?
    @State private var exported: ExportFile?
    private var extraction: [String: JSONValue] { item.data["extraction"]?.object ?? [:] }
    private var documentType: String { item.data["document_type"]?.text ?? extraction["document_type"]?.text ?? "unknown" }
    var body: some View {
        List {
            Section {
                Text(item.title).font(.title2.bold())
                Button("View original privately") {
                    run { let file = try await store.export("/documents/\(item.id)/file", suffix: UTType(mimeType: item.value("media_type"))?.preferredFilenameExtension ?? "bin"); exported = file; original = file }
                }.disabled(working || !store.sessionVerified)
                LabeledContent("Pages", value: item.value("page_count"))
                Button("Review as administrative request") { request = true }
                if documentType == "receipt" {
                    NavigationLink("Record a checked purchase from this source") { WorkCaptureView(initialFarmID: item.value("farm_id").suppliedValue.isEmpty ? nil : item.value("farm_id"), initialDocumentID: item.id, initialKind: "purchases") }
                    NavigationLink("Record a checked sale from this source") { WorkCaptureView(initialFarmID: item.value("farm_id").suppliedValue.isEmpty ? nil : item.value("farm_id"), initialDocumentID: item.id, initialKind: "sales") }
                    Notice("Check whether your farm was the buyer or seller, then choose the matching financial record. An invoice or receipt does not establish product use, stock changes or an animal movement.")
                } else if documentType == "notebook" {
                    NavigationLink("Record checked work from this source") { WorkCaptureView(initialFarmID: item.value("farm_id").suppliedValue.isEmpty ? nil : item.value("farm_id"), initialDocumentID: item.id, initialKind: "operations") }
                }
            }
            Section("Extraction is a proposal") {
                if let status = extraction["status"] { LabeledContent("Processing state", value: status.text) }
                if let direction = extraction["transaction_direction"] { LabeledContent("Invoice direction in extraction", value: direction.text == "unreviewed" ? "Not reviewed" : direction.text) }
                if let failure = extraction["failure"] { Notice(failure.text, warning: true) }
                if let warnings = extraction["warnings"] { Text(warnings.text).font(.callout) }
                if let uncertain = extraction["uncertain_fields"], !uncertain.array.isEmpty { Notice("Uncertain fields: \(uncertain.text)", warning: true) }
                TextField("Optional manual transcription", text: $transcript, axis: .vertical).lineLimit(3...10)
                Picker("Document type", selection: $type) { Text("Unspecified").tag("unknown"); Text("Invoice / receipt").tag("receipt"); Text("Letter / request").tag("letter"); Text("Work notebook").tag("notebook") }
                Button("Request extraction proposals") {
                    run {
                        var body: [String: JSONValue] = ["expected_revision": .number(Double(item.revision)), "document_type": .string(type)]
                        if !transcript.isEmpty { body["text"] = .string(transcript) }
                        try await store.mutate("/documents/\(item.id)/extract", body: body)
                    }
                }.disabled(working || !store.sessionVerified)
                Notice("Extraction does not confirm farm facts. Unreadable fields can be transcribed manually. Processor policy is controlled by the service.")
            }
            Section("Fields to review") {
                let fields = extraction["fields"]?.array ?? []
                if fields.isEmpty { Text("No extracted fields are recorded. You can enter facts manually from My farm.").foregroundStyle(.secondary) }
                ForEach(Array(fields.enumerated()), id: \.offset) { index, value in
                    let field = value.object
                    DisclosureGroup(field["label"]?.text ?? field["key"]?.text ?? "Field \(index + 1)") {
                        Text(field["value"]?.text ?? "Unreadable / not supplied").font(.headline)
                        if let sources = field["sources"] { Text(sources.text).font(.caption).textSelection(.enabled) }
                        if documentType == "letter" {
                            Button("Review as a reusable farm detail") {
                                var linked = field
                                linked["sources"] = .array((field["sources"]?.array ?? []).map { source in var o = source.object; o["document_id"] = .string(item.id); o["document_revision"] = .number(Double(item.revision)); return .object(o) })
                                selectedProposal = ProposalSelection(data: linked)
                            }
                        }
                    }
                }
            }
            Section {
                if working { ProgressView("Waiting for service…") }
                if let error { Notice(error, warning: true) }
                if let url = BrowserHandoff.url(account: store.account, path: "/app/documents/\(item.id)") { Link("Review extracted proposal selections in the web workspace", destination: url) }
                RecordMetadata(item: item)
            }
        }.navigationTitle("Document")
            .onAppear { type = documentType }
            .sheet(isPresented: $request) { NavigationStack { RequestEditor(document: item) }.environmentObject(store) }
            .sheet(item: $selectedProposal) { value in NavigationStack { RecordEditor(collection: "facts", farmID: item.value("farm_id") == "Not supplied" ? nil : item.value("farm_id"), proposal: value.data) }.environmentObject(store) }
            .sheet(item: $original, onDismiss: { if let exported { store.removeExport(exported); self.exported = nil } }) { file in QuickLookEvidence(url: file.url) }
    }
    private func run(_ action: @escaping () async throws -> Void) {
        working = true; error = nil
        Task { do { try await action() } catch { self.error = error.localizedDescription }; working = false }
    }
    private struct ProposalSelection: Identifiable { let id = UUID(); let data: [String: JSONValue] }
}

struct QuickLookEvidence: UIViewControllerRepresentable {
    let url: URL
    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> QLPreviewController { let controller = QLPreviewController(); controller.dataSource = context.coordinator; return controller }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL; init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

struct SharedIntakeView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selected: SharedIntake?
    @State private var bytes: Data?
    @State private var farm = ""
    @State private var problem: String?
    var body: some View {
        List {
            Section { Notice("Shared files have no account binding and have never been uploaded. Review each file and explicitly assign it to this signed-in workspace.") }
            Section("Waiting on this device") {
                if store.sharedFiles.isEmpty { Text("No shared files are waiting. Use the iOS share sheet in Files, Photos or another application.").foregroundStyle(.secondary) }
                ForEach(store.sharedFiles) { item in
                    Button(item.filename) { do { bytes = try IntakeInbox.bytes(item); selected = item } catch { problem = error.localizedDescription } }
                }
            }
            if let selected, let bytes {
                Section("Review and bind") {
                    EvidencePreview(bytes: bytes, mime: selected.mimeType).frame(minHeight: 250)
                    Text(selected.filename)
                    Text("Assign to \(store.account?.user.email ?? "") · \(store.account?.workspace.name ?? "")").font(.headline)
                    FarmPicker(selected: $farm, optional: true)
                    Button("Assign reviewed copy to this account") {
                        do { try store.bind(selected, farmID: farm.isEmpty ? nil : farm); self.selected = nil; self.bytes = nil }
                        catch { problem = error.localizedDescription }
                    }.buttonStyle(.borderedProminent)
                    Button("Delete unassigned file", role: .destructive) {
                        do { try IntakeInbox.remove(selected); store.refreshShared(); self.selected = nil; self.bytes = nil }
                        catch { problem = error.localizedDescription }
                    }
                }
            }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Shared intake").onAppear { do { _ = try IntakeInbox.directory(); store.refreshShared() } catch { problem = error.localizedDescription } }
    }
}
