import SwiftUI

struct OutboxView: View {
    @EnvironmentObject private var store: AppStore
    @State private var error: String?
    var body: some View {
        List {
            Section {
                Notice("Drafts and originals are protected on this device and bound to this account. Sync uses a stable retry key. A revision conflict remains here until you compare and resolve it.")
                Button("Sync saved drafts") { Task { await store.sync() } }.buttonStyle(.borderedProminent).disabled(store.syncing || !store.sessionVerified || store.disk.queue.isEmpty)
                if store.syncing { ProgressView("Syncing saved drafts…") }
                if !store.sessionVerified { Button("Reconnect account") { Task { await store.verifyAndRefresh() } } }
                if let error { Notice(error, warning: true) }
            }
            Section("Device outbox") {
                if store.disk.queue.isEmpty { Text("No pending drafts. Successful uploads and edits are removed from this queue after the service acknowledges them.").foregroundStyle(.secondary) }
                ForEach(store.disk.queue) { edit in NavigationLink { PendingEditView(editID: edit.id) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(edit.label).font(.headline)
                        Text(label(edit.state)).font(.subheadline)
                        if let problem = edit.problem { Text(problem).font(.caption).foregroundStyle(.secondary) }
                        Text(edit.createdAt.formatted(date: .abbreviated, time: .shortened)).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                } }
            }
        }.navigationTitle("Device drafts")
    }
    private func label(_ state: QueueState) -> String {
        switch state {
        case .pending: return "Saved on device · waiting to sync"
        case .sending: return "Syncing · awaiting service acknowledgement"
        case .failed: return "Sync failed · draft retained"
        case .conflict: return "Conflict · review both revisions"
        case .review: return "Saved on device · checks and review needed"
        }
    }
}

struct PendingEditView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let editID: UUID
    @State private var latest: RecordItem?
    @State private var error: String?
    @State private var discard = false
    @State private var resolve = false
    @State private var source: ExportFile?
    private var edit: PendingEdit? { store.disk.queue.first { $0.id == editID } }
    var body: some View {
        List {
            if let edit {
                Section {
                    Text(edit.label).font(.title2.bold())
                    LabeledContent("Device state", value: edit.state.rawValue.capitalized)
                    if let problem = edit.problem { Notice(problem, warning: true) }
                    if let attachment = edit.attachment {
                        Text("Original file is retained privately until acknowledgement or explicit removal.")
                        Button("Review saved attachment") {
                            do { source = try store.localAttachment(attachment) } catch { self.error = error.localizedDescription }
                        }
                    }
                    if !edit.payload.isEmpty { DisclosureGroup("Your saved values") { JSONFields(data: edit.payload) } }
                    if edit.path == "/workflow/capture" {
                        if edit.reviewContext?["type"] == .string("compliance_profile"), let farmID = edit.payload["data"]?.object["farm_id"]?.text, let question = edit.reviewContext?["question"]?.object {
                            NavigationLink("Review the saved farm profile answer") { ComplianceProfileQuestionView(farmID: farmID, question: question, ruleVersion: edit.reviewContext?["rules_version"]?.text ?? "", deviceDraft: edit) }
                        } else { NavigationLink("Open record and review its checks") { WorkCaptureView(deviceDraft: edit) } }
                    }
                    if edit.path == "/workflow/answer", let requestID = edit.payload["request_id"]?.text {
                        NavigationLink("Open saved answer and review") { GuidedRequestView(requestID: requestID, deviceDraft: edit) }
                    }
                    if edit.path == "/regulatory/preferences", let farmID = edit.payload["farm_id"]?.text {
                        NavigationLink("Compare source-update preferences") { RegulatoryUpdatesView(initialFarmID: farmID, deviceDraft: edit) }
                    }
                }
                if edit.state == .conflict && !edit.path.hasPrefix("/workflow/") && edit.path != "/regulatory/preferences" {
                    Section("Compare before resolving") {
                        Notice("Another device changed this record. Your draft has not overwritten it.", warning: true)
                        Button("Load current server revision") {
                            let parts = edit.path.split(separator: "/")
                            guard parts.count >= 2 else { error = "This operation cannot be rebased. Keep or remove the draft and review its source."; return }
                            Task {
                                do { latest = try await store.refreshDetail(String(parts[0]), String(parts[1])) }
                                catch { self.error = error.localizedDescription }
                            }
                        }.disabled(!store.sessionVerified || store.syncing)
                        if let latest {
                            LabeledContent("Current revision", value: "\(latest.revision)")
                            JSONFields(data: latest.data)
                            Button("Use my reviewed values as a new edit") { resolve = true }.disabled(store.syncing || edit.method != "PATCH")
                            Notice("This action keeps your draft values, uses the revision shown above, and creates a new retry key. Another change will produce another conflict. For a partial merge, record the values, remove this draft and edit the current record.")
                        }
                    }
                }
                Section {
                    if edit.state != .conflict && edit.state != .review { Button("Retry synchronization") { Task { await store.sync() } }.disabled(store.syncing || !store.sessionVerified) }
                    Button("Remove device draft", role: .destructive) { discard = true }.disabled(store.syncing)
                }
            } else { Text("The draft has been synchronized or removed.") }
            if let error { Section { Notice(error, warning: true) } }
        }.navigationTitle("Saved draft")
            .confirmationDialog("Remove this local draft and its private attachment?", isPresented: $discard, titleVisibility: .visible) {
                Button("Remove draft", role: .destructive) { do { if let edit { try store.discard(edit) }; dismiss() } catch { self.error = error.localizedDescription } }
            }
            .confirmationDialog("Replace the compared server values with your reviewed draft on the next sync?", isPresented: $resolve, titleVisibility: .visible) {
                Button("Queue reviewed edit") { do { if let edit, let latest { try store.resolve(edit, against: latest); self.latest = nil } } catch { self.error = error.localizedDescription } }
            }
            .sheet(item: $source) { file in QuickLookEvidence(url: file.url) }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var labels: NativeLabels
    @Environment(\.dismiss) private var dismiss
    @State private var signOut = false
    var body: some View {
        List {
            Section("Private account") {
                Text(store.account?.user.display_name ?? "")
                Text(store.account?.user.email ?? "").foregroundStyle(.secondary)
                LabeledContent("Workspace", value: store.account?.workspace.name ?? "")
                LabeledContent("Role", value: store.account?.workspace.role ?? "")
                NavigationLink("Choose an authorized workspace") { WorkspacePickerView() }
                NavigationLink(labels.text("common.language", fallback: "Language")) { LanguageSettingsView() }
                Text(store.account?.baseURL ?? "").font(.caption).textSelection(.enabled)
                Button("Refresh session and records") { Task { await store.verifyAndRefresh() } }.disabled(store.busy || store.syncing)
            }
            Section("This device") {
                NavigationLink { OutboxView() } label: { Label("Device drafts (\(store.disk.queue.count))", systemImage: "internaldrive") }
                NavigationLink { SharedIntakeView() } label: { Label("Shared intake", systemImage: "square.and.arrow.down") }
                Text("Sessions use the iOS Keychain. Cached records, drafts and files use complete file protection and are excluded from backups. Signing out purges this account's local files and unassigned shared intake. Synchronize anything you need to keep first.").font(.footnote)
                Button("Sign out and erase device drafts", role: .destructive) { signOut = true }.disabled(store.busy || store.syncing)
            }
            Section("About review and privacy") {
                NavigationLink("Help and assistant connections") { FarmerHelpView() }
                Notice("Sources and uncertainty stay visible. Proposed extraction is never automatically confirmed. Reports retain the reviewed snapshot; a later correction creates a separate reissue.")
                Text("Use the system's text size, VoiceOver and Reduce Motion settings. Camera scans and shared documents require your review before upload.").font(.footnote)
                Text("An export leaves this application only when you choose a destination in the iOS share sheet.").font(.footnote)
            }
            if let error = store.error { Section { Notice(error, warning: true) } }
        }.navigationTitle("Account and device").toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Sign out and erase this account's saved drafts, attachments, cached records and shared intake from this device?", isPresented: $signOut, titleVisibility: .visible) {
                Button("Sign out and erase local data", role: .destructive) { Task { await store.signOut(); dismiss() } }
            }
    }
}
