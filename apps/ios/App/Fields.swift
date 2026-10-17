import SwiftUI
import MapKit

struct FieldsView: View {
    @EnvironmentObject private var store: AppStore
    var initialFarmID: String? = nil
    @State private var farmID = ""
    @State private var library: [String: JSONValue] = [:]
    @State private var proposals: [RecordItem] = []
    @State private var problem: String?
    @State private var working = false
    private var farm: RecordItem? { store.record("farms", farmID) }
    var body: some View {
        List {
            Section {
                FarmPicker(selected: $farmID)
                if let farm { NavigationLink("Edit farm details") { FarmSetupView(existing: farm) } }
                if store.records("farms").isEmpty { NavigationLink("Set up my farm") { FarmSetupView() } }
                if !farmID.isEmpty { NavigationLink { FieldEditor(farmID: farmID, expectedRevision: revision) } label: { Label("Add a field", systemImage: "plus") } }
                if !farmID.isEmpty, let url = BrowserHandoff.url(account: store.account, path: "/app/fields/\(farmID)") { Link("Open boundary drawing, split, merge and LPIS tools", destination: url); Text("Advanced boundary work opens the actual web map editor with a separate browser sign-in. This app does not simulate those operations or transfer your bearer credential.").font(.footnote).foregroundStyle(.secondary) }
            }
            SyncBanner()
            Section("Recorded fields") {
                let items = library["items"]?.array ?? []
                if items.isEmpty { Text("No fields are loaded for this farm. A field can start with a name; add a location or boundary only when you have one.").foregroundStyle(.secondary) }
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    NavigationLink { FieldDetail(farmID: farmID, field: item.object, farmRevision: revision) } label: {
                        VStack(alignment: .leading, spacing: 4) { Text(item.object["name"]?.text ?? "Field").font(.headline); if let crop = item.object["crop"], crop != .null { Text(crop.text).font(.caption) }; if let area = item.object["approximate_area_ha"], area != .null { Text("Approximate mapped area: \(area.text) ha").font(.caption).foregroundStyle(.secondary) } }
                    }
                }
                if let meaning = library["meaning"] { Notice(meaning.text) }
            }
            Section("Proposals awaiting your review") {
                ForEach(proposals.filter { !["approved", "rejected", "cancelled"].contains($0.state) }) { proposal in
                    NavigationLink { FieldProposalReview(proposal: proposal, farmID: farmID) } label: { Text(proposal.data["parcel"]?.object["name"]?.text ?? proposal.title) }
                }
            }
            if working { Section { ProgressView("Loading fields…") } }
            if let problem { Section { Notice(problem, warning: true); Button("Try again") { Task { await load() } } } }
        }.navigationTitle("My fields")
            .onAppear { if farmID.isEmpty { farmID = initialFarmID ?? (store.records("farms").count == 1 ? store.records("farms")[0].id : "") } }
            .task(id: farmID) { await load() }
            .refreshable { await load() }
    }
    private var revision: Int {
        if case .number(let number)? = library["revision"] { return Int(number) }
        return farm?.revision ?? 1
    }
    private func load() async {
        proposals = []; problem = nil
        guard !farmID.isEmpty else { library = [:]; return }
        let selectedFarm = farmID
        library = store.disk.fieldLibraries[selectedFarm]?.object ?? [:]
        guard store.sessionVerified else { return }
        working = true; defer { working = false }
        do {
            let loaded = try await store.loadFieldLibrary(selectedFarm)
            guard selectedFarm == farmID else { return }; library = loaded
            let page = try await store.scopedValue("/farms/\(selectedFarm)/field-proposals")
            guard selectedFarm == farmID else { return }
            proposals = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(page.object["items"] ?? .array([])))
            _ = try await store.refreshDetail("farms", selectedFarm)
        } catch { problem = error.localizedDescription }
    }
}

struct FieldDetail: View {
    let farmID: String
    let field: [String: JSONValue]
    let farmRevision: Int
    var body: some View {
        List {
            Section {
                Text(field["name"]?.text ?? "Field").font(.title2.bold())
                if field["point"] == nil && field["geometry"] == nil { Text("No recorded coordinates or boundary supplied.").foregroundStyle(.secondary) }
                FieldMap(field: field).frame(height: 260)
                if field["point"] != nil, field["geometry"] == nil { Notice("This is a recorded point, not a field boundary. It does not establish field area.") }
                if let area = field["approximate_area_ha"], area != .null { LabeledContent("Approximate mapped area", value: "\(area.text) ha") }
                Notice("A drawn or imported boundary is farm evidence. It is not an accepted authority parcel or an eligibility decision.")
            }
            Section("Crop and context") { JSONFields(data: field.filter { !["geometry", "point", "geometry_summary"].contains($0.key) }) }
            Section {
                NavigationLink("Propose changes to this field") { FieldEditor(farmID: farmID, expectedRevision: farmRevision, existing: field) }
                if let id = field["id"]?.text { NavigationLink("Check available satellite scenes") { SatelliteSearchView(farmID: farmID, parcelID: id) } }
                if let summary = field["geometry_summary"] { DisclosureGroup("Boundary quality and method") { Text(summary.text).font(.callout).textSelection(.enabled) } }
            }
        }.navigationTitle("Field details")
    }
}

struct FieldEditor: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let farmID: String
    let expectedRevision: Int
    var existing: [String: JSONValue]? = nil
    @State private var name = ""
    @State private var crop = ""
    @State private var notes = ""
    @State private var greenhouseKnown = false
    @State private var greenhouse = false
    @State private var latitude = ""
    @State private var longitude = ""
    @State private var geometry = ""
    @State private var reason = ""
    @State private var problem: String?
    var body: some View {
        Form {
            Section("Field details") {
                TextField("Field name", text: $name)
                TextField("Crop, if known", text: $crop)
                Toggle("Greenhouse status is known", isOn: $greenhouseKnown)
                if greenhouseKnown { Toggle("This is a greenhouse", isOn: $greenhouse) }
                TextField("Notes", text: $notes, axis: .vertical)
            }
            Section("Optional recorded location") {
                TextField("Latitude", text: $latitude).keyboardType(.numbersAndPunctuation)
                TextField("Longitude", text: $longitude).keyboardType(.numbersAndPunctuation)
                Text("Use coordinates from a known source. A point locates the field but does not define its boundary or area.").font(.footnote).foregroundStyle(.secondary)
                DisclosureGroup("Import an existing boundary") {
                    TextField("GeoJSON Polygon or MultiPolygon", text: $geometry, axis: .vertical).lineLimit(4...12).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Text("Paste the original geometry. The service checks coordinates, shape validity and overlaps before approval.").font(.footnote)
                }
            }
            Section("Review trail") {
                TextField("Where did this field information come from?", text: $reason, axis: .vertical)
                Text("Farm revision compared: \(expectedRevision)").font(.caption).foregroundStyle(.secondary)
                Button("Save field proposal on this device") { save() }.buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Notice("Sync creates a proposal. Your farm's approved field record changes only after you review and approve that proposal.")
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle(existing == nil ? "Add field" : "Review field changes")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onAppear {
                if let existing {
                    name = existing["name"]?.text ?? ""; crop = existing["crop"]?.text.suppliedValue ?? ""; notes = existing["notes"]?.text.suppliedValue ?? ""
                    if case .bool(let flag)? = existing["greenhouse"] { greenhouseKnown = true; greenhouse = flag }
                    let point = existing["point"]?.object ?? [:]
                    if case .number(let number)? = point["latitude"] { latitude = String(number) }
                    if case .number(let number)? = point["longitude"] { longitude = String(number) }
                    if let shape = existing["geometry"], shape != .null { geometry = shape.text }
                }
            }
    }
    private func save() {
        do {
            var parcel = existing ?? [:]
            // Server-derived summaries cannot be supplied as source geometry.
            for key in ["geometry_summary", "approximate_area_ha", "revision", "external_id"] { parcel.removeValue(forKey: key) }
            parcel["name"] = .string(name); parcel["crop"] = crop.isEmpty ? .null : .string(crop); parcel["notes"] = .string(notes)
            if greenhouseKnown { parcel["greenhouse"] = .bool(greenhouse) } else { parcel.removeValue(forKey: "greenhouse") }
            if !latitude.isEmpty || !longitude.isEmpty {
                guard let lat = Double(latitude), let lon = Double(longitude), lat.isFinite, lon.isFinite, (-90...90).contains(lat), (-180...180).contains(lon) else { throw ServiceError(status: 0, message: "Enter both latitude and longitude in their valid ranges.") }
                parcel["point"] = .object(["latitude": .number(lat), "longitude": .number(lon)])
            } else { parcel.removeValue(forKey: "point") }
            if !geometry.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let value = try JSONDecoder().decode(JSONValue.self, from: Data(geometry.utf8))
                guard ["Polygon", "MultiPolygon"].contains(value.object["type"]?.text ?? "") else { throw ServiceError(status: 0, message: "Supply a GeoJSON Polygon or MultiPolygon.") }
                parcel["geometry"] = value
            } else { parcel.removeValue(forKey: "geometry") }
            try store.saveAction(path: "/farms/\(farmID)/field-proposals", label: "Field: \(name)", payload: ["expected_revision": .number(Double(expectedRevision)), "parcel": .object(parcel), "note": .string(reason)])
            dismiss()
        } catch { problem = error.localizedDescription }
    }
}

struct FieldProposalReview: View {
    @EnvironmentObject private var store: AppStore
    let proposal: RecordItem
    let farmID: String
    @State private var currentFarm: RecordItem?
    @State private var overlap = false
    @State private var note = ""
    @State private var working = false
    @State private var problem: String?
    @State private var approve = false
    @State private var saved = false
    @State private var reviewedFields: Set<String> = []
    private var operation: String { proposal.data["operation"]?.text ?? "edit" }
    private var retiresParents: Bool { ["split", "merge"].contains(operation) }
    private var proposedFields: [[String: JSONValue]] {
        if let values = proposal.data["parcels"] { return values.array.map(\.object) }
        return proposal.data["parcel"].map { [$0.object] } ?? []
    }
    private var priorFields: [[String: JSONValue]] {
        if let values = proposal.data["previous_parcels"] { return values.array.map(\.object) }
        return proposal.data["previous_parcel"].flatMap { $0 == .null ? nil : [$0.object] } ?? []
    }
    private var requiredReviews: Set<String> { Set(proposedFields.indices.map { "new:\($0)" } + priorFields.indices.map { "prior:\($0)" }) }
    private var allReviewed: Bool { !proposedFields.isEmpty && (!retiresParents || !priorFields.isEmpty) && requiredReviews.isSubset(of: reviewedFields) }
    private var currentBaseline: Bool {
        guard let currentFarm, case .number(let revision)? = proposal.data["base_farm_revision"] else { return false }
        return Double(currentFarm.revision) == revision
    }
    private var needsOverlapReview: Bool { !(proposal.data["overlapping_fields"]?.array ?? []).isEmpty || (proposal.data["warnings"]?.text.localizedCaseInsensitiveContains("overlap") ?? false) }
    private func review(_ key: String) -> Binding<Bool> { Binding(get: { reviewedFields.contains(key) }, set: { if $0 { reviewedFields.insert(key) } else { reviewedFields.remove(key) } }) }
    var body: some View {
        List {
            Section("Review the whole \(operation) proposal") {
                Text("\(proposedFields.count) proposed fields · \(priorFields.count) prior fields")
                if retiresParents { Notice("Every prior field shown below will be retired, not deleted, and linked to the proposed replacements.") }
                else { Notice("Review the previous revision and all proposed information. History remains retained.") }
                if let note = proposal.data["note"] { Text(note.text) }
                if let warnings = proposal.data["warnings"] { Notice(warnings.text, warning: true) }
                if let overlaps = proposal.data["overlapping_fields"], !overlaps.array.isEmpty { DisclosureGroup("All reported overlaps") { Text(overlaps.text).textSelection(.enabled) } }
            }
            ForEach(Array(priorFields.enumerated()), id: \.offset) { index, field in
                Section(retiresParents ? "Prior field \(index + 1) · will be retired" : "Prior field \(index + 1)") {
                    FieldProposalParcel(field: field)
                    Toggle(retiresParents ? "I checked this prior field and its retirement" : "I checked this previous field record", isOn: review("prior:\(index)"))
                }
            }
            ForEach(Array(proposedFields.enumerated()), id: \.offset) { index, field in
                Section("Proposed field \(index + 1)") {
                    FieldProposalParcel(field: field)
                    Toggle("I checked this proposed field, boundary and details", isOn: review("new:\(index)"))
                }
            }
            if let reference = proposal.data["reference"], reference != .null {
                Section("Supplied comparison reference · not an official update") { FieldProposalParcel(field: reference.object) }
            }
            Section("Comparison and retained lineage") {
                if let comparison = proposal.data["comparison"] { DisclosureGroup("Boundary comparison") { Text(comparison.text).textSelection(.enabled) } }
                if let lineage = proposal.data["lineage"] { JSONFields(data: lineage.object) }
                if let splitLine = proposal.data["split_line"], splitLine != .null { DisclosureGroup("Supplied split line") { Text(splitLine.text).textSelection(.enabled) } }
            }
            Section("Compare with the current farm") {
                Button("Load current farm revision") {
                    working = true
                    Task { do { currentFarm = try await store.refreshDetail("farms", farmID) } catch { problem = error.localizedDescription }; working = false }
                }.disabled(working || !store.sessionVerified)
                if let currentFarm {
                    LabeledContent("Current farm revision", value: "\(currentFarm.revision)")
                    DisclosureGroup("Current approved field records") { Text(currentFarm.data["parcels"]?.text ?? "No field geometry is recorded.").font(.callout).textSelection(.enabled) }
                    if !currentBaseline { Notice("The farm changed after this proposal. Prepare a new proposal against the current farm before approving.", warning: true) }
                    if retiresParents && priorFields.isEmpty { Notice("The prior fields are missing. Reload the complete proposal before reviewing replacements.", warning: true) }
                    if needsOverlapReview { Toggle("I reviewed and accept every reported boundary overlap", isOn: $overlap) }
                    TextField("Approval note", text: $note, axis: .vertical)
                    Button("Approve all reviewed field changes") { approve = true }.buttonStyle(.borderedProminent).disabled(working || note.isEmpty || saved || !allReviewed || !currentBaseline || (needsOverlapReview && !overlap) || proposal.state != "proposed")
                }
                if saved { Notice("The service recorded this approval. Reload My fields to view the updated farm.") }
                if working { ProgressView("Waiting for service…") }
                if let problem { Notice(problem, warning: true) }
            }
        }.navigationTitle("Review field proposal")
            .onChange(of: currentFarm?.revision) { _ in reviewedFields = []; overlap = false }
            .onChange(of: proposal.revision) { _ in reviewedFields = []; overlap = false }
            .confirmationDialog("Apply all \(proposedFields.count) proposed fields\(retiresParents ? " and retire all \(priorFields.count) prior fields" : "") to the compared farm revision?", isPresented: $approve, titleVisibility: .visible) {
                Button("Approve field proposal") {
                    guard let currentFarm, allReviewed, currentBaseline, !needsOverlapReview || overlap else { return }; working = true
                    Task {
                        do { _ = try await store.scopedValue("/field-proposals/\(proposal.id)/approve", method: "POST", body: ["expected_revision": .number(Double(proposal.revision)), "expected_farm_revision": .number(Double(currentFarm.revision)), "note": .string(note), "accept_overlap": .bool(overlap)], idempotency: proposal.id + "-approve-\(proposal.revision)-\(currentFarm.revision)"); _ = try await store.loadFieldLibrary(farmID); await store.refresh(); saved = true }
                        catch { problem = error.localizedDescription }
                        working = false
                    }
                }
            }
    }
}

private struct FieldProposalParcel: View {
    let field: [String: JSONValue]
    var body: some View {
        Text(field["name"]?.text ?? "Supplied reference").font(.headline)
        FieldMap(field: field).frame(height: 230)
        JSONFields(data: field.filter { $0.key != "geometry" })
        if let geometry = field["geometry"], geometry != .null { DisclosureGroup("Exact source coordinates") { Text(geometry.text).font(.callout).textSelection(.enabled) } }
    }
}

struct FieldMap: UIViewRepresentable {
    let field: [String: JSONValue]
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> MKMapView { let view = MKMapView(); view.delegate = context.coordinator; view.isRotateEnabled = false; return view }
    func updateUIView(_ view: MKMapView, context: Context) {
        view.removeOverlays(view.overlays); view.removeAnnotations(view.annotations)
        let geometry = field["geometry"]?.object ?? [:]
        let coordinates = geometry["coordinates"]?.array ?? []
        let polygons: [[JSONValue]] = geometry["type"]?.text == "MultiPolygon" ? coordinates.map(\.array) : [coordinates]
        var region: MKMapRect?
        func ringPoints(_ ring: JSONValue) -> [CLLocationCoordinate2D] {
            ring.array.compactMap { value in
                let pair = value.array
                guard pair.count >= 2, case .number(let lon) = pair[0], case .number(let lat) = pair[1], CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: lat, longitude: lon)) else { return nil }
                return CLLocationCoordinate2D(latitude: lat, longitude: lon)
            }
        }
        for rings in polygons {
            let points = rings.first.map(ringPoints) ?? []
            if points.count >= 3 {
                let holes = rings.dropFirst().compactMap { ring -> MKPolygon? in let hole = ringPoints(ring); return hole.count >= 3 ? MKPolygon(coordinates: hole, count: hole.count) : nil }
                let polygon = MKPolygon(coordinates: points, count: points.count, interiorPolygons: holes); view.addOverlay(polygon)
                region = region.map { $0.union(polygon.boundingMapRect) } ?? polygon.boundingMapRect
            }
        }
        if let region { view.setVisibleMapRect(region, edgePadding: UIEdgeInsets(top: 30, left: 30, bottom: 30, right: 30), animated: false) }
        else {
            let point = field["point"]?.object ?? [:]
            if case .number(let lat)? = point["latitude"], case .number(let lon)? = point["longitude"], CLLocationCoordinate2DIsValid(CLLocationCoordinate2D(latitude: lat, longitude: lon)) {
                let coordinate = CLLocationCoordinate2D(latitude: lat, longitude: lon)
                let annotation = MKPointAnnotation(); annotation.coordinate = coordinate; annotation.title = field["name"]?.text; view.addAnnotation(annotation)
                view.setRegion(MKCoordinateRegion(center: coordinate, latitudinalMeters: 1_000, longitudinalMeters: 1_000), animated: false)
            } else {
                // No guessed farm location is displayed when the source has no coordinates.
                view.isHidden = true; return
            }
        }
        view.isHidden = false
        view.accessibilityLabel = field["name"]?.text ?? "Recorded field map"
    }
    final class Coordinator: NSObject, MKMapViewDelegate {
        func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
            let renderer = MKPolygonRenderer(overlay: overlay); renderer.strokeColor = UIColor(FarmStyle.ink); renderer.fillColor = UIColor(FarmStyle.ochre).withAlphaComponent(0.25); renderer.lineWidth = 2; return renderer
        }
    }
}

struct SatelliteSearchView: View {
    @EnvironmentObject private var store: AppStore
    let farmID: String
    let parcelID: String
    @State private var start = Calendar.current.date(byAdding: .day, value: -30, to: Date()) ?? Date()
    @State private var end = Date()
    @State private var cloud = 30.0
    @State private var response: JSONValue?
    @State private var working = false
    @State private var problem: String?
    var body: some View {
        Form {
            Section("Search actual source scenes") {
                DatePicker("From", selection: $start, displayedComponents: .date)
                DatePicker("To", selection: $end, displayedComponents: .date)
                Slider(value: $cloud, in: 0...100, step: 1) { Text("Maximum cloud cover") }
                LabeledContent("Maximum scene cloud cover", value: "\(Int(cloud))%")
                Button("Search available scenes") {
                    working = true; problem = nil
                    Task {
                        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX"); format.dateFormat = "yyyy-MM-dd"
                        do { response = try await store.scopedValue("/satellite/search", method: "POST", body: ["farm_id": .string(farmID), "parcel_id": .string(parcelID), "start_date": .string(format.string(from: start)), "end_date": .string(format.string(from: end)), "max_cloud_cover": .number(cloud), "limit": .number(10)]) }
                        catch { problem = error.localizedDescription }
                        working = false
                    }
                }.disabled(working || !store.sessionVerified || start > end)
                Notice("Scene availability, clouds and observation dates limit what can be inferred. Satellite context does not prove a farm action or regulatory compliance.")
            }
            if working { Section { ProgressView("Requesting source catalogue…") } }
            if let response { Section("Source response") { JSONFields(data: response.object) } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Satellite context")
    }
}
