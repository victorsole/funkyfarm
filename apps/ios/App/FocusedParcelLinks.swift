import SwiftUI

struct FocusedDemoLink: View {
    @EnvironmentObject private var store: AppStore
    var body: some View {
        if let account = store.account, (try? FarmAPI.validatedBase(account.baseURL)) != nil,
           let url = BrowserHandoff.url(account: account, path: "/app/demo") {
            Link("Try the hackathon demo on the website", destination: url)
            Text("The website handles its own sign-in and demo choices. No private records or app credentials are transferred by opening this page.").font(.footnote).foregroundStyle(.secondary)
        }
    }
}

struct FocusedParcelLink: View {
    enum Destination: Equatable {
        case parcelCheck, correction
        var title: String { self == .parcelCheck ? "Check my parcels on the website" : "Work through this correction on the website" }
        var collection: String { self == .parcelCheck ? "farms" : "cases" }
        var kind: String { self == .parcelCheck ? "farms" : "admin_cases" }
        func path(_ id: String) -> String { self == .parcelCheck ? "/app/fields/\(id)/check" : "/app/cases/\(id)/correction" }
    }
    @EnvironmentObject private var store: AppStore
    @Environment(\.openURL) private var openURL
    let record: RecordItem
    let destination: Destination
    var contextLoaded = true
    @State private var problem: String?
    private var url: URL? {
        guard contextLoaded, store.sessionVerified, let account = store.account,
              record.kind == destination.kind, record.workspace_id == account.workspace.id,
              UUID(uuidString: record.id) != nil,
              store.record(destination.collection, record.id)?.revision == record.revision,
              destination != .correction || (record.value("job_type") == "correction" && UUID(uuidString: record.value("farm_id")) != nil),
              (try? FarmAPI.validatedBase(account.baseURL)) != nil else { return nil }
        return BrowserHandoff.url(account: account, path: destination.path(record.id))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button(destination.title) {
                guard let url else { problem = "Reload this farm or case and reconnect before opening its website workflow."; return }
                let scope = store.account?.scope
                openURL(url) { accepted in
                    guard scope == store.account?.scope else { return }
                    problem = accepted ? nil : "The browser could not open this workflow. Try again after checking your browser settings."
                }
            }.disabled(url == nil)
            Text("The website needs its own sign-in. Check the farm and workspace shown there. Opening this page does not confirm a change, send paperwork or transfer your app credential.").font(.footnote).foregroundStyle(.secondary)
            if let problem { Notice(problem, warning: true) }
        }.onChange(of: store.account?.scope) { _ in problem = nil }
    }
}
