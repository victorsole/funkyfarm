import Foundation

enum JSONValue: Codable, Equatable, Hashable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }
    var text: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.formatted()
        case .bool(let b): return b ? "Yes" : "No"
        case .null: return "Not supplied"
        default:
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            return (try? String(data: encoder.encode(self), encoding: .utf8)) ?? "Unavailable"
        }
    }
    var object: [String: JSONValue] { if case .object(let value) = self { return value }; return [:] }
    var array: [JSONValue] { if case .array(let value) = self { return value }; return [] }
}

struct RecordItem: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    let revision: Int
    let workspace_id: String
    let data: [String: JSONValue]
    let created_at: String
    let updated_at: String
    let journal_issues: [JSONValue]?
    let active: Bool?
    let confirmed_successor_id: String?
    init(id: String, kind: String, revision: Int, workspace_id: String, data: [String: JSONValue], created_at: String, updated_at: String, journal_issues: [JSONValue]? = nil, active: Bool? = nil, confirmed_successor_id: String? = nil) {
        self.id = id; self.kind = kind; self.revision = revision; self.workspace_id = workspace_id; self.data = data; self.created_at = created_at; self.updated_at = updated_at; self.journal_issues = journal_issues; self.active = active; self.confirmed_successor_id = confirmed_successor_id
    }
    func value(_ key: String) -> String { data[key]?.text ?? "" }
    var title: String {
        for key in ["title", "name", "label", "filename", "original_filename", "pack_id"] {
            if !value(key).isEmpty { return value(key) }
        }
        return kind.capitalized
    }
    var state: String { value("review_status").isEmpty ? value("status") : value("review_status") }
}
struct RecordPage: Decodable { let items: [RecordItem]; let total: Int }
struct Account: Codable, Equatable {
    struct User: Codable, Equatable { let id: String; let display_name: String; let email: String }
    struct Workspace: Codable, Equatable { let id: String; let name: String; let role: String }
    let user: User
    let workspace: Workspace
    let token: String
    let baseURL: String
    var scope: String { baseURL + "/" + user.id + "/" + workspace.id }
}
struct AuthResponse: Decodable {
    let user: Account.User
    let workspace: Account.Workspace
    let token: String?
}
struct Pack: Identifiable, Hashable {
    let id: String
    let data: [String: JSONValue]
    var title: String { data["name"]?.text ?? data["title"]?.text ?? id }
    var capability: String { data["capability"]?.text ?? data["capability_level"]?.text ?? "See pack source and review status" }
}
enum QueueState: String, Codable { case pending, sending, failed, conflict, review }
struct PendingEdit: Codable, Identifiable {
    let id: UUID
    let scope: String
    let path: String
    let method: String
    let label: String
    let payload: [String: JSONValue]
    let attachment: String?
    let filename: String?
    let mimeType: String?
    let farmID: String?
    let reviewContext: [String: JSONValue]?
    // The exact reviewed wire request is persisted before its first send and never regenerated on retry.
    var approvedRequest: [String: JSONValue]? = nil
    var state: QueueState
    var problem: String?
    let createdAt: Date
    init(scope: String, path: String, method: String = "POST", label: String, payload: [String: JSONValue], attachment: String? = nil, filename: String? = nil, mimeType: String? = nil, farmID: String? = nil, reviewContext: [String: JSONValue]? = nil) {
        id = UUID(); self.scope = scope; self.path = path; self.method = method; self.label = label
        self.payload = payload; self.attachment = attachment; self.filename = filename
        self.mimeType = mimeType; self.farmID = farmID; state = .pending; createdAt = Date()
        self.reviewContext = reviewContext
    }
}
struct AccountDiskState: Codable {
    var records: [String: [RecordItem]] = [:]
    var queue: [PendingEdit] = []
    var lastRefresh: Date?
    var boundIntakeIDs: Set<UUID> = []
    var workflowHome: [String: JSONValue]? = nil
    var fieldLibraries: [String: JSONValue] = [:]
    init() {}
    private enum CodingKeys: String, CodingKey { case records, queue, lastRefresh, boundIntakeIDs, workflowHome, fieldLibraries }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        records = try container.decodeIfPresent([String: [RecordItem]].self, forKey: .records) ?? [:]
        queue = try container.decodeIfPresent([PendingEdit].self, forKey: .queue) ?? []
        lastRefresh = try container.decodeIfPresent(Date.self, forKey: .lastRefresh)
        boundIntakeIDs = try container.decodeIfPresent(Set<UUID>.self, forKey: .boundIntakeIDs) ?? []
        workflowHome = try container.decodeIfPresent([String: JSONValue].self, forKey: .workflowHome)
        fieldLibraries = try container.decodeIfPresent([String: JSONValue].self, forKey: .fieldLibraries) ?? [:]
    }
}
struct RecordRoute: Hashable { let collection: String; let id: String }
struct ExportFile: Identifiable { let id = UUID(); let url: URL }

struct CaptureCheck: Codable, Equatable {
    let normalized_data: [String: JSONValue]
    let issues: [CaptureIssue]
    let can_save: Bool
    let requires_acknowledgement: [String]
    let check_token: String
    var reviewValue: JSONValue {
        .object(["normalized_data": .object(normalized_data), "issues": .array(issues.map { .object(["code": .string($0.code), "severity": .string($0.severity), "field": $0.field.map(JSONValue.string) ?? .null, "message": .string($0.message), "record_ids": .array(($0.record_ids ?? []).map(JSONValue.string))]) }), "can_save": .bool(can_save), "requires_acknowledgement": .array(requires_acknowledgement.sorted().map(JSONValue.string))])
    }
}
struct CaptureIssue: Codable, Equatable {
    let code: String
    let severity: String
    let field: String?
    let message: String
    let record_ids: [String]?
}

extension String {
    var suppliedValue: String { self == "Not supplied" ? "" : self }
}
