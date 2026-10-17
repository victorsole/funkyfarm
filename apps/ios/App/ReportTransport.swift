import Foundation
import SwiftUI

enum ReportSection: String, CaseIterable, Hashable {
    case fields, operations, evidence, blockers, changes, receipts, reissues
    var title: String { [Self.fields: "Report values", .operations: "Recorded work", .evidence: "Selected evidence", .blockers: "Checks needing attention", .changes: "Corrections to review", .receipts: "Manual response references", .reissues: "Reissue history"][self]! }
    var needsHumanReview: Bool { [.fields, .operations, .evidence].contains(self) }
}

enum ReportTransport {
    static let pageBytes = 2 * 1024 * 1024
    static func path(_ raw: String, method: String) -> String {
        guard var url = URLComponents(string: raw) else { return raw }
        let parts = url.path.split(separator: "/").map(String.init)
        let reportCollection = parts == ["reports"] && ["GET", "POST"].contains(method)
        let reportDetail = parts.count == 2 && parts[0] == "reports" && method == "GET"
        let reportMutation = parts.count == 3 && parts[0] == "reports" && ["approve", "reissue"].contains(parts[2]) && method == "POST"
        let dependency = parts.count == 3 && ["facts", "operations", "sales"].contains(parts[0]) && parts[2] == "reports" && method == "GET"
        guard reportCollection || reportDetail || reportMutation || dependency else { return raw }
        var query = url.queryItems?.filter { $0.name != "view" } ?? []; query.append(URLQueryItem(name: "view", value: reportDetail ? "review" : "summary")); url.queryItems = query
        return url.string ?? raw
    }
    static func compact(_ record: RecordItem) -> RecordItem {
        if record.data["transport_view"] == .string("summary") { return record }
        var data = record.data.filter { switch $0.value { case .array, .object: return false; default: return true } }
        if let approval = record.data["approval"] { data["approval"] = approval }
        let snapshot = record.data["snapshot"]?.object ?? [:]
        var metadata = snapshot.filter { ["reporting_year", "capability_notice"].contains($0.key) }
        metadata["pack"] = .object((snapshot["pack"]?.object ?? [:]).filter { ["id", "title", "name", "version"].contains($0.key) })
        metadata["farm"] = .object((snapshot["farm"]?.object ?? [:]).filter { ["id", "revision", "name", "country"].contains($0.key) })
        if let counts = snapshot["counts"] { metadata["counts"] = counts }
        data["snapshot"] = .object(metadata); data["transport_view"] = .string("summary")
        return RecordItem(id: record.id, kind: record.kind, revision: record.revision, workspace_id: record.workspace_id, data: data, created_at: record.created_at, updated_at: record.updated_at)
    }
}

struct ReportReviewBinding: Equatable {
    let scope: String
    let revision: Int
    let checksum: String
    let fingerprint: String
    let counts: [ReportSection: Int]
    var identity: String { scope + ":" + String(revision) + ":" + checksum + ":" + fingerprint }
    init(record: RecordItem, scope: String) throws {
        let review = record.data["review"]?.object ?? [:]
        guard record.data["transport_view"] == .string("review"), review["report_revision"] == .number(Double(record.revision)), let checksum = review["snapshot_checksum"]?.text, Self.digest(checksum), record.data["checksum"] == .string(checksum), let fingerprint = review["check_fingerprint"]?.text, Self.digest(fingerprint), review["page_limit"] == .number(5), review["byte_limit"] == .number(Double(ReportTransport.pageBytes)) else { throw ServiceError(status: 0, message: "The service did not return complete, bounded report-review metadata. Approval is unavailable.") }
        var counts: [ReportSection: Int] = [:]
        for section in ReportSection.allCases {
            guard case .number(let count)? = review["sections"]?.object[section.rawValue], count.isFinite, count >= 0, count < Double(Int.max), count.rounded() == count else { throw ServiceError(status: 0, message: "The report review has no exact count for \(section.title.lowercased()). Reload before continuing.") }
            counts[section] = Int(count)
        }
        self.scope = scope; revision = record.revision; self.checksum = checksum; self.fingerprint = fingerprint; self.counts = counts
    }
    private static func digest(_ value: String) -> Bool { value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
}

struct ReportReviewPage {
    var items: [JSONValue] = []
    var offset = 0
    var next: Int?
    var previous: [Int] = []
    var loaded = false
    var problem: String?
}

@MainActor final class ReportReviewModel: ObservableObject {
    @Published private(set) var record: RecordItem?
    @Published private(set) var binding: ReportReviewBinding?
    @Published private(set) var pages: [ReportSection: ReportReviewPage] = [:]
    @Published private(set) var visited: [ReportSection: IndexSet] = [:]
    @Published private(set) var checkedEmpty: Set<ReportSection> = []
    @Published private(set) var busy = false
    @Published private(set) var problem: String?
    @Published var acknowledged = false
    private var requestID = UUID()
    var reviewAvailable: Bool { binding != nil && ReportSection.allCases.allSatisfy { pages[$0]?.loaded == true && pages[$0]?.problem == nil } }
    var contentReviewed: Bool {
        guard let binding, reviewAvailable else { return false }
        return ReportSection.allCases.filter(\.needsHumanReview).allSatisfy { section in
            let count = binding.counts[section] ?? 0
            return count == 0 ? checkedEmpty.contains(section) : visited[section]?.contains(integersIn: 0..<count) == true
        }
    }
    func invalidate(_ message: String? = nil) { requestID = UUID(); record = nil; binding = nil; pages = [:]; visited = [:]; checkedEmpty = []; acknowledged = false; busy = false; problem = message }
    func load(id: String, store: AppStore) async {
        invalidate(); let request = requestID
        busy = true; defer { if request == requestID { busy = false } }
        do {
            guard let account = store.account, store.sessionVerified else { throw ServiceError(status: 0, message: "Reconnect before loading an authorized report review.") }
            let session = try JSONDecoder().decode(AuthResponse.self, from: JSONEncoder().encode(try await store.scopedValue("/auth/session")))
            guard session.user.id == account.user.id, session.workspace.id == account.workspace.id else { throw ServiceError(status: 401, message: "The current session no longer matches this account and workspace. Sign in again before reviewing reports.") }
            let value = try await store.scopedValue("/reports/\(id)?view=review")
            let record = try JSONDecoder().decode(RecordItem.self, from: JSONEncoder().encode(value))
            guard request == requestID, account.scope == store.account?.scope, record.workspace_id == account.workspace.id else { return }
            let binding = try ReportReviewBinding(record: record, scope: account.scope)
            self.record = record; self.binding = binding
            for section in ReportSection.allCases {
                guard request == requestID, self.binding == binding else { return }
                await fetch(section, offset: 0, previous: [], id: id, store: store, request: request)
            }
        } catch { if request == requestID { invalidate(SourceText.error(error)) } }
    }
    func markReviewed(_ section: ReportSection) {
        guard !busy, section.needsHumanReview, let binding, let page = pages[section], page.loaded, page.problem == nil else { return }
        if binding.counts[section] == 0 { checkedEmpty.insert(section) }
        else { var ranges = visited[section] ?? IndexSet(); ranges.insert(integersIn: page.offset..<(page.offset + page.items.count)); visited[section] = ranges }
        acknowledged = false
    }
    func move(_ section: ReportSection, direction: Int, id: String, store: AppStore) async {
        guard !busy, let page = pages[section], page.loaded else { return }
        var previous = page.previous
        let offset: Int
        if direction > 0 { guard let next = page.next else { return }; offset = next; previous.append(page.offset) }
        else { guard let last = previous.popLast() else { return }; offset = last }
        let request = requestID
        busy = true; defer { if request == requestID { busy = false } }; acknowledged = false
        await fetch(section, offset: offset, previous: previous, id: id, store: store, request: request)
    }
    func retry(_ section: ReportSection, id: String, store: AppStore) async {
        guard !busy, let page = pages[section] else { return }
        let request = requestID
        busy = true; defer { if request == requestID { busy = false } }; acknowledged = false
        await fetch(section, offset: page.offset, previous: page.previous, id: id, store: store, request: request)
    }
    private func fetch(_ section: ReportSection, offset: Int, previous: [Int], id: String, store: AppStore, request: UUID) async {
        guard let binding else { return }
        pages[section] = ReportReviewPage(offset: offset, previous: previous)
        do {
            guard store.sessionVerified, binding.scope == store.account?.scope else { throw CancellationError() }
            var url = URLComponents(); url.path = "/reports/\(id)/review"
            url.queryItems = [URLQueryItem(name: "section", value: section.rawValue), URLQueryItem(name: "expected_revision", value: String(binding.revision)), URLQueryItem(name: "snapshot_checksum", value: binding.checksum), URLQueryItem(name: "check_fingerprint", value: binding.fingerprint), URLQueryItem(name: "offset", value: String(offset)), URLQueryItem(name: "limit", value: "5")]
            let result = try await store.scopedValue(url.string ?? "").object
            guard request == requestID, self.binding == binding, binding.scope == store.account?.scope else { return }
            guard case .array(let items)? = result["items"] else { throw ServiceError(status: 0, message: "The service did not return a complete report page. This section is unavailable, not empty.") }
            let total = binding.counts[section] ?? -1, end = offset + items.count
            guard result["section"] == .string(section.rawValue), result["report_revision"] == .number(Double(binding.revision)), result["snapshot_checksum"] == .string(binding.checksum), result["check_fingerprint"] == .string(binding.fingerprint), result["offset"] == .number(Double(offset)), result["total"] == .number(Double(total)), result["limit"] == .number(5), items.count <= 5, offset >= 0, end <= total, items.count > 0 || offset == total else { throw ServiceError(status: 0, message: "This page did not match the exact report review or complete row range. Nothing was marked reviewed.") }
            let next: Int?
            if end < total { guard result["next_offset"] == .number(Double(end)) else { throw ServiceError(status: 0, message: "The next complete report range was not returned. Retry this page.") }; next = end }
            else { guard result["next_offset"] == .null else { throw ServiceError(status: 0, message: "The report page did not establish the end of this section.") }; next = nil }
            pages[section] = ReportReviewPage(items: items, offset: offset, next: next, previous: previous, loaded: true)
        } catch {
            guard request == requestID else { return }
            acknowledged = false
            if error is CancellationError || (error as? ServiceError)?.status == 409 { invalidate("This report or its current checks changed. Reload the review and compare all ranges again. " + SourceText.error(error)) }
            else { pages[section] = ReportReviewPage(offset: offset, previous: previous, problem: SourceText.error(error)) }
        }
    }
}
