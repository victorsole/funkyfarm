import SwiftUI

struct RecordEvidenceReference {
    let id: String
    let collection: String
    let revision: String?
    init?(_ value: JSONValue) {
        let source = value.object
        guard let id = source["record_id"]?.text, UUID(uuidString: id) != nil,
              let rawKind = source["record_kind"]?.text else { return nil }
        let aliases = ["sale": "sales", "purchase": "purchases", "operation": "operations", "fact": "facts", "document": "documents"]
        let collection = aliases[rawKind] ?? rawKind
        guard ["sales", "purchases", "operations", "facts", "documents"].contains(collection) else { return nil }
        self.id = id; self.collection = collection
        revision = source["revision"].flatMap { $0 == .null ? nil : $0.text }
    }
    var label: String {
        let name = ["sales": "sale", "purchases": "purchase", "operations": "work", "facts": "fact", "documents": "document"][collection] ?? "record"
        return "Open \(name) source" + (revision.map { " (retained revision \($0))" } ?? "")
    }
}

struct RecordEvidenceLink: View {
    let source: JSONValue
    var body: some View {
        if let reference = RecordEvidenceReference(source) {
            NavigationLink(reference.label) { DetailView(collection: reference.collection, id: reference.id) }
        }
    }
}
