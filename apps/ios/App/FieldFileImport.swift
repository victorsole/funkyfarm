import SwiftUI
import UniformTypeIdentifiers
import CryptoKit

private enum FieldFileReader {
    static let maximumBytes = 512_000
    struct Source { let filename: String; let format: String; let contents: String; let sha256: String }
    static func read(_ url: URL) throws -> Source {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let suffix = url.pathExtension.lowercased()
        guard ["geojson", "json", "kml"].contains(suffix) else { throw ServiceError(status: 0, message: "Choose an uncompressed GeoJSON (.geojson or .json) or KML (.kml) file. ZIP files are not supported.") }
        if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > maximumBytes { throw ServiceError(status: 0, message: "Choose a field file no larger than 512,000 bytes.") }
        guard let stream = InputStream(url: url) else { throw ServiceError(status: 0, message: "This local file could not be opened.") }
        stream.open(); defer { stream.close() }
        var bytes = Data(), buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw ServiceError(status: 0, message: "The complete field file could not be read. Nothing was uploaded.") }
            if count == 0 { break }
            guard count <= maximumBytes - bytes.count else { throw ServiceError(status: 0, message: "The actual file exceeds 512,000 bytes. Nothing was uploaded.") }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        guard !bytes.isEmpty, String(data: bytes, encoding: .utf8) != nil else { throw ServiceError(status: 0, message: "Choose a nonempty, valid UTF-8 field file. Invalid characters will not be replaced or guessed.") }
        let contents = String(decoding: bytes, as: UTF8.self)
        guard Data(contents.utf8) == bytes else { throw ServiceError(status: 0, message: "The original UTF-8 bytes could not be retained. Nothing was uploaded.") }
        return Source(filename: url.lastPathComponent, format: suffix == "kml" ? "kml" : "geojson", contents: contents, sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    }
}

struct FieldFileImportView: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    var onProposed: () -> Void = {}
    @State private var baseline: RecordItem?
    @State private var originalFarmRevision: Int?
    @State private var accountScope: String?
    @State private var comparison: RecordItem?
    @State private var source: FieldFileReader.Source?
    @State private var sourceYear = ""
    @State private var sourceOrigin = ""
    @State private var preview: RecordItem?
    @State private var previewVerified = false
    @State private var selected: Set<String> = []
    @State private var note = ""
    @State private var acknowledged = false
    @State private var offset = 0
    @State private var uploadKey = UUID().uuidString
    @State private var proposalKey = UUID().uuidString
    // Contents are deliberately never included in this protected metadata draft.
    @State private var uploadIntent: [String: JSONValue]?
    @State private var proposalIntent: [String: JSONValue]?
    @State private var recoveredPreviewID: String?
    @State private var proposal: RecordItem?
    @State private var choosing = false
    @State private var confirmation = false
    @State private var resetConfirmation = false
    @State private var busy = false
    @State private var rejected = false
    @State private var loaded = false
    @State private var bindingID = UUID()
    @State private var operationTask: Task<Void, Never>?
    @State private var problem: String?
    private var formKey: String { "field-file-import:" + farmID }
    private var currentFarm: RecordItem? { store.record("farms", farmID) }
    private var rows: [[String: JSONValue]] { preview?.data["rows"]?.array.map(\.object) ?? [] }
    private var visibleRows: [[String: JSONValue]] { Array(rows.dropFirst(offset).prefix(10)) }
    private var currentBaseline: Bool { guard let baseline, baseline.workspace_id == store.account?.workspace.id, currentFarm?.revision == baseline.revision else { return false }; return preview == nil || preview?.data["farm_revision"] == .number(Double(baseline.revision)) }
    private var validYear: Bool { sourceYear.isEmpty || (sourceYear.count == 4 && sourceYear.utf8.allSatisfy { (48...57).contains($0) } && (1900...2200).contains(Int(sourceYear) ?? 0)) }
    private var canPreview: Bool { source != nil && store.sessionVerified && !busy && proposalIntent == nil && (uploadIntent != nil || (currentBaseline && validYear && ["my_file", "public_reference"].contains(sourceOrigin))) }
    private var canPropose: Bool { previewVerified && preview?.state == "preview" && currentBaseline && store.sessionVerified && !busy && proposal == nil && !selected.isEmpty && selected.count <= 20 && !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && acknowledged }
    var body: some View {
        List {
            Section("Bring an existing field file") {
                Text(baseline?.title ?? currentFarm?.title ?? "Selected farm").font(.headline)
                Text("Preview a GeoJSON or KML file, then select the outlines you want to propose. This does not match or overwrite existing fields, assign official parcel identifiers, or change an authority's records.")
                Button(source == nil ? "Choose a local GeoJSON or KML file" : "Choose another file") { choosing = true }.disabled(busy || preview != nil || proposalIntent != nil || !store.sessionVerified)
                if let source { LabeledContent("Local file", value: source.filename); LabeledContent("Format", value: source.format.uppercased()); Text("\(source.contents.utf8.count) actual UTF-8 bytes read. File contents stay in memory on this device; the service receives them only when you ask for a preview.").font(.footnote) }
                else if uploadIntent != nil { Notice("Reselect the identical original file to retry this saved request. Its contents were not saved on this device; filename, hash and the exact retry metadata were retained privately.", warning: true) }
                Picker("Where did this file come from?", selection: $sourceOrigin) { Text("Choose the actual source").tag(""); Text("My own field file").tag("my_file"); Text("A public comparison reference").tag("public_reference") }.disabled(busy || uploadIntent != nil || preview != nil)
                TextField("Actual source year, if known (otherwise leave blank)", text: $sourceYear).keyboardType(.numberPad).disabled(busy || uploadIntent != nil || preview != nil)
                if sourceOrigin == "public_reference" { Notice("A public outline is a comparison reference, not proof that it belongs to this farm or is an accepted LPIS boundary. Choose and review it yourself.", warning: true) }
                if !validYear { Notice("Use the actual four-digit source year, or leave it blank when unknown. No current year is inferred.", warning: true) }
                if let baseline { LabeledContent("Farm revision used for this preview", value: String(baseline.revision)) }
                else if let originalFarmRevision { LabeledContent("Saved original farm revision — not rebased", value: String(originalFarmRevision)) }
                Button(uploadIntent == nil ? "Create a file preview — do not change fields" : "Retry the exact saved preview request") { upload() }.disabled(!canPreview || preview != nil)
            }
            if let preview {
                Section("Choose up to 20 outlines from the preview") {
                    Text(preview.value("filename")).font(.headline)
                    LabeledContent("Actual source year", value: SourceText.year(preview.data["source_year"]) ?? "Unknown — not inferred")
                    LabeledContent("Recorded origin", value: preview.value("source_origin") == "public_reference" ? "Public comparison reference" : "My own field file")
                    if let notice = preview.data["notice"] { Notice(notice.text) }
                    Text("\(rows.count) source rows loaded. \(selected.count) explicitly selected. Rows are not selected automatically.")
                    if !previewVerified { Notice("This saved preview is not currently verified for a new proposal. Reload it before acknowledging a new selection.", warning: true) }
                    if rows.isEmpty { Notice("The service returned an empty preview. No field is assumed to have been imported.", warning: true) }
                    ForEach(visibleRows, id: \.self) { row in rowView(row) }
                    if rows.count > 10 { HStack { Button("Previous ten rows") { offset = max(0, offset - 10) }.disabled(busy || offset == 0); Spacer(); Button("Next ten rows") { offset += 10 }.disabled(busy || offset + 10 >= rows.count) }; Text("Showing rows \(offset + 1)–\(min(offset + 10, rows.count)) of \(rows.count)").font(.footnote) }
                    Button("Reload this exact saved preview") { reloadPreview(preview.id) }.disabled(busy || !store.sessionVerified)
                }
                Section("Make one proposal for my selected outlines") {
                    TextField("Why do these selected outlines belong in this proposal?", text: $note, axis: .vertical).disabled(busy || proposalIntent != nil || proposal != nil)
                    Toggle("I checked every selected outline, its source and warnings; these are proposed new fields, not an overwrite or official update", isOn: $acknowledged).disabled(busy || proposalIntent != nil || proposal != nil)
                    Button(proposalIntent == nil ? "Save one proposal for the selected outlines" : "Retry the exact saved proposal request") { confirmation = true }.buttonStyle(.borderedProminent).disabled(proposalIntent == nil ? !canPropose : busy || !store.sessionVerified || proposal != nil)
                    Notice("The proposal keeps all selected outlines together. Your retained farm fields change only after a separate explicit review and approval of that whole proposal.")
                }
            } else if let recoveredPreviewID { Section { Notice("A saved preview has not loaded. Missing rows are not treated as empty or complete.", warning: true); Button("Reload my saved preview") { reloadPreview(recoveredPreviewID) }.disabled(busy || !store.sessionVerified) } }
            if let proposal {
                Section("Proposal saved — not approved") {
                    Notice("One proposal was saved. No retained field was added or changed by this step.")
                    Text("The saved proposal contains \(proposal.data["import_source"]?.object["selected_ids"]?.array.count ?? 0) outlines. The selections above are retained device choices for comparison; open the proposal to review its actual complete selection.").font(.footnote)
                    NavigationLink("Review all selected outlines and approve separately") { FieldProposalReview(proposal: proposal, farmID: farmID) }
                    Button("Refresh the retained fields and current farm") { refreshAfterProposal() }.disabled(busy || !store.sessionVerified)
                }
            }
            Section("Current farm and safe recovery") {
                if !currentBaseline, baseline != nil { Notice("The farm revision or preview context changed. No proposal can be rebased or approved here automatically. Compare the current farm before starting another preview.", warning: true) }
                Button("Load the current farm for comparison") { compareFarm() }.disabled(busy || !store.sessionVerified)
                if let comparison { Text(comparison.title + " · current revision \(comparison.revision)"); DisclosureGroup("Retained fields at this compared revision") { Text(comparison.data["parcels"]?.text ?? "No field values are recorded.").textSelection(.enabled) }; Button("Discard this preview intent and start at this compared revision") { resetConfirmation = true }.disabled(busy || ((uploadIntent != nil || proposalIntent != nil) && !rejected && proposal == nil)) }
                if uploadIntent != nil || proposalIntent != nil { Notice("A lost response may mean the exact request already succeeded. Retry the retained request key or reload its saved preview; do not submit a changed replacement to compensate for an uncertain result.", warning: true) }
                if busy { ProgressView("Loading or saving this field-file workflow…"); Button("Cancel this request") { cancel() } }
                if !store.sessionVerified { Notice("Reconnect before loading or saving. No file or proposal is synchronized automatically.", warning: true) }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("Preview a field file").autocorrectionDisabled().textInputAutocapitalization(.never)
            .task(id: farmID) { await restore() }
            .fileImporter(isPresented: $choosing, allowedContentTypes: [.json, UTType(filenameExtension: "geojson") ?? .json, UTType(filenameExtension: "kml") ?? UTType(importedAs: "com.google.earth.kml")], allowsMultipleSelection: false) { result in choose(result) }
            .confirmationDialog("Save one proposal containing exactly \(selected.count) selected outlines? Nothing is approved or officially submitted.", isPresented: $confirmation, titleVisibility: .visible) { Button("Save this field-import proposal") { propose() } }
            .confirmationDialog("Discard this device preview intent and selection? The saved service preview and any existing proposal are not deleted. No earlier request is replayed or rebased.", isPresented: $resetConfirmation, titleVisibility: .visible) { Button("Start a new preview at the compared revision", role: .destructive) { resetAtComparison() } }
            .onChange(of: selected) { _ in if proposalIntent == nil { acknowledged = false; persistQuietly() } }
            .onChange(of: note) { _ in if proposalIntent == nil { acknowledged = false; persistQuietly() } }
            .onChange(of: currentFarm?.revision) { _ in if !currentBaseline { acknowledged = false; previewVerified = false } }
            .onChange(of: store.sessionVerified) { verified in if !verified { cancel(); acknowledged = false; previewVerified = false } }
            .onChange(of: store.account?.scope) { _ in cancel(); source = nil; preview = nil; proposal = nil; baseline = nil; selected = []; acknowledged = false; previewVerified = false }
            .onDisappear { cancel(); source = nil; previewVerified = false }
    }
    private func rowView(_ row: [String: JSONValue]) -> some View {
        let id = row["id"]?.text ?? ""
        return VStack(alignment: .leading, spacing: 5) {
            Toggle(row["name"]?.text ?? "Source field", isOn: Binding(get: { selected.contains(id) }, set: { if $0 { if selected.count < 20 { selected.insert(id) } } else { selected.remove(id) } })).disabled(busy || proposalIntent != nil || proposal != nil || preview?.state != "preview" || (!selected.contains(id) && selected.count >= 20))
            if let crop = row["crop"], crop != .null { LabeledContent("Recorded crop", value: crop.text) }
            if let external = row["external_id"], external != .null { LabeledContent("Identifier supplied by the file — not verified", value: external.text).textSelection(.enabled) }
            ForEach(Array((row["warnings"]?.array ?? []).enumerated()), id: \.offset) { _, warning in Notice(warning.object["message"]?.text ?? warning.text, warning: true) }
            DisclosureGroup("Compare this actual outline") { FieldMap(field: row).frame(height: 230); if let summary = row["geometry_summary"] { SourceRowCells(value: summary.object) }; Text("This map shows the supplied outline, not an accepted authority boundary.").font(.footnote) }
        }.padding(.vertical, 5)
    }
    private func choose(_ result: Result<[URL], Error>) {
        do {
            guard let url = try result.get().first else { return }; let file = try FieldFileReader.read(url)
            if let uploadIntent { guard uploadIntent["filename"] == .string(file.filename), uploadIntent["format"] == .string(file.format), uploadIntent["sha256"] == .string(file.sha256) else { throw ServiceError(status: 0, message: "This is not the exact file bound to the saved retry. Choose the original unchanged file; no changed contents will be sent under its key.") } }
            source = file; problem = nil
        } catch { problem = SourceText.error(error) }
    }
    private func persist() throws {
        guard let accountScope, accountScope == store.account?.scope else { throw CancellationError() }
        try store.saveForm(formKey, value: ["farm_id": .string(farmID), "baseline_revision": originalFarmRevision.map { .number(Double($0)) } ?? .null, "upload_intent": uploadIntent.map(JSONValue.object) ?? .null, "upload_key": .string(uploadKey), "preview_id": (preview?.id ?? recoveredPreviewID).map(JSONValue.string) ?? .null, "selected_ids": .array(selected.sorted().map(JSONValue.string)), "note": .string(note), "proposal_intent": proposalIntent.map(JSONValue.object) ?? .null, "proposal_key": .string(proposalKey), "rejected": .bool(rejected)])
    }
    private func persistQuietly() { guard loaded else { return }; do { try persist() } catch { problem = SourceText.error(error) } }
    private func restore() async {
        guard !loaded else { return }; accountScope = store.account?.scope; loaded = true; let stamp = bindingID; busy = true; defer { if stamp == bindingID { busy = false } }
        do {
            let saved = try store.loadForm(formKey)
            if saved?["farm_id"] == .string(farmID) {
                if case .object(let intent)? = saved?["upload_intent"] { uploadIntent = intent; sourceYear = SourceText.year(intent["source_year"]) ?? ""; sourceOrigin = intent["source_origin"]?.text ?? "" }
                if case .object(let intent)? = saved?["proposal_intent"] { proposalIntent = intent }
                uploadKey = saved?["upload_key"]?.text ?? uploadKey; proposalKey = saved?["proposal_key"]?.text ?? proposalKey; recoveredPreviewID = saved?["preview_id"]?.text
                selected = Set((saved?["selected_ids"]?.array ?? []).compactMap(\.text)); note = saved?["note"]?.text ?? ""; rejected = saved?["rejected"] == .bool(true)
                originalFarmRevision = SourceText.year(saved?["baseline_revision"] ?? uploadIntent?["expected_farm_revision"] ?? proposalIntent?["expected_farm_revision"]).flatMap { Int($0) }
            }
            let farm = try await store.refreshDetail("farms", farmID); guard stamp == bindingID, store.sessionVerified, !Task.isCancelled else { return }
            comparison = farm
            if let old = originalFarmRevision, old != farm.revision { problem = "This saved workflow uses farm revision \(old), not the current revision \(farm.revision). Its retry bodies remain unchanged. Compare before starting a new preview." }
            else { baseline = farm; originalFarmRevision = farm.revision }
            if let recoveredPreviewID { try await loadPreview(recoveredPreviewID, stamp: stamp) }
        } catch { if stamp == bindingID { problem = SourceText.error(error) } }
    }
    private func validatePreview(_ value: JSONValue) throws -> RecordItem {
        let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value))
        guard record.kind == "field_imports", record.workspace_id == store.account?.workspace.id, record.value("farm_id") == farmID, ["preview", "proposed"].contains(record.state), let farmRevision = SourceText.year(record.data["farm_revision"]).flatMap({ Int($0) }), farmRevision > 0, ["my_file", "public_reference"].contains(record.value("source_origin")), case .array(let rows)? = record.data["rows"], rows.count <= 100, Set(rows.compactMap { $0.object["id"]?.text }).count == rows.count, rows.allSatisfy({ UUID(uuidString: $0.object["id"]?.text ?? "") != nil && $0.object["geometry"] != nil && $0.object["geometry_summary"] != nil && $0.object["warnings"] != nil }) else { throw ServiceError(status: 0, message: "The complete preview did not match this private farm or its bounded source rows. Nothing can be selected.") }
        return record
    }
    private func loadPreview(_ id: String, stamp: UUID) async throws {
        previewVerified = false; acknowledged = false
        guard UUID(uuidString: id) != nil else { throw ServiceError(status: 0, message: "The saved preview reference is invalid.") }
        let value = try await store.scopedValue("/field-imports/\(id)"); let record = try validatePreview(value)
        guard stamp == bindingID, store.sessionVerified, !Task.isCancelled else { return }
        guard record.id == id else { throw ServiceError(status: 0, message: "The service returned another field preview.") }
        if let previous = preview, previous.revision != record.revision { acknowledged = false; problem = "This preview changed. The saved selection and pending request are not rebased; compare its current rows first." }
        preview = record; previewVerified = true; sourceYear = SourceText.year(record.data["source_year"]) ?? ""; sourceOrigin = record.value("source_origin"); recoveredPreviewID = id; offset = 0; selected.formIntersection(Set(rows.compactMap { $0["id"]?.text })); try persist()
        if record.state == "proposed" {
            guard let proposalID = record.data["proposal_id"]?.text, UUID(uuidString: proposalID) != nil else { throw ServiceError(status: 0, message: "This preview is already proposed, but its exact proposal reference did not load. Do not create another batch.") }
            let existing = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(try await store.scopedValue("/field-proposals/\(proposalID)")))
            guard stamp == bindingID, store.sessionVerified, !Task.isCancelled else { return }
            guard existing.id == proposalID, existing.kind == "field_change_proposals", existing.workspace_id == store.account?.workspace.id, existing.value("farm_id") == farmID, existing.value("operation") == "import", existing.data["import_source"]?.object["id"] == .string(id) else { throw ServiceError(status: 0, message: "The existing import proposal could not be verified for this private farm. Do not create a replacement batch.") }
            proposal = existing; proposalIntent = nil; acknowledged = false; rejected = false; try store.clearForm(formKey); onProposed()
        }
    }
    private func reloadPreview(_ id: String) {
        guard !busy else { return }; let stamp = bindingID; busy = true; problem = nil
        operationTask = Task { defer { if stamp == bindingID { busy = false; operationTask = nil } }; do { try await loadPreview(id, stamp: stamp) } catch { if stamp == bindingID { acknowledged = false; problem = SourceText.error(error) } } }
    }
    private func upload() {
        guard canPreview, let source else { return }
        if uploadIntent == nil { guard let baseline else { return }; uploadIntent = ["expected_farm_revision": .number(Double(baseline.revision)), "filename": .string(source.filename), "format": .string(source.format), "sha256": .string(source.sha256), "source_year": sourceYear.isEmpty ? .null : .number(Double(Int(sourceYear) ?? 0)), "source_origin": .string(sourceOrigin)]; uploadKey = UUID().uuidString }
        guard let intent = uploadIntent, intent["sha256"] == .string(source.sha256) else { return }
        var body = intent; body.removeValue(forKey: "sha256"); body["contents"] = .string(source.contents)
        do { try persist() } catch { problem = SourceText.error(error); return }
        let stamp = bindingID; busy = true; problem = nil
        operationTask = Task {
            defer { if stamp == bindingID { busy = false; operationTask = nil } }
            do {
                let record = try validatePreview(try await store.scopedValue("/farms/\(farmID)/field-imports", method: "POST", body: body, idempotency: uploadKey))
                guard stamp == bindingID, store.sessionVerified, !Task.isCancelled else { return }
                guard UUID(uuidString: record.id) != nil, record.data["sha256"] == intent["sha256"], record.data["filename"] == intent["filename"], record.data["format"] == intent["format"], record.data["source_year"] == intent["source_year"], record.data["source_origin"] == intent["source_origin"], record.data["farm_revision"] == intent["expected_farm_revision"] else { throw ServiceError(status: 0, message: "The returned preview did not match the original file, source choices and farm revision. Its retry request remains retained.") }
                preview = record; previewVerified = true; sourceYear = SourceText.year(record.data["source_year"]) ?? ""; sourceOrigin = record.value("source_origin"); recoveredPreviewID = record.id; selected = []; acknowledged = false; self.source = nil; uploadIntent = nil; rejected = false; try persist()
            }
            catch { if stamp == bindingID { rejected = [400, 404, 409, 413, 422].contains((error as? ServiceError)?.status ?? 0); try? persist(); problem = SourceText.error(error) } }
        }
    }
    private func propose() {
        guard proposalIntent != nil || canPropose, let preview else { return }
        if proposalIntent == nil { proposalIntent = ["expected_revision": .number(Double(preview.revision)), "expected_farm_revision": preview.data["farm_revision"] ?? .null, "selected_ids": .array(selected.sorted().map(JSONValue.string)), "note": .string(note), "acknowledged": .bool(true)]; proposalKey = UUID().uuidString }
        guard let body = proposalIntent else { return }; do { try persist() } catch { problem = SourceText.error(error); return }
        let stamp = bindingID; busy = true; problem = nil
        operationTask = Task {
            defer { if stamp == bindingID { busy = false; operationTask = nil } }
            do {
                let value = try await store.scopedValue("/field-imports/\(preview.id)/propose", method: "POST", body: body, idempotency: proposalKey)
                let imported = try validatePreview(value.object["import"] ?? .null), proposed = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value.object["proposal"] ?? .null))
                guard stamp == bindingID, store.sessionVerified, !Task.isCancelled else { return }
                guard imported.id == preview.id, imported.data["proposal_id"] == .string(proposed.id), proposed.kind == "field_change_proposals", proposed.workspace_id == store.account?.workspace.id, proposed.value("farm_id") == farmID, proposed.state == "proposed", proposed.value("operation") == "import", proposed.data["import_source"]?.object["id"] == .string(preview.id), proposed.data["import_source"]?.object["selected_ids"] == body["selected_ids"] else { throw ServiceError(status: 0, message: "The complete proposal did not match this farm's selected field import.") }
                self.preview = imported; proposal = proposed; proposalIntent = nil; acknowledged = false; rejected = false; try store.clearForm(formKey)
                _ = try? await store.loadFieldLibrary(farmID); guard stamp == bindingID else { return }; onProposed()
            } catch { if stamp == bindingID { rejected = [400, 404, 409, 413, 422].contains((error as? ServiceError)?.status ?? 0); try? persist(); problem = SourceText.error(error) } }
        }
    }
    private func compareFarm() {
        guard !busy else { return }; let stamp = bindingID; busy = true
        operationTask = Task { defer { if stamp == bindingID { busy = false; operationTask = nil } }; do { let farm = try await store.refreshDetail("farms", farmID); guard stamp == bindingID, store.sessionVerified, !Task.isCancelled else { return }; comparison = farm } catch { if stamp == bindingID { problem = SourceText.error(error) } } }
    }
    private func resetAtComparison() {
        guard accountScope == store.account?.scope, let comparison, comparison.workspace_id == store.account?.workspace.id, currentFarm?.revision == comparison.revision else { problem = "Reload the comparison before starting a new preview."; return }
        cancel(); baseline = comparison; originalFarmRevision = comparison.revision; source = nil; preview = nil; previewVerified = false; proposal = nil; recoveredPreviewID = nil; selected = []; note = ""; sourceYear = ""; sourceOrigin = ""; uploadIntent = nil; proposalIntent = nil; uploadKey = UUID().uuidString; proposalKey = UUID().uuidString; rejected = false; acknowledged = false; offset = 0
        do { try store.clearForm(formKey) } catch { problem = SourceText.error(error) }
    }
    private func refreshAfterProposal() {
        let stamp = bindingID; busy = true
        operationTask = Task { defer { if stamp == bindingID { busy = false; operationTask = nil } }; do { _ = try await store.loadFieldLibrary(farmID); _ = try await store.refreshDetail("farms", farmID); guard stamp == bindingID else { return }; onProposed() } catch { if stamp == bindingID { problem = SourceText.error(error) } } }
    }
    private func cancel() { bindingID = UUID(); operationTask?.cancel(); operationTask = nil; busy = false }
}
