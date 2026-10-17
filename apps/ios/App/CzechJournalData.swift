import SwiftUI

enum CzechJournalData {
    static let schema = "cz-ppp-journal-v1"
    static let pack = "cz-ppp-journal-2026"
    static let holderKey = "cz.ppp.holder"
    static let operationKeys: Set<String> = Set(["farm_id", "title", "date", "type", "quantity", "unit", "parcel", "parcel_id", "crop", "product", "operator", "hours", "note", "notes", "document_id", "external_id", "origin", "period", "temporal_basis", "sources", "review_status", "supersedes_id", "cz_ppp"]).union(PesticideRecordFields.keys)
    static func text(_ value: JSONValue?) -> String { guard let value, value != .null else { return "" }; if case .number(let number) = value { return String(number) }; return value.text }
    static func canonical(_ raw: String, decimal: String) -> String { let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines); return decimal == "," ? trimmed.replacingOccurrences(of: ",", with: ".") : trimmed }
    static func get(_ data: [String: JSONValue], _ path: [String]) -> JSONValue? { guard let first = path.first else { return nil }; return path.count == 1 ? data[first] : get(data[first]?.object ?? [:], Array(path.dropFirst())) }
    static func put(_ data: inout [String: JSONValue], _ path: [String], _ value: JSONValue?) {
        guard let first = path.first else { return }
        if path.count == 1 { data[first] = value; return }
        var child = data[first]?.object ?? [:]; put(&child, Array(path.dropFirst()), value); data[first] = child.isEmpty ? nil : .object(child)
    }
    static func year(_ record: RecordItem) -> Int? { Int(String(record.value("date").prefix(4))) }
    static func isEntry(_ record: RecordItem) -> Bool { record.value("type") == "pesticide_application" && (record.data["cz_ppp"] != nil || record.journal_issues != nil) }
    static func isActive(_ record: RecordItem) -> Bool { isEntry(record) ? record.active == true : record.data["superseded_by"] == nil || record.data["superseded_by"] == .null }
    static let labels: [String: String] = ["location_kind": "Location reference type", "lpis_land": "LPIS land", "other_land": "Other land", "forest": "Forest", "object": "Object or facility", "cadastral_area": "Cadastral area", "dpb_square": "LPIS square", "dpb_code": "DPB code", "cadastral_parcel_numbers": "Cadastral parcel identifiers", "lhc_code": "LHC code", "jprl": "JPRL reference", "oddeleni": "Oddělení", "dilec": "Dílec", "porost": "Porost", "porostni_skupina": "Porostní skupina", "object_type": "Object type", "object_description": "Object description", "subject_kind": "Recorded subject", "crop": "Crop", "tree": "Trees", "other": "Other subject", "sown_area_ha": "Sown area (ha)", "sowing_date": "Actual sowing date", "crop_end": "Crop end", "target_organism_or_purpose": "Target organism or purpose", "mixture": "S / TM record", "efficacy": "Efficacy", "original_numbers": "Original numeric text", "dose": "Dose", "treated_size": "Treated extent", "quantity": "Total quantity, if supplied", "kind": "Holder type", "name": "Holder name", "address": "Holder address", "identification_number": "Identification number", "birth_date": "Actual birth date", "natural_person": "Natural person", "legal_person": "Legal person", "provided": "Provided", "not_assigned": "Not assigned", "unknown": "Not established", "pending": "Pending — not zero or complete", "not_applicable": "Explicitly not applicable", "recorded": "Recorded", "status": "Status", "value": "Recorded value", "date": "Actual recorded date"]
    static func label(_ key: String) -> String { labels[key] ?? key.replacingOccurrences(of: "_", with: " ").capitalized }
}

struct CzechStructuredValues: View {
    let data: [String: JSONValue]
    private struct Cell: Identifiable { let id: String; let label: String; let value: JSONValue }
    private func cells(_ data: [String: JSONValue], prefix: String = "", labels: [String] = []) -> [Cell] {
        data.keys.sorted().flatMap { key -> [Cell] in
            guard let value = data[key] else { return [] }
            let path = prefix + key, titles = labels + [CzechJournalData.label(key)]
            if case .object(let object) = value, !object.isEmpty { return cells(object, prefix: path + ".", labels: titles) }
            if case .array(let values) = value { return values.enumerated().map { index, entry in Cell(id: path + ":" + String(index), label: titles.joined(separator: " · ") + " \(index + 1)", value: entry) } }
            return [Cell(id: path, label: titles.joined(separator: " · "), value: value)]
        }
    }
    var body: some View {
        ForEach(cells(data)) { cell in
            VStack(alignment: .leading, spacing: 3) {
                Text(cell.label).font(.headline)
                if ["kind", "location_kind", "subject_kind", "status"].contains(cell.id.components(separatedBy: ".").last ?? ""), case .string(let text) = cell.value, let label = CzechJournalData.labels[text] { Text(label); Text(text).font(.caption.monospaced()).foregroundStyle(.secondary) }
                else { SourceCellValue(value: cell.value) }
            }.padding(.vertical, 3)
        }
    }
}

struct CzechHolderValues: View {
    let value: [String: JSONValue]
    var body: some View {
        ForEach(["kind", "name", "address", "identification_number", "birth_date"], id: \.self) { key in
            VStack(alignment: .leading, spacing: 4) {
                Text(CzechJournalData.label(key)).font(.headline)
                if let object = value[key]?.object, !object.isEmpty { CzechStructuredValues(data: object) }
                else { SourceCellValue(value: value[key]) }
            }
        }
    }
}

struct RetainedCzechJournalEntry: View {
    let context: [String: JSONValue]
    var body: some View {
        Text(context["title"]?.text ?? "Retained Czech application journal").font(.headline)
        if let year = context["reporting_year"] { LabeledContent("Journal year", value: year.text) }
        if let source = context["source"] { DisclosureGroup("Retained official source and edition") { SourceReferences(value: source) } }
        let entry = context["entry"]?.object ?? [:]
        let originals = entry["original_numbers"]?.object ?? [:]
        LabeledContent("Application identity", value: entry["operation_id"]?.text ?? "Unavailable")
        LabeledContent("Retained revision", value: entry["operation_revision"]?.text ?? "Unavailable")
        let values = entry["values"]?.object ?? [:]
        ForEach(Array((context["columns"]?.array ?? []).enumerated()), id: \.offset) { _, column in
            let definition = column.object, key = definition["key"]?.text ?? ""
            VStack(alignment: .leading, spacing: 4) {
                Text(definition["label"]?.text ?? key).font(.headline)
                if let raw = originals[key] { SourceCellValue(value: raw); if let canonical = values[key] { LabeledContent("Retained canonical number", value: SourceText.literal(canonical)).font(.caption) } }
                else if let value = values[key], case .object(let object) = value { CzechStructuredValues(data: object) }
                else if let value = values[key], case .array = value { CzechStructuredValues(data: [key: value]) }
                else { SourceCellValue(value: values[key]) }
                if let unit = definition["unit_field"].flatMap({ values[$0.text] }) ?? definition["unit"], unit != .null { Text("Retained source unit: " + unit.text).font(.caption) }
                if let precision = definition["decimal_places"] { Text("Source precision: " + precision.text + " decimal places; no rounding applied here").font(.caption) }
            }.padding(.vertical, 4)
        }
        if let details = entry["data"]?.object { DisclosureGroup("Complete retained application context and original numbers") { CzechStructuredValues(data: details); CzechStructuredValues(data: ["original_numbers": .object(originals)]) } }
        ForEach(Array((entry["issues"]?.array ?? []).enumerated()), id: \.offset) { _, issue in Notice(issue.object["message"]?.text ?? "Review this retained application issue.", warning: true) }
        Notice("These columns belong to the retained journal, not today's catalogue. Pending observations remain pending. Preparation and sharing are not JUDPOR transmission or authority acceptance.")
    }
}
