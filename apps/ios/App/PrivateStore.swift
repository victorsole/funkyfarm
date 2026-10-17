import Foundation
import Security
import CryptoKit

enum CredentialVault {
    private static let service = "eu.funkyfarm.session"
    static func save(_ account: Account) throws {
        let bytes = try JSONEncoder().encode(account)
        try clear()
        let result = SecItemAdd([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecAttrAccount: "current", kSecValueData: bytes,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly] as CFDictionary, nil)
        guard result == errSecSuccess else { throw ServiceError(status: 0, message: "Could not store the session securely (\(result)).") }
        UserDefaults.standard.set(false, forKey: "FunkyFarmSignedOut")
    }
    static func load() -> Account? {
        guard !UserDefaults.standard.bool(forKey: "FunkyFarmSignedOut") else { return nil }
        var value: CFTypeRef?
        let result = SecItemCopyMatching([kSecClass: kSecClassGenericPassword, kSecAttrService: service,
            kSecAttrAccount: "current", kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne] as CFDictionary, &value)
        guard result == errSecSuccess, let data = value as? Data else { return nil }
        return try? JSONDecoder().decode(Account.self, from: data)
    }
    static func clear() throws {
        // A failed Keychain removal must never restore a signed-out session on next launch.
        UserDefaults.standard.set(true, forKey: "FunkyFarmSignedOut")
        let result = SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: service] as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw ServiceError(status: 0, message: "Could not remove the Keychain session (\(result)). Automatic restoration is disabled.") }
    }
}

struct PrivateStore {
    let directory: URL
    private let accountDirectory: URL
    init(scope: String, accountKey: String) throws {
        let digest = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        let accountDigest = SHA256.hash(data: Data(accountKey.utf8)).map { String(format: "%02x", $0) }.joined()
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        accountDirectory = support.appendingPathComponent("Accounts", isDirectory: true).appendingPathComponent(accountDigest, isDirectory: true)
        directory = accountDirectory.appendingPathComponent(digest, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var root = directory
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try root.setResourceValues(values)
    }
    func load() throws -> AccountDiskState {
        let url = directory.appendingPathComponent("state.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return AccountDiskState() }
        var state = try JSONDecoder().decode(AccountDiskState.self, from: Data(contentsOf: url))
        for index in state.queue.indices where state.queue[index].state == .sending { state.queue[index].state = .pending }
        return state
    }
    func save(_ state: AccountDiskState) throws {
        try JSONEncoder().encode(state).write(to: directory.appendingPathComponent("state.json"), options: [.atomic, .completeFileProtection])
    }
    func stage(_ bytes: Data, extension suffix: String) throws -> String {
        guard bytes.count <= IntakeInbox.maximumFileBytes else { throw ServiceError(status: 0, message: "This file exceeds the 20 MB local draft limit.") }
        let safeSuffix = suffix.filter { $0.isLetter || $0.isNumber }.prefix(10)
        let name = UUID().uuidString + (safeSuffix.isEmpty ? "" : "." + safeSuffix)
        try bytes.write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtection])
        return name
    }
    func attachment(_ name: String) throws -> Data { try Data(contentsOf: safeURL(name)) }
    func exportURL(suffix: String) throws -> URL {
        let directory = self.directory.appendingPathComponent("Exports", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var root = directory; var values = URLResourceValues(); values.isExcludedFromBackup = true; try root.setResourceValues(values)
        let safe = suffix.filter { $0.isLetter || $0.isNumber }.prefix(10)
        return directory.appendingPathComponent(UUID().uuidString + (safe.isEmpty ? "" : "." + safe))
    }
    func clearOldExports() throws {
        let root = directory.appendingPathComponent("Exports", isDirectory: true)
        guard FileManager.default.fileExists(atPath: root.path) else { return }
        for file in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isRegularFileKey]) {
            guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true, UUID(uuidString: file.deletingPathExtension().lastPathComponent) != nil else { continue }
            try FileManager.default.removeItem(at: file)
        }
    }
    func safeURL(_ name: String) throws -> URL {
        guard name == URL(fileURLWithPath: name).lastPathComponent, !name.isEmpty else { throw ServiceError(status: 0, message: "Invalid private file reference.") }
        return directory.appendingPathComponent(name)
    }
    func removeAttachment(_ name: String) throws { try FileManager.default.removeItem(at: safeURL(name)) }
    private func formURL(_ key: String) -> URL {
        let digest = SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("form-" + digest + ".json")
    }
    func saveForm(_ key: String, value: [String: JSONValue]) throws { try JSONEncoder().encode(value).write(to: formURL(key), options: [.atomic, .completeFileProtection]) }
    func loadForm(_ key: String) throws -> [String: JSONValue]? {
        let url = formURL(key)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
    }
    func removeForm(_ key: String) throws {
        let url = formURL(key)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
    func purge() throws { try FileManager.default.removeItem(at: directory) }
    func purgeAccount() throws {
        guard accountDirectory.deletingLastPathComponent().lastPathComponent == "Accounts", accountDirectory.lastPathComponent.count == 64 else { throw ServiceError(status: 0, message: "The account storage location could not be verified.") }
        try FileManager.default.removeItem(at: accountDirectory)
    }
}
