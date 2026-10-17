import SwiftUI

enum SourceText {
    static func literal(_ value: JSONValue) -> String { (try? String(data: JSONEncoder().encode(value), encoding: .utf8)) ?? "Unavailable" }
    static func year(_ value: JSONValue?) -> String? { guard case .number(let n)? = value, n.isFinite, n.rounded() == n, n >= 0, n < Double(Int.max) else { return nil }; return String(Int(n)) }
    static func error(_ error: Error) -> String {
        guard let failure = error as? ServiceError, let code = failure.code else { return error.localizedDescription }
        var messages = [failure.message + " (" + code.replacingOccurrences(of: "_", with: " ") + ")"]
        let details = failure.details?.object ?? [:]
        if let headers = details["headers"]?.array, !headers.isEmpty { messages.append("Source headers to check: " + headers.map(\.text).joined(separator: ", ")) }
        messages.append(contentsOf: (details["issues"]?.array ?? []).compactMap { $0.object["message"]?.text })
        return messages.joined(separator: "\n")
    }
}

struct SourceCellValue: View {
    let value: JSONValue?
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if let value {
                switch value {
                case .string(let raw):
                    Text(raw.isEmpty ? "Empty text — cell is present" : raw).textSelection(.enabled)
                    if !raw.isEmpty { Text(SourceText.literal(value)).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled) }
                    Text(raw == "NULL" || raw == "UNKNOWN" ? "Literal source text, not a JSON null or zero" : "Original text; no conversion").font(.caption).foregroundStyle(.secondary)
                case .null: Text("JSON null — unknown, not empty text or zero")
                case .number: Text(SourceText.literal(value)).textSelection(.enabled); Text("Numeric value, not source text").font(.caption).foregroundStyle(.secondary)
                case .bool: Text(SourceText.literal(value)); Text("Boolean value, not source text").font(.caption).foregroundStyle(.secondary)
                default: Text(SourceText.literal(value)).font(.callout).textSelection(.enabled)
                }
            } else { Text("Absent — no value supplied for this column").foregroundStyle(.secondary) }
        }.accessibilityElement(children: .combine)
    }
}

struct SourceRowCells: View {
    let value: [String: JSONValue]
    var schema: [String: JSONValue] = [:]
    private var columns: [[String: JSONValue]] { schema["row_columns"]?.array.map(\.object) ?? [] }
    private var keys: [String] {
        var seen = Set<String>()
        return (columns.compactMap { $0["key"]?.text } + value.keys.sorted()).filter { seen.insert($0).inserted }
    }
    var body: some View {
        ForEach(keys, id: \.self) { key in
            let definition = columns.first { $0["key"]?.text == key } ?? [:]
            VStack(alignment: .leading, spacing: 5) {
                Text(definition["label"]?.text ?? (columns.isEmpty ? key.replacingOccurrences(of: "_", with: " ").capitalized : "Additional source column")).font(.headline)
                Text(key).font(.caption.monospaced()).foregroundStyle(.secondary)
                SourceCellValue(value: value[key])
                if let unit = definition["unit"], unit != .null { Text("Documented source unit: \(unit.text)").font(.caption) }
                if definition["previous_year"] == .bool(true) { Text("Previous-year information in this source; not a new current-year observation.").font(.caption).foregroundStyle(.secondary) }
            }.padding(.vertical, 5)
        }
    }
}

struct OriginalImportCells: View {
    let columns: [JSONValue]
    let cells: [JSONValue]
    var body: some View {
        ForEach(0..<max(columns.count, cells.count), id: \.self) { index in
            VStack(alignment: .leading, spacing: 4) {
                Text(columns.indices.contains(index) ? columns[index].object["header"]?.text ?? "Source column \(index + 1)" : "Additional cell \(index + 1)").font(.headline)
                SourceCellValue(value: cells.indices.contains(index) ? cells[index] : nil)
            }.padding(.vertical, 4)
        }
    }
}

enum BoundedCSVReader {
    static func read(_ url: URL) throws -> Data {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        if let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > IntakeInbox.maximumFileBytes { throw ServiceError(status: 0, message: "Choose a source no larger than 20 MiB.") }
        guard let stream = InputStream(url: url) else { throw ServiceError(status: 0, message: "This source file could not be opened.") }
        stream.open(); defer { stream.close() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { throw ServiceError(status: 0, message: "The source stream could not be read completely. Nothing was uploaded.") }
            if count == 0 { break }
            guard count <= IntakeInbox.maximumFileBytes - result.count else { throw ServiceError(status: 0, message: "The actual source exceeds 20 MiB. Nothing was uploaded.") }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
}
