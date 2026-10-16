import SwiftUI

struct CountryAvailabilityView: View {
    @EnvironmentObject private var store: AppStore
    @State private var country = "DE"
    @State private var year = Calendar.current.component(.year, from: Date())
    @State private var capabilities: [[String: JSONValue]] = []
    @State private var profile: [String: JSONValue] = [:]
    @State private var working = false
    @State private var problem: String?
    private let countries = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]
    var body: some View {
        List {
            Section("Country and reporting period") {
                Picker("Country", selection: $country) { ForEach(countries, id: \.self) { Text(Locale.current.localizedString(forRegionCode: $0) ?? $0).tag($0) } }
                Stepper("Reporting year \(String(year))", value: $year, in: 2000...2100)
                Button("Load available formats and connections") { Task { await load() } }.disabled(working || !store.sessionVerified)
                Notice("Selecting a country does not establish that every regional form or connection is available. Use only the capability and source status returned by the service.")
            }
            Section("Reporting formats returned for this selection") {
                ForEach(store.packs(country: country, year: year)) { pack in DisclosureGroup(pack.title) { Text(pack.capability); JSONFields(data: pack.data) } }
                if store.packs(country: country, year: year).isEmpty { Text("No formats are currently loaded for the selected country and year.").foregroundStyle(.secondary) }
            }
            if !profile.isEmpty {
                Section("Country sources and recorded coverage") { JSONFields(data: profile) }
            }
            Section("CAP connection capabilities") {
                ForEach(Array(capabilities.enumerated()), id: \.offset) { _, capability in
                    DisclosureGroup(capability["title"]?.text ?? "Connection capability") {
                        LabeledContent("Available mode", value: capability["mode"]?.text ?? "Not specified")
                        LabeledContent("Live reading", value: capability["live_read"] == .bool(true) ? "Available as described by the service" : "Not available")
                        LabeledContent("Automatic authority filing", value: capability["automatic_filing"] == .bool(true) ? "Review the authorized transport details" : "Not available")
                        if let requirements = capability["setup_requirements"] { Text(requirements.text) }
                        if let limits = capability["limitations"] { Notice(limits.text) }
                        if let sources = capability["sources"] { SourceReferences(value: sources) }
                        if let address = capability["official_url"]?.text, let url = URL(string: address), url.scheme == "https" { Link("Open the official service", destination: url) }
                    }
                }
                if capabilities.isEmpty { Text("No connection capability is loaded. A report export is available only through its own review and approval flow.").foregroundStyle(.secondary) }
                Notice("Native report approval and export stay available independently of a portal connection. Connections that require a web consent or manual handoff must be completed in the signed-in web workspace.")
                if let url = BrowserHandoff.url(account: store.account, path: "/app/connections") { Link("Open connection setup in the web workspace", destination: url) }
            }
            if working { Section { ProgressView("Loading current capabilities…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Country availability").onAppear { if let farm = store.records("farms").first, !farm.value("country").isEmpty { country = farm.value("country") } }
            .onChange(of: country) { _ in capabilities = []; profile = [:] }
            .onChange(of: year) { _ in capabilities = [] }
    }
    private func load() async {
        working = true; problem = nil; capabilities = []; profile = [:]; defer { working = false }
        let selectedCountry = country, selectedYear = year
        var failures: [String] = []
        do { let result = try await store.scopedValue("/countries/\(selectedCountry)").object; if selectedCountry == country { profile = result } }
        catch { failures.append(error.localizedDescription) }
        do {
            try await store.loadPacks(country: selectedCountry, year: selectedYear)
            let result = try await store.scopedValue("/connections/capabilities?country=\(selectedCountry)&workflow_id=cap")
            guard selectedCountry == country, selectedYear == year else { return }
            capabilities = result.object["items"]?.array.map(\.object) ?? []
        } catch { failures.append(error.localizedDescription) }
        if !failures.isEmpty { problem = failures.joined(separator: "\n") }
    }
}
