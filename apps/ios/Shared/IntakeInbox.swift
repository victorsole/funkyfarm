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
    static let group = "group.eu.funkyfarmers.intake"
    static let maximumFileBytes = 20 * 1_024 * 1_024
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
        guard bytes.count <= maximumFileBytes else { throw NSError(domain: "Intake", code: 2, userInfo: [NSLocalizedDescriptionKey: "A shared file must be at most 20 MB."]) }
        let root = try directory()
        guard try list().count < 20 else { throw NSError(domain: "Intake", code: 3, userInfo: [NSLocalizedDescriptionKey: "Review the existing 20 shared files in Funky Farmers before adding more."]) }
        let id = UUID()
        let stored = id.uuidString + "." + (type.preferredFilenameExtension ?? "bin")
        let item = SharedIntake(id: id, filename: URL(fileURLWithPath: filename).lastPathComponent, storedName: stored, mimeType: type.preferredMIMEType ?? "application/octet-stream", date: Date())
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
