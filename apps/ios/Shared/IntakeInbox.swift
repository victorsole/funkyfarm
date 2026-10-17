import Foundation
import UniformTypeIdentifiers

struct SharedIntake: Codable, Identifiable {
    let id: UUID
    let filename: String
    let storedName: String
    let mimeType: String
    let date: Date
}

// Deliberately contains no account, token, URLSession, or upload capability.
// Only a reviewed host-app action moves an intake file into an account outbox.
enum IntakeInbox {
    static let group = "group.eu.funkyfarm.intake"
    static let maximumFileBytes = 20 * 1_024 * 1_024
    static let maximumDocumentBytes = 12 * 1_024 * 1_024
    static let documentTypes: [UTType] = [.pdf, .png, .jpeg, .plainText]
    static func documentType(_ type: UTType) -> UTType? {
        if type.conforms(to: .commaSeparatedText) || type.conforms(to: .spreadsheet) { return nil }
        return documentTypes.first { type.conforms(to: $0) }
    }
    static func validateDocument(bytes: Data, mime: String) throws {
        guard !bytes.isEmpty, bytes.count <= maximumDocumentBytes else { throw NSError(domain: "Intake", code: 2, userInfo: [NSLocalizedDescriptionKey: "Choose a nonempty document no larger than 12 MiB."]) }
        guard ["application/pdf", "image/png", "image/jpeg", "text/plain"].contains(mime) else { throw NSError(domain: "Intake", code: 5, userInfo: [NSLocalizedDescriptionKey: "Choose PDF, PNG, JPEG or UTF-8 plain text. Bring CSV records through Import records instead."]) }
        if mime == "text/plain", String(data: bytes, encoding: .utf8) == nil { throw NSError(domain: "Intake", code: 5, userInfo: [NSLocalizedDescriptionKey: "The text document must use UTF-8 encoding."]) }
    }
    static func directory() throws -> URL {
        guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else {
            throw NSError(domain: "Intake", code: 1, userInfo: [NSLocalizedDescriptionKey: "The shared intake container is unavailable. Check the app-group signing entitlement."])
        }
        let directory = container.appendingPathComponent("UnboundIntake", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var url = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true
        try url.setResourceValues(values)
        return directory
    }
    static func save(bytes: Data, filename: String, type: UTType) throws {
        guard let supported = documentType(type), let mime = supported.preferredMIMEType else { throw NSError(domain: "Intake", code: 5, userInfo: [NSLocalizedDescriptionKey: "Share PDF, PNG, JPEG or UTF-8 plain text. Use Import records for CSV files."]) }
        try validateDocument(bytes: bytes, mime: mime)
        let root = try directory()
        guard try list().count < 20 else { throw NSError(domain: "Intake", code: 3, userInfo: [NSLocalizedDescriptionKey: "Review the existing 20 shared files in funkyfarm before adding more."]) }
        let id = UUID()
        let stored = id.uuidString + "." + (supported.preferredFilenameExtension ?? "bin")
        let item = SharedIntake(id: id, filename: URL(fileURLWithPath: filename).lastPathComponent, storedName: stored, mimeType: mime, date: Date())
        try bytes.write(to: root.appendingPathComponent(stored), options: [.atomic, .completeFileProtection])
        do { try JSONEncoder().encode(item).write(to: root.appendingPathComponent(id.uuidString + ".json"), options: [.atomic, .completeFileProtection]) }
        catch { try? FileManager.default.removeItem(at: root.appendingPathComponent(stored)); throw error }
    }
    static func list() throws -> [SharedIntake] {
        let files = try FileManager.default.contentsOfDirectory(at: directory(), includingPropertiesForKeys: nil)
        return try files.filter { $0.pathExtension == "json" }.map { try JSONDecoder().decode(SharedIntake.self, from: Data(contentsOf: $0)) }.sorted { $0.date < $1.date }
    }
    static func bytes(_ item: SharedIntake) throws -> Data {
        guard item.storedName == URL(fileURLWithPath: item.storedName).lastPathComponent else { throw CocoaError(.fileReadInvalidFileName) }
        return try Data(contentsOf: directory().appendingPathComponent(item.storedName))
    }
    static func remove(_ item: SharedIntake) throws {
        let root = try directory()
        guard item.storedName == URL(fileURLWithPath: item.storedName).lastPathComponent else { throw CocoaError(.fileWriteInvalidFileName) }
        let attachment = root.appendingPathComponent(item.storedName)
        if FileManager.default.fileExists(atPath: attachment.path) { try FileManager.default.removeItem(at: attachment) }
        try FileManager.default.removeItem(at: root.appendingPathComponent(item.id.uuidString + ".json"))
    }
    static func purge() throws { for item in try list() { try remove(item) } }
}
