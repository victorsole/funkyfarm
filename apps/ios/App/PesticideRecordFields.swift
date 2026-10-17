import SwiftUI

struct PesticideRecordFields: View {
    @Binding var details: [String: JSONValue]
    var excludedKeys: Set<String> = []
    static let textFields: [(String, String)] = [
        ("operator", "Actual operator"), ("product_authorisation", "Product authorisation from the label"),
        ("dose", "Actual dose"), ("dose_unit", "Dose unit"),
        ("treated_size", "Actual treated extent"), ("treated_unit", "Treated extent unit"),
        ("treated_location", "Actual treated location"), ("start_time", "Actual start time, if recorded"),
        ("eppo_code", "EPPO code from your record"), ("bbch_stage", "Actual BBCH growth stage"),
        ("batch_number", "Product batch number"), ("contractor", "Contractor, if used")
    ]
    static var keys: Set<String> { Set(textFields.map(\.0) + ["treatment_type", "label_time_required", "label_growth_stage_required"]) }
    private func text(_ key: String) -> Binding<String> {
        Binding(get: { guard let value = details[key], value != .null else { return "" }; if case .number(let n) = value { return String(n) }; return value.text }, set: { if $0.isEmpty { details.removeValue(forKey: key) } else { details[key] = .string($0) } })
    }
    private func flag(_ key: String) -> Binding<JSONValue> { Binding(get: { details[key] ?? .null }, set: { if $0 == .null { details.removeValue(forKey: key) } else { details[key] = $0 } }) }
    var body: some View {
        Section("Pesticide application record") {
            Notice("Use the actual product label and application record. Purchases and invoices do not establish use, dose, treated extent, time or growth stage. Missing details remain unknown.")
            Picker("Recorded treatment type", selection: text("treatment_type")) { Text("Not established").tag(""); Text("Surface treatment").tag("surface"); Text("Closed-space treatment").tag("closed_space"); Text("Seed treatment").tag("seed") }
            ForEach(Array(Self.textFields.filter { !excludedKeys.contains($0.0) }.enumerated()), id: \.offset) { _, item in TextField(item.1, text: text(item.0)) }
            Picker("Does this label require the application time?", selection: flag("label_time_required")) { Text("Not checked").tag(JSONValue.null); Text("Yes, I checked the label").tag(JSONValue.bool(true)); Text("No, I checked the label").tag(JSONValue.bool(false)) }
            Picker("Does this label require growth stage?", selection: flag("label_growth_stage_required")) { Text("Not checked").tag(JSONValue.null); Text("Yes, I checked the label").tag(JSONValue.bool(true)); Text("No, I checked the label").tag(JSONValue.bool(false)) }
            Text("These values are not derived or used to calculate a dose. A saved proposal or acknowledged warning is not a compliant-use determination.").font(.footnote).foregroundStyle(.secondary)
        }
    }
}
