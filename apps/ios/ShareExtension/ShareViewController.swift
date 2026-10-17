import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let message = UILabel()
    private let saveButton = UIButton(type: .system)
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        message.text = "Save a private copy for review in funkyfarm. No account is selected and nothing is uploaded here. Open the app afterward to assign each file to a farm."
        message.numberOfLines = 0; message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        saveButton.setTitle("Save for review", for: .normal)
        saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
        let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal)
        cancel.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [message, saveButton, cancel]); stack.axis = .vertical; stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)])
    }
    @objc private func close() { extensionContext?.completeRequest(returningItems: nil) }
    @objc private func save() {
        saveButton.isEnabled = false
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        Task { @MainActor in
            do {
                guard !providers.isEmpty, providers.count <= 10 else { throw NSError(domain: "Intake", code: 4, userInfo: [NSLocalizedDescriptionKey: "Choose between one and ten files."]) }
                for provider in providers {
                    guard let identifier = provider.registeredTypeIdentifiers.first(where: { identifier in
                        guard let type = UTType(identifier) else { return false }
                        return IntakeInbox.documentType(type) != nil
                    }), let type = UTType(identifier) else { throw NSError(domain: "Intake", code: 5, userInfo: [NSLocalizedDescriptionKey: "Share PDF, PNG, JPEG or UTF-8 plain text. Bring CSV files through Import records in the app."]) }
                    let bytes: Data = try await withCheckedThrowingContinuation { continuation in
                        provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, error in
                            if let error { continuation.resume(throwing: error); return }
                            do {
                                guard let url else { throw CocoaError(.fileReadUnknown) }
                                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                                guard size <= IntakeInbox.maximumDocumentBytes else { throw NSError(domain: "Intake", code: 2, userInfo: [NSLocalizedDescriptionKey: "Choose a document no larger than 12 MiB."]) }
                                continuation.resume(returning: try Data(contentsOf: url))
                            } catch { continuation.resume(throwing: error) }
                        }
                    }
                    try IntakeInbox.save(bytes: bytes, filename: provider.suggestedName ?? "Shared evidence.\(type.preferredFilenameExtension ?? "bin")", type: type)
                }
                message.text = "Saved on this device. Open funkyfarm and review Shared intake under Documents. No upload has been made."
                saveButton.setTitle("Done", for: .normal); saveButton.removeTarget(self, action: #selector(save), for: .touchUpInside)
                saveButton.addTarget(self, action: #selector(close), for: .touchUpInside); saveButton.isEnabled = true
            } catch {
                message.text = error.localizedDescription + " Any files already saved remain available for review."
                saveButton.isHidden = true
            }
        }
    }
}
