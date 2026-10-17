import SwiftUI

private struct LpisGuideDTO: Decodable {
    struct Step: Decodable { let title: String; let text: String }
    struct Source: Decodable { let title: String; let url: String; let edition: String }
    struct Profile: Decodable, Identifiable {
        let id: String
        let country: String
        let title: String
        let applies_to: String
        let official_url: String?
        let campaign_year: Int?
        let steps: [Step]
        let authority_import_formats: [String]
        let app_export_formats: [String]
        let import_acceptance_verified: Bool
        let limits: [String]
        let sources: [Source]
    }
    let farm_id: String
    let farm_revision: Int
    let country: String?
    let region: String?
    let reporting_year: Int?
    let coverage: String
    let profiles: [Profile]
    let official_url: String?
    let checked_date: String
    let notice: String
    let definition_hash: String
    func matches(_ farm: RecordItem) -> Bool {
        farm_id == farm.id && farm_revision == farm.revision && (country.map(JSONValue.string) ?? .null) == (farm.data["country"] ?? .null) && (region.map(JSONValue.string) ?? .null) == (farm.data["region"] ?? .null) && (reporting_year.map { JSONValue.number(Double($0)) } ?? .null) == (farm.data["reporting_year"] ?? .null)
    }
    func validate(farm: RecordItem) throws {
        let failure = ServiceError(status: 0, message: "The complete field-register guide did not match this saved farm. Reload it; no instructions or file acceptance have been assumed.")
        guard matches(farm), ["documented_steps", "general_guidance_only"].contains(coverage), (coverage == "documented_steps") == !profiles.isEmpty, !notice.isEmpty, !checked_date.isEmpty, definition_hash.utf8.count == 64, definition_hash.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil, Set(profiles.map(\.id)).count == profiles.count else { throw failure }
        for profile in profiles {
            guard !profile.id.isEmpty, profile.country == country, !profile.title.isEmpty, !profile.applies_to.isEmpty, !profile.import_acceptance_verified,
                  !profile.steps.isEmpty, profile.steps.allSatisfy({ !$0.title.isEmpty && !$0.text.isEmpty }),
                  !profile.sources.isEmpty, profile.sources.allSatisfy({ !$0.title.isEmpty && !$0.url.isEmpty && !$0.edition.isEmpty }) else { throw failure }
        }
    }
}

struct LpisGuideView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.openURL) private var openURL
    let farmID: String
    @State private var guide: LpisGuideDTO?
    @State private var farm: RecordItem?
    @State private var grant: JSONValue?
    @State private var scope: String?
    @State private var selectedTask = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var requestID = UUID()
    @State private var operationTask: Task<Void, Never>?
    private var currentFarm: RecordItem? { store.record("farms", farmID) }
    private var bindingCurrent: Bool { guard store.sessionVerified, scope == store.account?.scope, let guide, let currentFarm, currentFarm.workspace_id == store.account?.workspace.id else { return false }; return guide.matches(currentFarm) }
    private var profile: LpisGuideDTO.Profile? { guide?.profiles.first { $0.id == selectedTask } }
    private func safeURL(_ raw: String?) -> URL? { guard let raw, let value = URLComponents(string: raw), value.scheme == "https", let host = value.host, !host.isEmpty, value.user == nil, value.password == nil else { return nil }; return value.url }
    private func formatName(_ raw: String) -> String { ["geojson": "GeoJSON", "kml": "KML", "correction": "Change summary (JSON)"][raw] ?? raw }
    var body: some View {
        List {
            Section("Update the official field register") {
                Text(farm?.title ?? currentFarm?.title ?? "Selected farm").font(.headline)
                Notice("These are manual instructions for the named task. Nothing here changes an official register, sends an application, establishes a deadline or proves acceptance.")
                Button(guide == nil ? "Load the authorized guide for this farm" : "Refresh these instructions") { startLoad() }.disabled(busy || !store.sessionVerified)
            }
            if bindingCurrent, let guide {
                Section("This saved farm and source edition") {
                    LabeledContent("Country", value: guide.country.map { Locale.current.localizedString(forRegionCode: $0) ?? $0 } ?? "Not recorded")
                    LabeledContent("Region", value: guide.region ?? "Not recorded")
                    LabeledContent("Farm reporting year", value: guide.reporting_year.map { String($0) } ?? "Not recorded")
                    Text("A file's source year, this farm's reporting year and the official campaign year are separate. None is selected or upgraded automatically here.")
                    LabeledContent("Guide inventory checked", value: guide.checked_date)
                    Notice(guide.notice)
                }
                if guide.coverage == "general_guidance_only" {
                    Section("Detailed steps are not established") {
                        Notice("Only a general official starting page is known for this country. The exact LPIS task, drawing steps and accepted import formats have not been established. Ask the authority or your adviser which process applies before uploading a file.", warning: true)
                        officialButton("Open the official starting page myself", raw: guide.official_url)
                    }
                } else {
                    Section("Choose the exact task you need") {
                        Picker("Documented task", selection: $selectedTask) { Text("Choose the task described by the source").tag(""); ForEach(guide.profiles) { Text($0.title).tag($0.id) } }.disabled(busy)
                        Text("These instructions do not cover every register, map change or aid application. Use only the named task and its stated limits.").font(.footnote)
                    }
                    if let profile { profileSections(profile, guide: guide) }
                    else { Section { Text("Choose a documented task to read its steps, campaign, formats and limits.") } }
                }
                Section("Before leaving this workspace") {
                    Notice("Use the current official instructions before acting. Keep the actual sending confirmation or reply separately; a saved outline or file upload is not verified submission or acceptance.")
                    Text("Official links open separately after a fresh farm-access and guide check. No app credential is transferred to that website.").font(.footnote)
                }
            } else if !busy {
                Section { Notice("The guide is unavailable or no longer bound to this farm and session. Cached or missing instructions are not treated as current country coverage.", warning: true) }
            }
            if busy { Section { ProgressView("Checking current farm access and instructions…"); Button("Cancel") { invalidate() } } }
            if !store.sessionVerified { Section { Notice("Reconnect before reading this farm's guide. No instructions are stored as an offline authority procedure.", warning: true) } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Official field-register steps")
            .task(id: farmID) { startLoad() }
            .onChange(of: store.account?.scope) { _ in invalidate("The account or workspace changed. Open the guide again for the current farm.") }
            .onChange(of: store.account?.workspace.role) { _ in invalidate("Your workspace role changed. Reload the current authorized guide.") }
            .onChange(of: store.sessionVerified) { verified in if !verified { invalidate("Reconnect and reload before using these instructions.") } }
            .onChange(of: currentFarm) { next in if let guide, next.map({ guide.matches($0) }) != true { invalidate("This farm's saved revision or country context changed. Reload its instructions.") } }
            .onDisappear { invalidate() }
    }
    @ViewBuilder private func profileSections(_ profile: LpisGuideDTO.Profile, guide: LpisGuideDTO) -> some View {
        Section("What this named task covers") {
            Text(profile.title).font(.headline)
            Text(profile.applies_to)
            LabeledContent("Campaign named by the source", value: profile.campaign_year.map { String($0) } ?? "No specific campaign year stated")
            if profile.campaign_year == nil { Notice("The source does not establish a campaign year for these steps. Check the actual current process.", warning: true) }
            else if guide.reporting_year == nil { Notice("This farm's reporting year is not recorded. Check it separately from the campaign named by the source.", warning: true) }
            else if profile.campaign_year != guide.reporting_year { Notice("The source campaign differs from this farm's reporting year. Check the official current process before using these steps.", warning: true) }
            officialButton("Open the official instructions for this task", raw: profile.official_url)
        }
        Section("Documented steps — complete them in the official service") {
            ForEach(Array(profile.steps.enumerated()), id: \.offset) { index, step in VStack(alignment: .leading, spacing: 5) { Text("\(index + 1). " + step.title).font(.headline); Text(step.text) } }
        }
        Section("Private working files and authority formats are different") {
            if profile.app_export_formats.isEmpty { Text("No private export format is listed in this guide.") }
            else { LabeledContent("Private app exports", value: profile.app_export_formats.map(formatName).joined(separator: ", ")) }
            if profile.authority_import_formats.isEmpty { Notice("Accepted import formats have not been established for this named task.", warning: true) }
            else { ForEach(Array(profile.authority_import_formats.enumerated()), id: \.offset) { _, format in Text("Format named by the source: " + format) } }
            Notice("This app has not verified a live import or acceptance. A format name does not mean a particular file is accepted, a register was updated or anything was sent.", warning: true)
        }
        Section("What still needs checking") { ForEach(Array(profile.limits.enumerated()), id: \.offset) { _, limit in Notice(limit, warning: true) } }
        Section("Sources and editions") {
            ForEach(Array(profile.sources.enumerated()), id: \.offset) { _, source in VStack(alignment: .leading, spacing: 5) { officialButton(source.title, raw: source.url); Text(source.edition).font(.footnote).textSelection(.enabled) } }
        }
    }
    @ViewBuilder private func officialButton(_ title: String, raw: String?) -> some View {
        if let url = safeURL(raw) { Button(title) { openOfficial(url) }.disabled(busy || !bindingCurrent) }
        else { Text(title + " — a safe official link is unavailable").foregroundStyle(.secondary) }
    }
    private func sessionGrant(_ value: JSONValue) throws -> JSONValue {
        guard let account = store.account else { throw CancellationError() }
        let user = value.object["user"]?.object ?? [:], workspace = value.object["workspace"]?.object ?? [:]
        guard user["id"] == .string(account.user.id), workspace["id"] == .string(account.workspace.id), let role = workspace["role"]?.text, !role.isEmpty else { throw ServiceError(status: 401, message: "The current session does not match this private workspace. Sign in again before reading its guide.") }
        if case .array(let farms)? = workspace["farm_ids"], !farms.contains(.string(farmID)) { throw ServiceError(status: 403, message: "The current workspace grant does not include this farm.") }
        return .object(["user_id": .string(account.user.id), "workspace_id": .string(account.workspace.id), "role": .string(role), "farm_ids": workspace["farm_ids"] ?? .null, "permissions": workspace["permissions"] ?? .null])
    }
    private func assertContext(_ expectedScope: String) throws {
        guard expectedScope == store.account?.scope, store.sessionVerified, !Task.isCancelled else { throw CancellationError() }
    }
    private func readCurrent(scope expectedScope: String) async throws -> (LpisGuideDTO, RecordItem, JSONValue) {
        try assertContext(expectedScope)
        let before = try sessionGrant(try await store.scopedValue("/auth/session"))
        try assertContext(expectedScope)
        let farm = try await store.refreshDetail("farms", farmID)
        guard farm.id == farmID, farm.kind == "farms", farm.workspace_id == store.account?.workspace.id else { throw ServiceError(status: 0, message: "The current farm did not match this workspace.") }
        try assertContext(expectedScope)
        let value = try await store.scopedValue("/farms/\(farmID)/lpis-guide")
        let decoded = try JSONDecoder().decode(LpisGuideDTO.self, from: JSONEncoder().encode(value)); try decoded.validate(farm: farm)
        try assertContext(expectedScope)
        let after = try sessionGrant(try await store.scopedValue("/auth/session"))
        try assertContext(expectedScope)
        let checkedFarm = try await store.refreshDetail("farms", farmID)
        guard before == after, decoded.matches(checkedFarm), checkedFarm.workspace_id == store.account?.workspace.id, store.sessionVerified, !Task.isCancelled else { throw ServiceError(status: 409, message: "Farm access or its saved context changed while reading these instructions. Reload before continuing.") }
        return (decoded, checkedFarm, after)
    }
    private func startLoad() {
        invalidate(); let stamp = requestID, selectedScope = store.account?.scope
        guard let selectedScope, store.sessionVerified, UUID(uuidString: farmID) != nil else { problem = "Reconnect and select a saved farm before loading the guide."; return }
        busy = true
        operationTask = Task {
            defer { if stamp == requestID { busy = false; operationTask = nil } }
            do { let (value, savedFarm, savedGrant) = try await readCurrent(scope: selectedScope); guard stamp == requestID, selectedScope == store.account?.scope, store.sessionVerified, !Task.isCancelled else { return }; farm = savedFarm; grant = savedGrant; scope = selectedScope; guide = value }
            catch { if stamp == requestID { guide = nil; problem = SourceText.error(error) } }
        }
    }
    private func openOfficial(_ url: URL) {
        guard !busy, bindingCurrent, let guide, let grant, let scope else { return }
        let stamp = requestID; busy = true; problem = nil
        operationTask = Task {
            defer { if stamp == requestID { busy = false; operationTask = nil } }
            do { let (fresh, _, freshGrant) = try await readCurrent(scope: scope); guard stamp == requestID, scope == store.account?.scope, store.sessionVerified, !Task.isCancelled else { return }; guard freshGrant == grant, fresh.definition_hash == guide.definition_hash else { throw ServiceError(status: 409, message: "These instructions or your farm access changed. Reload and read the current guide before opening its links.") }; openURL(url) }
            catch { if stamp == requestID { invalidate(SourceText.error(error)) } }
        }
    }
    private func invalidate(_ message: String? = nil) { requestID = UUID(); operationTask?.cancel(); operationTask = nil; guide = nil; farm = nil; grant = nil; scope = nil; selectedTask = ""; busy = false; problem = message }
}
