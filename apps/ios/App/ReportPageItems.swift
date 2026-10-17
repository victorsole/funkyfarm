import SwiftUI

struct ReportPageItem: View {
    let section: ReportSection
    let value: JSONValue
    let position: Int
    @State private var expanded = false
    private var data: [String: JSONValue] { value.object }
    var body: some View {
        switch section {
        case .fields:
            DisclosureGroup(data["label"]?.text ?? data["field"]?.text ?? "Report value \(position)", isExpanded: $expanded) {
                if expanded {
                if let schema = data["row_schema"]?.object, !schema.isEmpty, case .object(let cells)? = data["value"] {
                    Notice("These labels and units are retained in this snapshot. The current source catalogue is not used to reinterpret them.")
                    SourceRowCells(value: cells, schema: schema)
                } else { SourceCellValue(value: data["value"]) }
                ForEach(["unit", "period", "temporal_basis", "fact_revision"], id: \.self) { key in if let value = data[key] { LabeledContent(key.replacingOccurrences(of: "_", with: " ").capitalized, value: value.text) } }
                if data["missing"] == .bool(true) { Notice("This retained value was marked missing.", warning: true) }
                if let id = data["fact_id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Open current source fact") { DetailView(collection: "facts", id: id) } }
                ReportSourceLinks(sources: data["sources"]?.array ?? [])
                }
            }
        case .operations:
            let operation = data["data"]?.object ?? data
            DisclosureGroup(operation["title"]?.text ?? "Recorded work \(position)", isExpanded: $expanded) {
                if expanded {
                SourceRowCells(value: operation.filter { $0.key != "sources" })
                if let revision = data["revision"] { LabeledContent("Retained revision", value: revision.text) }
                if let id = data["id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Open current work record") { DetailView(collection: "operations", id: id) } }
                ReportSourceLinks(sources: operation["sources"]?.array ?? [])
                }
            }
        case .evidence:
            DisclosureGroup(data["name"]?.text ?? data["filename"]?.text ?? "Selected document \(position)", isExpanded: $expanded) {
                if expanded {
                if let revision = data["revision"] { LabeledContent("Retained revision", value: revision.text) }
                if let id = data["id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Open current source document") { DetailView(collection: "documents", id: id) } }
                SourceRowCells(value: data)
                Text("The link opens the current document; this report retains the revision shown above.").font(.footnote)
                }
            }
        case .blockers, .changes:
            DisclosureGroup(data["label"]?.text ?? data["code"]?.text ?? "Review item \(position)", isExpanded: $expanded) {
                if expanded {
                if let message = data["message"] { Notice(message.text, warning: true) }
                if let previous = data["previous"] { Text("Previously retained").font(.headline); SourceRowCells(value: previous.object) }
                if let current = data["current"] { Text("Current source").font(.headline); SourceRowCells(value: current.object) }
                if let previous = data["previous_text"] { LabeledContent("Previously retained", value: previous.text) }
                if let current = data["current_text"] { LabeledContent("Current source", value: current.text) }
                ReportIssueLinks(data: data)
                DisclosureGroup("Check details") { SourceRowCells(value: data.filter { !["previous", "current", "message"].contains($0.key) }) }
                }
            }
        case .receipts:
            let receipt = data["data"]?.object ?? data
            DisclosureGroup(receipt["reference"]?.text ?? "Manual reference \(position)") { SourceRowCells(value: receipt); Text("A manual reference is not authority acceptance.").font(.footnote) }
        case .reissues:
            VStack(alignment: .leading) {
                Text("Reissue: " + (data["status"]?.text ?? "State unavailable"))
                if let id = data["id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Open reissued report") { DetailView(collection: "reports", id: id) } }
            }
        }
    }
}

struct ReportSourceLinks: View {
    let sources: [JSONValue]
    var body: some View {
        ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
            let data = source.object
            DisclosureGroup(data["source_name"]?.text ?? data["filename"]?.text ?? "Retained source reference") {
                RecordEvidenceLink(source: source)
                if let id = data["document_id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Open source document") { DetailView(collection: "documents", id: id) } }
                if let id = data["import_id"]?.text, UUID(uuidString: id) != nil { NavigationLink("Open original import rows") { ImportDetailView(importID: id) } }
                if let raw = data["url"]?.text, let url = URL(string: raw), url.scheme == "https" { Link("Official source", destination: url) }
                SourceRowCells(value: data)
            }
        }
    }
}

struct ReportIssueLinks: View {
    let data: [String: JSONValue]
    var body: some View {
        ForEach(["fact_id", "operation_id", "document_id"], id: \.self) { key in
            if let id = data[key]?.text, UUID(uuidString: id) != nil {
                NavigationLink("Open current " + key.replacingOccurrences(of: "_id", with: "")) { DetailView(collection: key == "fact_id" ? "facts" : key == "operation_id" ? "operations" : "documents", id: id) }
            }
        }
        if let id = data["record_id"]?.text, UUID(uuidString: id) != nil, let kind = data["record_kind"]?.text, ["facts", "operations", "sales", "purchases", "documents"].contains(kind) { NavigationLink("Open current source record") { DetailView(collection: kind, id: id) } }
    }
}
