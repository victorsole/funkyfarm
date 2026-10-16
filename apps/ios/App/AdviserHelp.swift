import SwiftUI
import UIKit

struct AdviserHelpView: View {
    @EnvironmentObject private var store: AppStore
    @State private var advisers: [[String: JSONValue]] = []
    @State private var invitations: [RecordItem] = []
    @State private var email = ""
    @State private var farm = ""
    @State private var wholeWorkspace = false
    @State private var canReview = false
    @State private var expires = 7
    @State private var token: String?
    @State private var working = false
    @State private var problem: String?
    @State private var invite = false
    @State private var revoke: RecordItem?
    @State private var invitationKey = UUID()
    var body: some View {
        List {
            Section("Choose help without publishing farm data") {
                Notice("Adviser discovery and qualification claims do not grant access. Invite a named person only after you choose the farm scope and permissions. A software invitation is not a government mandate.")
            }
            Section("Invite someone you know") {
                if store.account?.workspace.role == "owner" {
                    TextField("Adviser's email", text: $email).textContentType(.emailAddress).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Toggle("Grant the whole workspace", isOn: $wholeWorkspace)
                    if !wholeWorkspace { FarmPicker(selected: $farm) }
                    Toggle("Allow review, as well as reading", isOn: $canReview)
                    Stepper("Invitation expires in \(expires) days", value: $expires, in: 1...30)
                    Button("Review invitation") { invite = true }.buttonStyle(.borderedProminent).disabled(working || !store.sessionVerified || email.isEmpty || (!wholeWorkspace && farm.isEmpty))
                } else { Text("Only the workspace owner can create or revoke an invitation.").foregroundStyle(.secondary) }
                if let token {
                    Notice("Invitation created. Send this code to the named recipient yourself. The application has not sent an email. The code is shown only in this view.")
                    Text(token).font(.callout.monospaced()).textSelection(.enabled).privacySensitive()
                    Button("Copy invitation code") { UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: token]], options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(300)]) }
                    Button("Hide invitation code") { self.token = nil }
                }
            }
            Section("Current invitations") {
                ForEach(invitations) { invitation in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(invitation.value("email")).font(.headline)
                        Text(invitation.state).font(.caption)
                        DisclosureGroup("Farm scope and permissions") { JSONFields(data: invitation.data.filter { $0.key != "token" && $0.key != "token_hash" }) }
                        if store.account?.workspace.role == "owner", !["revoked", "expired"].contains(invitation.state) { Button("Revoke invitation", role: .destructive) { revoke = invitation }.disabled(working) }
                    }
                }
            }
            Section("Deliberately published adviser profiles") {
                if advisers.isEmpty { Text("No published profiles are loaded. You can still invite an adviser you know by email.").foregroundStyle(.secondary) }
                ForEach(Array(advisers.enumerated()), id: \.offset) { _, adviser in
                    let data = adviser["data"]?.object ?? adviser
                    DisclosureGroup(data["display_name"]?.text ?? "Published adviser profile") {
                        if let bio = data["bio"] { Text(bio.text) }
                        LabeledContent("Qualification review", value: data["qualification_status"]?.text ?? "Not verified")
                        if let claim = data["qualification_claim"] { Text(claim.text).font(.callout) }
                        if let countries = data["countries"] { LabeledContent("Published countries", value: countries.text) }
                        if let languages = data["languages"] { LabeledContent("Published languages", value: languages.text) }
                        Notice("A published profile is separate from a verified qualification and from permission to read your records.")
                    }
                }
            }
            if working { Section { ProgressView("Waiting for adviser service…") } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Adviser help").task { await load() }.refreshable { await load() }
            .confirmationDialog("Invite \(email) with \(canReview ? "read and review" : "read-only") access to \(wholeWorkspace ? "the whole workspace" : "the selected farm") for \(expires) days?", isPresented: $invite, titleVisibility: .visible) {
                Button("Create scoped invitation") { create() }
            }
            .confirmationDialog("Revoke this invitation and its granted access?", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } }), titleVisibility: .visible) {
                Button("Revoke access", role: .destructive) {
                    guard let invitation = revoke else { return }; working = true
                    Task { do { _ = try await store.scopedValue("/invitations/\(invitation.id)/revoke", method: "POST", body: [:]); revoke = nil; await load() } catch { problem = error.localizedDescription }; working = false }
                }
            }
            .onChange(of: email) { _ in invitationKey = UUID() }
            .onChange(of: farm) { _ in invitationKey = UUID() }
            .onChange(of: wholeWorkspace) { _ in invitationKey = UUID() }
            .onChange(of: canReview) { _ in invitationKey = UUID() }
            .onChange(of: expires) { _ in invitationKey = UUID() }
    }
    private func load() async {
        working = true; problem = nil; defer { working = false }
        do {
            let directory = try await store.scopedValue("/advisers").object
            advisers = directory["items"]?.array.map(\.object) ?? []
            if store.account?.workspace.role == "owner" { let page = try await store.scopedValue("/invitations"); invitations = try JSONDecoder().decode([RecordItem].self, from: JSONEncoder().encode(page.object["items"] ?? .array([]))) }
        } catch { problem = error.localizedDescription }
    }
    private func create() {
        working = true; problem = nil; token = nil
        Task {
            do {
                let result = try await store.scopedValue("/invitations", method: "POST", body: ["email": .string(email), "role": .string("adviser"), "farm_ids": wholeWorkspace ? .null : .array([.string(farm)]), "permissions": .array((canReview ? ["read", "review"] : ["read"]).map(JSONValue.string)), "expires_in_days": .number(Double(expires))], idempotency: invitationKey.uuidString)
                token = result.object["token"]?.text
                if token == nil { problem = "The service returned no invitation code. Review the invitation list before trying again." }
                await load()
            } catch { problem = error.localizedDescription }
            working = false
        }
    }
}
