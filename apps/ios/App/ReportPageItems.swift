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
                if data["journal_schema"] == .string("pt-ppp-surface-v1") {
                    if let context = data["journal_context"] { RetainedPortugueseJournalContext(value: context) }
                    if let group = data["group_label"] { Text(group.text).font(.headline) }
                    if let column = data["column"] { LabeledContent("Literal template column", value: column.text) }
                    if let date = data["actual_date"] { LabeledContent("Separately confirmed actual date", value: date.text) }
                    if let id = data["entry_id"] { LabeledContent("Retained source row reference", value: id.text).font(.caption).textSelection(.enabled) }
                    Text("Portuguese literal manual preparation. Unknown, empty text and zero remain distinct; no date, dose or legal completeness is inferred.").font(.footnote)
                }
                if let schema = data["row_schema"]?.object, !schema.isEmpty, case .object(let cells)? = data["value"] {
                    Notice("These labels and units are retained in this snapshot. The current source catalogue is not used to reinterpret them.")
                    SourceRowCells(value: cells, schema: schema)
                } else if data["fact_key"] == .string(CzechJournalData.holderKey) { CzechHolderValues(value: data["value"]?.object ?? [:]) }
                else { SourceCellValue(value: data["value"]) }
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
                if let journal = data["journal_entry"]?.object, !journal.isEmpty { RetainedCzechJournalEntry(context: journal) }
                else { SourceRowCells(value: operation.filter { $0.key != "sources" }) }
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

private struct RetainedPortugueseJournalContext: View {
    let value: JSONValue
    @State private var selectedOffset = 0
    @State private var excludedOffset = 0
    private var data: [String: JSONValue] { value.object }
    private var selected: [JSONValue] { data["selection"]?.object["entry_ids"]?.array ?? [] }
    private var excluded: [JSONValue] { data["excluded_entries"]?.array ?? [] }
    private var complete: Bool {
        guard data["schema_id"] == .string("pt-ppp-surface-v1"), case .object(let source)? = data["source"],
              case .array? = data["selection"]?.object["entry_ids"], case .array? = data["excluded_entries"],
              data["selection"]?.object["acknowledged_unresolved"] == .bool(true), (1...256).contains(selected.count), selected.count + excluded.count <= 256,
              selected.allSatisfy({ UUID(uuidString: $0.text) != nil }), Set(selected).count == selected.count,
              UUID(uuidString: data["source_fact_id"]?.text ?? "") != nil, SourceText.year(data["source_fact_revision"]) != nil,
              ["title", "edition", "sha256"].allSatisfy({ if case .string(let text)? = source[$0] { return !text.isEmpty }; return false }),
              case .string(let hash)? = data["source_fact_hash"], hash.count == 64 else { return false }
        return excluded.allSatisfy { entry in
            UUID(uuidString: entry.object["entry_id"]?.text ?? "") != nil && ["date_missing", "date_unconfirmed", "future_date", "different_year", "not_selected"].contains(entry.object["reason"]?.text ?? "")
        }
    }
    var body: some View {
        if complete {
            VStack(alignment: .leading, spacing: 8) {
                Text("Retained Portuguese preparation context").font(.headline)
                Text(data["capability_notice"]?.text ?? "Manual preparation only. Not an authority submission or a legal compliance decision.").font(.callout)
                let source = data["source"]?.object ?? [:]
                LabeledContent("Named source", value: source["title"]?.text ?? "Not supplied")
                LabeledContent("Retained source edition", value: source["edition"]?.text ?? "Not supplied")
                LabeledContent("App selection year", value: data["reporting_year"]?.text ?? "Not supplied")
                LabeledContent("Source fact revision", value: data["source_fact_revision"]?.text ?? "Not supplied")
                DisclosureGroup("Retained source identity and hashes") {
                    Text("Source fact reference").font(.caption); Text(data["source_fact_id"]?.text ?? "Not supplied").textSelection(.enabled)
                    Text("Source fact content hash").font(.caption); Text(data["source_fact_hash"]?.text ?? "Not supplied").font(.caption.monospaced()).textSelection(.enabled)
                    Text("Original template SHA-256").font(.caption); Text(source["sha256"]?.text ?? "Not supplied").font(.caption.monospaced()).textSelection(.enabled)
                    ForEach(["url", "page_url"], id: \.self) { key in
                        if let raw = source[key]?.text, let url = URL(string: raw), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil { Link(key == "url" ? "Named template source" : "Named source page", destination: url) }
                    }
                }
                DisclosureGroup("Exact selected output order · \(selected.count) rows") {
                    ForEach(Array(selected.enumerated()).filter { (selectedOffset..<(selectedOffset + 16)).contains($0.offset) }, id: \.offset) { index, id in
                        VStack(alignment: .leading) { Text("Output row \(index + 1)").font(.caption.bold()); Text(id.text).font(.caption).textSelection(.enabled) }
                    }
                    HStack { Button("Previous selected rows") { selectedOffset = max(0, selectedOffset - 16) }.disabled(selectedOffset == 0); Spacer(); Button("Next selected rows") { selectedOffset += 16 }.disabled(selectedOffset + 16 >= selected.count) }
                    Text("These are internal source-row references, not official identifiers. Each retained cell below carries its row reference, output group and separately confirmed actual date.").font(.footnote)
                }
                DisclosureGroup("Original rows excluded from this preparation · \(excluded.count)") {
                    if excluded.isEmpty { Text("No original source rows were excluded from this selection.") }
                    ForEach(Array(excluded.enumerated()).filter { (excludedOffset..<(excludedOffset + 16)).contains($0.offset) }, id: \.offset) { _, entry in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.object["entry_id"]?.text ?? "Source row reference unavailable").font(.caption).textSelection(.enabled)
                            Text(reason(entry.object["reason"]?.text ?? ""))
                            Text("Actual date retained for this excluded row").font(.caption); SourceCellValue(value: entry.object["actual_date"])
                        }
                    }
                    HStack { Button("Previous excluded rows") { excludedOffset = max(0, excludedOffset - 16) }.disabled(excludedOffset == 0); Spacer(); Button("Next excluded rows") { excludedOffset += 16 }.disabled(excludedOffset + 16 >= excluded.count) }
                    Text("Excluded rows still exist in the original source journal. Their literal cells are not silently deleted or copied into this preparation.").font(.footnote)
                }
                Text("The person preparing this snapshot explicitly acknowledged unresolved raw cells and manual-only limits. This is not an official acceptance or completeness finding.").font(.footnote)
            }
        } else { Notice("The retained Portuguese template and row-selection context is unavailable or unsupported. Do not infer source edition, order or excluded rows from the current template.", warning: true) }
    }
    private func reason(_ code: String) -> String {
        ["date_missing": "No separate actual date was supplied.", "date_unconfirmed": "The separately supplied date was not explicitly confirmed.", "future_date": "The supplied actual date was in the future at preparation.", "different_year": "The supplied actual date was outside the selected year.", "not_selected": "The person preparing this document did not select this source row."][code] ?? "The retained exclusion reason is not recognised; compare the original journal before relying on this preparation."
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
