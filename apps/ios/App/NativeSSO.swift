import SwiftUI
import AuthenticationServices
import CryptoKit
import Security
import UIKit

struct NativeSSOProvider: Decodable, Identifiable, Equatable {
    let id: String
    let name: String
    let allow_local_development: Bool
    let native_start_path: String
}

private struct NativeSSOCatalogue: Decodable {
    let providers: [NativeSSOProvider]
    let native_redirect_uris: [String]
}

@MainActor final class NativeSSOSignIn: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    static let redirectURI = "funkyfarmapp://auth/sso"
    private static let callbackScheme = "funkyfarmapp"
    enum Phase: Equatable { case idle, browser, exchange }
    @Published private(set) var providers: [NativeSSOProvider] = []
    @Published private(set) var loading = false
    @Published private(set) var phase = Phase.idle
    @Published private(set) var problem: String?
    @Published private(set) var notice: String?
    weak var presentationWindow: UIWindow?
    var isActive: Bool { phase != .idle }
    private struct Attempt {
        let id = UUID()
        let base: String
        let state: String
        let verifier: String
    }
    private var attempt: Attempt?
    private var session: ASWebAuthenticationSession?
    private var activeAnchor: ASPresentationAnchor?
    private var catalogueRequest = UUID()
    private var catalogueBase: String?

    func loadProviders(base: String) async {
        guard !isActive else { return }
        let requestID = UUID(); catalogueRequest = requestID
        providers = []; catalogueBase = nil; loading = true; problem = nil; notice = nil
        defer { if catalogueRequest == requestID { loading = false } }
        do {
            let url = try FarmAPI.validatedBase(base)
            let bytes = try await FarmAPI(baseURL: url).send("/auth/sso/providers")
            let catalogue = try JSONDecoder().decode(NativeSSOCatalogue.self, from: bytes)
            try Task.checkCancellation()
            guard catalogueRequest == requestID else { return }
            guard catalogue.native_redirect_uris.contains(Self.redirectURI) else { throw ServiceError(status: 0, message: "This service has not enabled the app's native callback. Password sign-in remains available.") }
            let valid = catalogue.providers.filter { provider in
                !provider.id.isEmpty && provider.id.count <= 80 && provider.id.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
                && !provider.name.isEmpty && provider.native_start_path == "/api/v1/auth/sso/\(provider.id)/native/start"
            }
            var seen = Set<String>()
            providers = valid.filter { seen.insert($0.id).inserted }; catalogueBase = url.absoluteString
            if providers.isEmpty { notice = "No native SSO provider is configured on this service. You can still use password sign-in." }
        } catch is CancellationError { /* A changed service address invalidates the earlier catalogue. */ }
        catch { if catalogueRequest == requestID { problem = "SSO options could not be loaded. \(error.localizedDescription)" } }
    }

    func begin(provider: NativeSSOProvider, base: String, store: AppStore) {
        guard !isActive, !loading else { return }
        problem = nil; notice = nil
        do {
            let url = try FarmAPI.validatedBase(base)
            guard catalogueBase == url.absoluteString, providers.contains(provider), store.account == nil else { throw ServiceError(status: 0, message: "Reload the configured sign-in options for this service before continuing.") }
            guard let window = presentationWindow, window.windowScene?.activationState == .foregroundActive else { throw ServiceError(status: 0, message: "The sign-in window is not ready. Try the provider button again.") }
            let value = Attempt(base: url.absoluteString, state: try Self.randomValue(bytes: 32), verifier: try Self.randomValue(bytes: 48))
            let challenge = Self.base64URL(Data(SHA256.hash(data: Data(value.verifier.utf8))))
            guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw ServiceError(status: 0, message: "The service address cannot start native sign-in.") }
            components.path = provider.native_start_path; components.fragment = nil
            components.queryItems = [URLQueryItem(name: "redirect_uri", value: Self.redirectURI), URLQueryItem(name: "state", value: value.state), URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256")]
            guard let start = components.url else { throw ServiceError(status: 0, message: "The native sign-in request could not be prepared.") }
            attempt = value; activeAnchor = window; phase = .browser
            let browser = ASWebAuthenticationSession(url: start, callbackURLScheme: Self.callbackScheme) { [weak self] callback, error in
                Task { @MainActor [weak self] in await self?.complete(id: value.id, callback: callback, browserError: error, store: store) }
            }
            browser.presentationContextProvider = self
            session = browser
            guard browser.start() else { clearAttempt(); throw ServiceError(status: 0, message: "The system sign-in browser could not be opened. No app session was stored.") }
        } catch { clearAttempt(); problem = error.localizedDescription }
    }

    func cancelBrowser() {
        guard phase == .browser else { return }
        let browser = session
        clearAttempt(); browser?.cancel()
        notice = "Sign-in cancelled. No new app session was stored."
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        // begin() requires and retains this app scene's foreground window.
        activeAnchor ?? ASPresentationAnchor()
    }

    private func complete(id: UUID, callback: URL?, browserError: Error?, store: AppStore) async {
        guard let value = attempt, value.id == id, phase == .browser else { return }
        session = nil
        if let error = browserError as? ASWebAuthenticationSessionError, error.code == .canceledLogin { clearAttempt(); notice = "Sign-in cancelled. No new app session was stored."; return }
        guard browserError == nil, let callback else { clearAttempt(); problem = "The system browser did not return a valid sign-in response. Start again or use password sign-in."; return }
        do {
            let code = try Self.callbackCode(callback, expectedState: value.state)
            phase = .exchange
            try await store.authenticateSSO(base: value.base, code: code, verifier: value.verifier, redirectURI: Self.redirectURI)
            guard attempt?.id == id else { return }
            clearAttempt(); notice = "Signed in to the service."
        } catch {
            guard attempt?.id == id else { return }
            clearAttempt()
            if error is CancellationError { notice = "Sign-in was superseded. No replacement session was installed." }
            else { problem = error.localizedDescription }
        }
    }

    private func clearAttempt() { attempt = nil; session = nil; activeAnchor = nil; phase = .idle }
    private static func randomValue(bytes count: Int) throws -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw ServiceError(status: 0, message: "Secure sign-in randomness is unavailable. Try again; no request was sent.") }
        return base64URL(Data(bytes))
    }
    private static func base64URL(_ bytes: Data) -> String { bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    private static func callbackCode(_ callback: URL, expectedState: String) throws -> String {
        let invalid = ServiceError(status: 0, message: "The sign-in callback did not match this active request. No code was exchanged. Start sign-in again.")
        guard let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false), parts.scheme == callbackScheme, parts.host == "auth", parts.port == nil, parts.user == nil, parts.password == nil, parts.path == "/sso", parts.fragment == nil else { throw invalid }
        let query = parts.queryItems ?? []
        guard query.allSatisfy({ ["state", "code", "error"].contains($0.name) }), query.filter({ $0.name == "state" }).count == 1, query.first(where: { $0.name == "state" })?.value == expectedState else { throw invalid }
        let codes = query.filter { $0.name == "code" }, errors = query.filter { $0.name == "error" }
        if errors.count == 1, codes.isEmpty {
            let message: String
            switch errors[0].value {
            case "access_denied": message = "Provider sign-in was cancelled or declined. No new app session was stored."
            case "account_link_required": message = "Sign in to your existing account first, then use its explicit provider-linking controls. This sign-in has not merged or linked accounts."
            case "link_conflict": message = "This provider identity could not be linked to this account. Use the original account or ask your service administrator; no accounts have been merged."
            case "session_changed": message = "The browser session changed during sign-in. Start a new sign-in request."
            case "invalid_state": message = "The provider request expired or could not be verified. Start sign-in again."
            case "invalid_identity": message = "The service could not verify the identity returned by this provider. Use password sign-in or contact your service administrator."
            case "provider_unavailable": message = "The configured provider is unavailable. Try again later or use password sign-in."
            default: message = "The identity provider did not complete a valid sign-in. Start again or use password sign-in."
            }
            throw ServiceError(status: 0, message: message)
        }
        guard errors.isEmpty, codes.count == 1, let code = codes[0].value, (32...128).contains(code.count) else { throw invalid }
        return code
    }
}

struct NativeSSOSection: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject var signIn: NativeSSOSignIn
    let base: String
    let passwordBusy: Bool
    var body: some View {
        Section("Sign in with your organization") {
            ForEach(signIn.providers) { provider in
                Button("Continue with \(provider.name)") { signIn.begin(provider: provider, base: base, store: store) }.disabled(passwordBusy || store.busy || signIn.isActive || signIn.loading)
                if provider.allow_local_development { Text("This provider permits a local-development configuration. Use the configured trusted service and check the browser address before signing in.").font(.footnote).foregroundStyle(.secondary) }
            }
            if signIn.loading { ProgressView("Checking configured providers…") }
            if signIn.phase == .browser { Text("Complete sign-in in the system browser."); Button("Cancel organization sign-in", role: .cancel) { signIn.cancelBrowser() } }
            if signIn.phase == .exchange { ProgressView("Exchanging the one-time sign-in handoff…"); Text("The app stores only the farm service's session, not your identity-provider password or tokens.").font(.footnote) }
            if !signIn.isActive { Button("Refresh organization sign-in options") { Task { await signIn.loadProviders(base: base) } }.disabled(passwordBusy || signIn.loading || store.busy) }
            if let notice = signIn.notice { Notice(notice) }
            if let problem = signIn.problem { Notice(problem, warning: true) }
            Text("Only providers configured by this service appear here. Sign-in does not link another existing account or grant new farm permissions automatically.").font(.footnote).foregroundStyle(.secondary)
        }.task(id: base) { await signIn.loadProviders(base: base) }
    }
}

struct SSOPresentationWindowReader: UIViewRepresentable {
    let receive: (UIWindow?) -> Void
    final class Probe: UIView {
        var receive: ((UIWindow?) -> Void)?
        override func didMoveToWindow() { super.didMoveToWindow(); receive?(window) }
    }
    func makeUIView(context: Context) -> Probe { let view = Probe(); view.receive = receive; view.isUserInteractionEnabled = false; view.accessibilityElementsHidden = true; return view }
    func updateUIView(_ uiView: Probe, context: Context) { uiView.receive = receive }
}
