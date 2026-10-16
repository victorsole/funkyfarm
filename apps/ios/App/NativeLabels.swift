import SwiftUI

@MainActor final class NativeLabels: ObservableObject {
    struct Language: Decodable { let name: String; let labels: String }
    struct LanguageOption: Identifiable { let code: String; let name: String; var id: String { code } }
    struct Catalogue: Decodable {
        let keys: [String]
        let languages: [String: Language]
        let additional: [String: [String: String]]?
    }
    @Published var selection: String {
        didSet { UserDefaults.standard.set(selection, forKey: "FunkyFarmLanguage") }
    }
    private let catalogue: Catalogue?
    init() {
        selection = UserDefaults.standard.string(forKey: "FunkyFarmLanguage") ?? "system"
        if let url = Bundle.main.url(forResource: "interface", withExtension: "json"), let bytes = try? Data(contentsOf: url) { catalogue = try? JSONDecoder().decode(Catalogue.self, from: bytes) }
        else { catalogue = nil }
    }
    var language: String {
        let preferred = selection == "system" ? (Locale.preferredLanguages.first?.split(separator: "-").first.map(String.init) ?? "en") : selection
        return catalogue?.languages[preferred] != nil ? preferred : "en"
    }
    var locale: Locale { Locale(identifier: language) }
    var languages: [LanguageOption] { (catalogue?.languages ?? [:]).map { LanguageOption(code: $0.key, name: $0.value.name) }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending } }
    var available: Bool { catalogue != nil }
    func text(_ key: String, fallback: String) -> String {
        if let extra = catalogue?.additional?[key]?[language] { return extra }
        guard let catalogue, let index = catalogue.keys.firstIndex(of: key), let source = catalogue.languages[language] else { return fallback }
        let labels = source.labels.split(separator: "|", omittingEmptySubsequences: false)
        return labels.indices.contains(index) ? String(labels[index]) : fallback
    }
}

struct LanguageSettingsView: View {
    @EnvironmentObject private var labels: NativeLabels
    var body: some View {
        Form {
            Section {
                Picker(labels.text("common.language", fallback: "Language"), selection: $labels.selection) {
                    Text("Use device language").tag("system")
                    ForEach(labels.languages) { Text($0.name).tag($0.code) }
                }
                Notice(labels.text("language.draftNotice", fallback: "Draft translations; some screens remain in English."))
                Text("Navigation, authentication, selected common actions and status labels use the shared draft catalogue. Detailed forms, source guidance, errors and country rules are not fully translated or independently language-reviewed. Language changes keep your farm, country and saved progress.").font(.footnote).foregroundStyle(.secondary)
                if !labels.available { Notice("Translation resources could not be loaded. English labels are displayed.", warning: true) }
            }
        }.navigationTitle(labels.text("common.language", fallback: "Language"))
    }
}
