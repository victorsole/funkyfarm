import SwiftUI

struct WorkspacePickerView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var workspaces: [[String: JSONValue]] = []
    @State private var invitation = ""
    @State private var selected: [String: JSONValue]?
    @State private var message: String?
    @State private var problem: String?
    @State private var working = false
    var body: some View {
        List {
            Section {
                Notice("Only workspaces returned for your signed-in account can be selected. Each workspace has a separate protected cache and draft queue. Switching keeps those drafts isolated; signing out erases this account's device data across its workspaces.")
                ForEach(Array(workspaces.enumerated()), id: \.offset) { _, workspace in
                    Button {
                        selected = workspace
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(workspace["name"]?.text ?? "Workspace").font(.headline)
                            Text(workspace["role"]?.text ?? "").font(.caption)
                            if workspace["farm_ids"] == .null { Text("Explicit whole-workspace access").font(.caption) }
                            else if let farms = workspace["farm_ids"]?.array { Text("Access to \(farms.count) selected farms").font(.caption) }
                            if workspace["id"]?.text == store.account?.workspace.id { Text("Currently selected").font(.caption.weight(.semibold)) }
                        }
                    }.disabled(working || workspace["id"]?.text == store.account?.workspace.id)
                }
            }
            Section("Accept a named invitation") {
                SecureField("Invitation code", text: $invitation).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Accept this invitation") {
                    working = true; problem = nil
                    Task {
                        do { let result = try await store.scopedValue("/invitations/accept", method: "POST", body: ["token": .string(invitation)]); invitation = ""; message = result.object["message"]?.text ?? "The service recorded the invitation acceptance. Choose the authorized workspace above."; await load() }
                        catch { problem = error.localizedDescription }
                        working = false
                    }
                }.disabled(invitation.isEmpty || working || !store.sessionVerified)
                Notice("The signed-in email must match the invitation. Accepting a grant does not merge it with your own workspace or transfer your records.")
            }
            if working { Section { ProgressView("Checking workspace access…") } }
            if let message { Section { Notice(message) } }
            if let problem { Section { Notice(problem, warning: true) } }
        }.navigationTitle("Workspaces").task { await load() }
            .confirmationDialog("Open the selected authorized workspace?", isPresented: Binding(get: { selected != nil }, set: { if !$0 { selected = nil } }), titleVisibility: .visible) {
                Button("Switch workspace") {
                    guard let selected else { return }; working = true
                    Task { do { try await store.selectWorkspace(selected); dismiss() } catch { problem = error.localizedDescription }; working = false }
                }
            }
    }
    private func load() async {
        working = true; defer { working = false }
        do { workspaces = try await store.scopedValue("/workspaces").object["items"]?.array.map(\.object) ?? [] }
        catch { problem = error.localizedDescription }
    }
}
