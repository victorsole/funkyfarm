import Foundation
import SwiftUI
import UniformTypeIdentifiers

@MainActor final class AppStore: ObservableObject {
    @Published private(set) var account: Account?
    @Published private(set) var disk = AccountDiskState()
    @Published private(set) var packs: [Pack] = []
    @Published private(set) var packCountry = ""
    @Published private(set) var packYear: Int?
    @Published private(set) var sharedFiles: [SharedIntake] = []
    @Published var error: String?
    @Published private(set) var busy = false
    @Published private(set) var syncing = false
    @Published var tab = 0
    @Published var route: RecordRoute?
    @Published var sessionVerified = false
    private var storage: PrivateStore?
    private var generation = UUID()
    private var activeExports: [UUID: ProtectedFileTransfer] = [:]
    private var completedExports: [UUID: URL] = [:]
    var api: FarmAPI? {
        guard let account, let url = URL(string: account.baseURL) else { return nil }
        return FarmAPI(baseURL: url, token: account.token, workspaceID: account.workspace.id)
    }
    func records(_ collection: String) -> [RecordItem] { disk.records[collection] ?? [] }
    func record(_ collection: String, _ id: String) -> RecordItem? { records(collection).first { $0.id == id } }
    var reviewFacts: [RecordItem] { records("facts").filter { $0.state == "proposed" } }
    func boot() async {
        guard account == nil, let saved = CredentialVault.load() else { return }
        do { try install(saved); await verifyAndRefresh() }
        catch { error = "Private data could not be opened: \(error.localizedDescription)" }
    }
    private func install(_ account: Account) throws {
        let store = try PrivateStore(scope: account.scope, accountKey: account.baseURL + "/" + account.user.id)
        var loaded = try store.load()
        guard loaded.queue.allSatisfy({ $0.scope == account.scope }), loaded.records.values.joined().allSatisfy({ $0.workspace_id == account.workspace.id }) else { throw ServiceError(status: 0, message: "The saved records do not match this private account.") }
        // Migrate older caches before displaying or persisting any report records.
        loaded.records["reports"] = loaded.records["reports"]?.map(ReportTransport.compact)
        for index in loaded.queue.indices where Self.isReportApproval(loaded.queue[index].path) { loaded.queue[index].state = .review; loaded.queue[index].problem = "Open the exact current report review before making a new explicit approval. Saved approval actions are not synchronized automatically." }
        try store.save(loaded); try store.clearOldExports(); clearExportFiles()
        generation = UUID(); storage = store; disk = loaded; self.account = account
        sessionVerified = false; packs = []; packCountry = ""; packYear = nil; error = nil
        refreshShared()
    }
    func authenticate(base: String, email: String, password: String, displayName: String, register: Bool) async throws {
        guard !busy else { return }
        busy = true; defer { busy = false }
        let url = try FarmAPI.validatedBase(base)
        let client = FarmAPI(baseURL: url)
        var body: [String: JSONValue] = ["email": .string(email), "password": .string(password)]
        if register { body["display_name"] = .string(displayName) }
        let response = try JSONDecoder().decode(AuthResponse.self, from: await client.send(register ? "/auth/register" : "/auth/login", method: "POST", body: body))
        guard let token = response.token, !token.isEmpty else { throw ServiceError(status: 0, message: "The service did not return a native bearer token.") }
        let newAccount = Account(user: response.user, workspace: response.workspace, token: token, baseURL: url.absoluteString)
        try CredentialVault.save(newAccount)
        try install(newAccount); sessionVerified = true
        await refresh()
    }
    func verifyAndRefresh() async {
        guard let api, let account else { return }
        let current = generation
        do {
            let session = try JSONDecoder().decode(AuthResponse.self, from: await api.send("/auth/session"))
            guard current == generation else { return }
            guard session.user.id == account.user.id, session.workspace.id == account.workspace.id else { throw ServiceError(status: 401, message: "The service session no longer matches this private workspace. Sign out and sign in again.") }
            sessionVerified = true
            await refresh()
        } catch { if current == generation { sessionVerified = false; self.error = error.localizedDescription } }
    }
    func refresh() async {
        guard let api, sessionVerified else { return }
        let current = generation
        busy = true; defer { if current == generation { busy = false } }
        var failures: [String] = []
        for collection in ["farms", "facts", "requests", "documents", "reports", "operations", "purchases", "sales", "tasks", "checklists"] {
            do {
                var items: [RecordItem] = []; var offset = 0
                // Source facts may retain a complete large CSV row; keep their page below the API response cap.
                let pageLimit = collection == "facts" ? 20 : 100
                while true {
                    let page = try JSONDecoder().decode(RecordPage.self, from: await api.send("/\(collection)?limit=\(pageLimit)&offset=\(offset)"))
                    items.append(contentsOf: page.items)
                    offset += page.items.count
                    if offset >= page.total || page.items.isEmpty { break }
                }
                guard current == generation else { return }
                guard items.allSatisfy({ $0.workspace_id == self.account?.workspace.id }) else { throw ServiceError(status: 0, message: "The service returned records outside the selected workspace. They were not saved.") }
                disk.records[collection] = collection == "reports" ? items.map(ReportTransport.compact) : items
            } catch {
                if let failure = error as? ServiceError, failure.status == 401 { sessionVerified = false }
                failures.append("\(collection.capitalized): \(error.localizedDescription)")
            }
        }
        guard current == generation else { return }
        if failures.isEmpty { disk.lastRefresh = Date(); error = nil }
        else { error = failures.joined(separator: "\n") }
        do { try persist() } catch { self.error = "Could not save the refreshed records: \(error.localizedDescription)" }
        await loadHome()
        refreshShared()
    }
    func loadHome(farmID: String? = nil, year: Int = Calendar.current.component(.year, from: Date())) async {
        guard let api, sessionVerified else { return }
        let current = generation
        let query = "?year=\(year)" + (farmID.map { "&farm_id=\($0)" } ?? "")
        do {
            let home = try JSONDecoder().decode(JSONValue.self, from: await api.send("/workflow/home" + query)).object
            guard current == generation else { return }
            disk.workflowHome = home; try persist()
        } catch { if current == generation { self.error = error.localizedDescription } }
    }
    func scopedValue(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil, idempotency: String? = nil) async throws -> JSONValue {
        guard let api, sessionVerified else { throw ServiceError(status: 0, message: "Reconnect to load or save reviewed service information.") }
        let current = generation
        let value = try JSONDecoder().decode(JSONValue.self, from: await api.send(path, method: method, body: body, idempotency: idempotency))
        guard current == generation else { throw CancellationError() }
        return value
    }
    func checkCapture(_ body: [String: JSONValue]) async throws -> CaptureCheck {
        let value = try await scopedValue("/workflow/check", method: "POST", body: body)
        return try JSONDecoder().decode(CaptureCheck.self, from: JSONEncoder().encode(value))
    }
    func loadFieldLibrary(_ farmID: String) async throws -> [String: JSONValue] {
        let value = try await scopedValue("/farms/\(farmID)/fields")
        disk.fieldLibraries[farmID] = value; try persist()
        return value.object
    }
    func importCSV(bytes: Data, filename: String, grain: String, farmID: String?, idempotency: String, formatProfile: String? = nil, sourceYear: String? = nil, delimiter: String = ",") async throws -> RecordItem {
        guard let api, sessionVerified else { throw ServiceError(status: 0, message: "Reconnect before importing records.") }
        guard bytes.count <= IntakeInbox.maximumFileBytes else { throw ServiceError(status: 0, message: "A native import must be at most 20 MB.") }
        let current = generation
        var fields = ["grain": grain, "delimiter": delimiter]
        if let farmID { fields["farm_id"] = farmID }
        if let formatProfile { fields["format_profile"] = formatProfile }
        if let sourceYear { fields["source_year"] = sourceYear }
        let item = try JSONDecoder().decode(RecordItem.self, from: await api.multipart(path: "/imports", filename: filename, mime: "text/csv", bytes: bytes, fields: fields, idempotency: idempotency))
        guard generation == current, item.workspace_id == account?.workspace.id else { throw CancellationError() }
        return item
    }
    func stageImportSource(_ bytes: Data) throws -> String {
        guard let storage else { throw ServiceError(status: 0, message: "Open an account before saving this private import source.") }
        return try storage.stage(bytes, extension: "csv")
    }
    func removeImportSource(_ name: String) throws {
        guard let storage else { throw ServiceError(status: 0, message: "No private account is open.") }
        try storage.removeAttachment(name)
    }
    func selectWorkspace(_ workspace: [String: JSONValue]) async throws {
        guard let old = account, !syncing, !busy,
              let id = workspace["id"]?.text, let name = workspace["name"]?.text, let role = workspace["role"]?.text,
              let url = URL(string: old.baseURL) else { throw ServiceError(status: 0, message: "Wait for the current operation before switching workspace.") }
        busy = true; let current = generation
        defer { if current == generation { busy = false } }
        let candidate = FarmAPI(baseURL: url, token: old.token, workspaceID: id)
        let verified = try JSONDecoder().decode(AuthResponse.self, from: await candidate.send("/auth/session"))
        guard generation == current, verified.user.id == old.user.id, verified.workspace.id == id else { throw ServiceError(status: 0, message: "The selected workspace was not authorized by the service.") }
        let next = Account(user: old.user, workspace: Account.Workspace(id: id, name: name, role: role), token: old.token, baseURL: old.baseURL)
        try CredentialVault.save(next); try install(next); sessionVerified = true; busy = false
        await refresh()
    }
    @discardableResult func saveCaptureDraft(body: [String: JSONValue], review: CaptureCheck?, acknowledged: Set<String>, replacing: UUID? = nil, path: String = "/workflow/capture", label: String? = nil, reviewContext: [String: JSONValue]? = nil) throws -> UUID {
        guard let account, !syncing else { throw ServiceError(status: 0, message: "Wait for synchronization before changing a draft.") }
        guard disk.queue.count < 50 || replacing != nil else { throw ServiceError(status: 0, message: "The device outbox has reached 50 drafts.") }
        var payload = body
        if let review {
            guard review.can_save, Set(review.requires_acknowledgement).isSubset(of: acknowledged) else { throw ServiceError(status: 0, message: "Resolve the errors and acknowledge each warning before queueing this record.") }
            payload["_reviewed"] = review.reviewValue
            payload["acknowledged_codes"] = .array(acknowledged.sorted().map(JSONValue.string))
        }
        guard ["/workflow/capture", "/workflow/answer"].contains(path) else { throw ServiceError(status: 0, message: "This draft type is not supported.") }
        var edit = PendingEdit(scope: account.scope, path: path, label: label ?? body["data"]?.object["title"]?.text ?? "Work record", payload: payload, reviewContext: reviewContext)
        if let review {
            var approved = body
            approved["check_token"] = .string(review.check_token)
            approved["acknowledged_codes"] = .array(acknowledged.sorted().map(JSONValue.string))
            if path == "/workflow/answer" { approved["preview"] = .bool(false) }
            edit.approvedRequest = approved
        }
        edit.state = review == nil ? .review : .pending
        let before = disk.queue
        if let replacing { disk.queue.removeAll { $0.id == replacing } }
        disk.queue.append(edit)
        do { try persist() } catch { disk.queue = before; throw error }
        return edit.id
    }
    func refreshDetail(_ collection: String, _ id: String) async throws -> RecordItem {
        guard let api, let account, sessionVerified else { throw ServiceError(status: 0, message: "Connect and verify your session before reviewing server records.") }
        let current = generation
        let received = try JSONDecoder().decode(RecordItem.self, from: await api.send("/\(collection)/\(id)"))
        let item = collection == "reports" ? ReportTransport.compact(received) : received
        guard current == generation, item.workspace_id == account.workspace.id else { throw CancellationError() }
        var records = disk.records[collection] ?? []; records.removeAll { $0.id == item.id }; records.append(item)
        disk.records[collection] = records; try persist()
        return item
    }
    func loadPacks(country: String, year: Int) async throws {
        guard let api, sessionVerified else { throw ServiceError(status: 0, message: "Connect to load the available country packs.") }
        let current = generation
        guard let countryQuery = country.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return }
        let value = try JSONDecoder().decode(JSONValue.self, from: await api.send("/packs?country=\(countryQuery)&year=\(year)"))
        guard current == generation else { throw CancellationError() }
        let values = value.array.isEmpty ? value.object["items"]?.array ?? [] : value.array
        packs = values.compactMap { value in let o = value.object; guard let id = o["id"]?.text, !id.isEmpty else { return nil }; return Pack(id: id, data: o) }
        packCountry = country; packYear = year
    }
    func packs(country: String, year: Int) -> [Pack] { packCountry == country && packYear == year ? packs : [] }
    func saveEdit(collection: String, existing: RecordItem? = nil, data: [String: JSONValue], label: String) throws {
        guard collection != "reports" else { throw ServiceError(status: 0, message: "Prepare or review reports through their dedicated report controls. Full report snapshots cannot be saved as generic device edits.") }
        guard let account else { throw ServiceError(status: 0, message: "Sign in before saving a draft.") }
        guard disk.queue.count < 50 else { throw ServiceError(status: 0, message: "Sync or remove an existing draft before adding more than 50.") }
        let path = "/\(collection)" + (existing.map { "/\($0.id)" } ?? "")
        guard !disk.queue.contains(where: { $0.path == path && existing != nil }) else { throw ServiceError(status: 0, message: "This record already has a saved edit. Review it in the device outbox first.") }
        var payload: [String: JSONValue] = ["data": .object(data)]
        if let existing { payload["expected_revision"] = .number(Double(existing.revision)) }
        let edit = PendingEdit(scope: account.scope, path: path, method: existing == nil ? "POST" : "PATCH", label: label, payload: payload)
        disk.queue.append(edit)
        do { try persist() } catch { disk.queue.removeAll { $0.id == edit.id }; throw error }
    }
    func saveAction(path: String, label: String, payload: [String: JSONValue], replacing editID: UUID? = nil) throws {
        guard !Self.isReportApproval(path) else { throw ServiceError(status: 0, message: "Report approval requires the current authorized report review and explicit acknowledgement; it cannot be queued as a background action.") }
        guard let account else { throw ServiceError(status: 0, message: "Sign in before saving a draft.") }
        guard !syncing else { throw ServiceError(status: 0, message: "Wait for synchronization before changing a queued action.") }
        if let editID, !disk.queue.contains(where: { $0.id == editID && $0.scope == account.scope && $0.path == path }) { throw ServiceError(status: 0, message: "The saved action changed. Reopen the device outbox before replacing it.") }
        guard disk.queue.count < 50 || editID != nil else { throw ServiceError(status: 0, message: "The device outbox has reached 50 drafts.") }
        guard !disk.queue.contains(where: { $0.id != editID && $0.path == path && (!path.hasSuffix("/field-proposals") || $0.payload == payload) }) else { throw ServiceError(status: 0, message: "This action already has a matching queued proposal. Review the device outbox first.") }
        let edit = PendingEdit(scope: account.scope, path: path, label: label, payload: payload)
        let before = disk.queue
        if let editID { disk.queue.removeAll { $0.id == editID } }
        disk.queue.append(edit)
        do { try persist() } catch { disk.queue = before; throw error }
    }
    func localAttachment(_ name: String) throws -> ExportFile {
        guard let storage else { throw ServiceError(status: 0, message: "No private account is open.") }
        return ExportFile(url: try storage.safeURL(name))
    }
    func saveForm(_ key: String, value: [String: JSONValue]) throws {
        guard let storage else { throw ServiceError(status: 0, message: "No private account is open for this draft.") }
        try storage.saveForm(key, value: value)
    }
    func loadForm(_ key: String) throws -> [String: JSONValue]? { try storage?.loadForm(key) }
    func clearForm(_ key: String) throws { try storage?.removeForm(key) }
    func saveDocument(bytes: Data, filename: String, mime: String, farmID: String?) throws {
        guard let account, let storage else { throw ServiceError(status: 0, message: "Sign in before assigning a document.") }
        try IntakeInbox.validateDocument(bytes: bytes, mime: mime)
        guard disk.queue.count < 50 else { throw ServiceError(status: 0, message: "The device outbox has reached 50 drafts.") }
        let suffix = URL(fileURLWithPath: filename).pathExtension
        let name = try storage.stage(bytes, extension: suffix.isEmpty ? UTType(mimeType: mime)?.preferredFilenameExtension ?? "bin" : suffix)
        let edit = PendingEdit(scope: account.scope, path: "/documents", label: filename, payload: [:], attachment: name, filename: filename, mimeType: mime, farmID: farmID)
        disk.queue.append(edit)
        do { try persist() } catch { disk.queue.removeAll { $0.id == edit.id }; try? storage.removeAttachment(name); throw error }
    }
    func sync(onlyID: UUID? = nil) async {
        guard let api, let account, let storage, sessionVerified, !syncing else { return }
        let current = generation
        syncing = true; defer { if generation == current { syncing = false } }
        let ids = disk.queue.filter { ($0.state == .pending || $0.state == .failed) && (onlyID == nil || $0.id == onlyID) }.map(\.id)
        for id in ids {
            guard generation == current, let index = disk.queue.firstIndex(where: { $0.id == id }), disk.queue[index].scope == account.scope else { return }
            disk.queue[index].state = .sending; disk.queue[index].problem = nil
            do { try persist() } catch { self.error = "Sync paused: the sending state could not be saved."; return }
            let edit = disk.queue[index]
            do {
                guard !Self.isReportApproval(edit.path) else { throw ServiceError(status: 409, message: "Open the exact current report review and acknowledge its complete ranges. This saved approval was not sent.") }
                if edit.path == "/workflow/capture" || edit.path == "/workflow/answer" {
                    if let approved = edit.approvedRequest {
                        // Replaying this unchanged body/key reaches the server's committed-response cache
                        // before duplicate/revision checks. A changed form must get a fresh preview and key.
                        _ = try await api.send(edit.path, method: edit.method, body: approved, idempotency: edit.id.uuidString)
                    } else {
                        var raw = edit.payload
                        let reviewed = raw.removeValue(forKey: "_reviewed")
                        let acknowledged = raw.removeValue(forKey: "acknowledged_codes") ?? .array([])
                        let check: CaptureCheck
                        if edit.path == "/workflow/answer" {
                            var previewBody = raw; previewBody["preview"] = .bool(true)
                            let preview = try JSONDecoder().decode(JSONValue.self, from: await api.send("/workflow/answer", method: "POST", body: previewBody))
                            guard let value = preview.object["check"] else { throw ServiceError(status: 0, message: "The service returned no current answer check.") }
                            check = try JSONDecoder().decode(CaptureCheck.self, from: JSONEncoder().encode(value))
                        } else { check = try JSONDecoder().decode(CaptureCheck.self, from: await api.send("/workflow/check", method: "POST", body: raw)) }
                        guard generation == current else { return }
                        guard check.can_save, reviewed == check.reviewValue,
                              Set(check.requires_acknowledgement).isSubset(of: Set(acknowledged.array.map(\.text))) else {
                            throw ServiceError(status: 409, message: "The current checks differ from your review. Open this draft to review its current values and warnings.")
                        }
                        raw["check_token"] = .string(check.check_token); raw["acknowledged_codes"] = acknowledged
                        if edit.path == "/workflow/answer" { raw["preview"] = .bool(false) }
                        guard let pendingIndex = disk.queue.firstIndex(where: { $0.id == id }) else { return }
                        disk.queue[pendingIndex].approvedRequest = raw
                        try persist() // Older, never-frozen drafts acquire an exact request before any POST.
                        _ = try await api.send(edit.path, method: edit.method, body: raw, idempotency: edit.id.uuidString)
                    }
                }
                else if let attachment = edit.attachment { _ = try await api.upload(edit, bytes: storage.attachment(attachment)) }
                else { _ = try await api.send(edit.path, method: edit.method, body: edit.payload, idempotency: edit.id.uuidString) }
                guard generation == current else { return }
                // Persist acknowledgement before removing the attachment. A lost acknowledgement retries the same key.
                let beforeAcknowledgement = disk.queue
                disk.queue.removeAll { $0.id == id }
                do { try persist() } catch { disk.queue = beforeAcknowledgement; throw error }
                if let attachment = edit.attachment { try? storage.removeAttachment(attachment) }
            } catch {
                guard generation == current, let index = disk.queue.firstIndex(where: { $0.id == id }) else { return }
                let status = (error as? ServiceError)?.status
                disk.queue[index].state = status == 409 ? .conflict : .failed
                disk.queue[index].problem = error.localizedDescription
                if status == 401 { sessionVerified = false }
                do { try persist() } catch { self.error = "The device could not save the queue state." }
                if status == 401 { break }
            }
        }
        if sessionVerified { await refresh() }
    }
    func discard(_ edit: PendingEdit) throws {
        guard !syncing, let storage else { return }
        let before = disk.queue; disk.queue.removeAll { $0.id == edit.id }
        do { try persist() } catch { disk.queue = before; throw error }
        if let attachment = edit.attachment { try storage.removeAttachment(attachment) }
    }
    // Never silently rebase: the caller displays both versions before this action.
    func resolve(_ edit: PendingEdit, against latest: RecordItem) throws {
        guard !edit.path.hasPrefix("/reports/") else { throw ServiceError(status: 0, message: "Report actions cannot be rebased from an outbox comparison. Reload the exact report review and make a fresh explicit decision.") }
        guard !syncing, let account, latest.workspace_id == account.workspace.id,
              let index = disk.queue.firstIndex(where: { $0.id == edit.id }), edit.state == .conflict else { return }
        var body = edit.payload; body["expected_revision"] = .number(Double(latest.revision))
        let replacement = PendingEdit(scope: account.scope, path: edit.path, method: edit.method, label: edit.label, payload: body)
        disk.queue[index] = replacement
        do { try persist() } catch { disk.queue[index] = edit; throw error }
    }
    func mutate(_ path: String, body: [String: JSONValue], idempotency: String = UUID().uuidString) async throws {
        guard let api, sessionVerified else { throw ServiceError(status: 0, message: "Connect to review or approve. No approval has been recorded.") }
        let current = generation
        _ = try await api.send(path, method: "POST", body: body, idempotency: idempotency)
        guard current == generation else { throw CancellationError() }
        await refresh()
        guard current == generation else { throw CancellationError() }
        let components = (URLComponents(string: path)?.path ?? path).split(separator: "/")
        if current == generation, components.count >= 2, UUID(uuidString: String(components[1])) != nil {
            _ = try await refreshDetail(String(components[0]), String(components[1]))
        }
        guard current == generation else { throw CancellationError() }
    }
    func export(_ path: String, suffix: String) async throws -> ExportFile {
        guard let api, let storage, sessionVerified else { throw ServiceError(status: 0, message: "Connect to download the authorized file.") }
        guard activeExports.isEmpty else { throw ServiceError(status: 0, message: "Finish or cancel the current file download before starting another.") }
        let current = generation
        let file = ExportFile(url: try storage.exportURL(suffix: suffix))
        let transfer = try ProtectedFileTransfer(request: api.fileRequest(path), destination: file.url)
        activeExports[file.id] = transfer
        do {
            try await transfer.run()
            guard current == generation, sessionVerified else { try? FileManager.default.removeItem(at: file.url); throw CancellationError() }
            activeExports.removeValue(forKey: file.id); completedExports[file.id] = file.url
            return file
        } catch {
            activeExports.removeValue(forKey: file.id); transfer.cancel(); try? FileManager.default.removeItem(at: file.url)
            if current == generation, (error as? ServiceError)?.status == 401 { sessionVerified = false }
            throw error
        }
    }
    func removeExport(_ file: ExportFile) {
        guard let url = completedExports.removeValue(forKey: file.id), url == file.url else { return }
        try? FileManager.default.removeItem(at: url)
    }
    func cancelExportDownloads() { let transfers = Array(activeExports.values); activeExports = [:]; for transfer in transfers { transfer.cancel() } }
    private func clearExportFiles() { cancelExportDownloads(); let files = Array(completedExports.values); completedExports = [:]; for file in files { try? FileManager.default.removeItem(at: file) } }
    private static func isReportApproval(_ path: String) -> Bool { let parts = (URLComponents(string: path)?.path ?? path).split(separator: "/"); return parts.count == 3 && parts[0] == "reports" && parts[2] == "approve" }
    func refreshShared() {
        do { sharedFiles = try IntakeInbox.list() }
        catch { sharedFiles = [] /* App-group availability is also shown by the intake screen. */ }
    }
    func bind(_ item: SharedIntake, farmID: String?) throws {
        guard let account, let storage else { throw ServiceError(status: 0, message: "Sign in before assigning shared evidence.") }
        if disk.boundIntakeIDs.contains(item.id) {
            try IntakeInbox.remove(item); refreshShared(); return
        }
        guard disk.queue.count < 50 else { throw ServiceError(status: 0, message: "The device outbox has reached 50 drafts.") }
        let suffix = URL(fileURLWithPath: item.filename).pathExtension
        let bytes = try IntakeInbox.bytes(item)
        try IntakeInbox.validateDocument(bytes: bytes, mime: item.mimeType)
        let name = try storage.stage(bytes, extension: suffix.isEmpty ? UTType(mimeType: item.mimeType)?.preferredFilenameExtension ?? "bin" : suffix)
        let edit = PendingEdit(scope: account.scope, path: "/documents", label: item.filename, payload: [:], attachment: name, filename: item.filename, mimeType: item.mimeType, farmID: farmID)
        disk.queue.append(edit); disk.boundIntakeIDs.insert(item.id)
        do { try persist() }
        catch { disk.queue.removeAll { $0.id == edit.id }; disk.boundIntakeIDs.remove(item.id); try? storage.removeAttachment(name); throw error }
        // If removing staging fails, the durable binding marker prevents a duplicate on retry.
        try IntakeInbox.remove(item); refreshShared()
    }
    func signOut() async {
        guard !syncing, !busy else { error = "Wait for the current operation to finish before signing out."; return }
        let client = api; let previousStorage = storage
        clearExportFiles()
        // Clear memory before awaiting any network call; all outstanding responses are generation-guarded.
        generation = UUID(); account = nil; storage = nil; disk = AccountDiskState()
        packs = []; sharedFiles = []; route = nil; tab = 0; sessionVerified = false
        var failures: [String] = []
        do { try CredentialVault.clear() } catch { failures.append(error.localizedDescription) }
        do { try previousStorage?.purgeAccount() } catch { failures.append(error.localizedDescription) }
        do { try IntakeInbox.purge() } catch { failures.append(error.localizedDescription) }
        error = failures.isEmpty ? nil : "Signed out. Local cleanup needs attention: " + failures.joined(separator: " ")
        if let client { _ = try? await client.send("/auth/logout", method: "POST") }
    }
    func handleURL(_ url: URL) {
        guard url.scheme == "funkyfarm", let collection = url.host,
              ["requests", "documents", "farms", "reports", "operations", "purchases", "sales", "facts", "tasks", "checklists"].contains(collection),
              let id = url.pathComponents.last, UUID(uuidString: id) != nil else { return }
        tab = ["requests": 3, "documents": 4, "farms": 2, "reports": 3, "operations": 1, "purchases": 1, "sales": 1, "facts": 3, "tasks": 3, "checklists": 3][collection] ?? 0
        route = RecordRoute(collection: collection, id: id)
    }
    private func persist() throws { try storage?.save(disk) }
}
