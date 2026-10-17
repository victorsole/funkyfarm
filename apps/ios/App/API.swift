import Foundation

struct ServiceError: LocalizedError {
    let status: Int
    let message: String
    let code: String?
    let details: JSONValue?
    init(status: Int, message: String, code: String? = nil, details: JSONValue? = nil) { self.status = status; self.message = message; self.code = code; self.details = details }
    var errorDescription: String? { message }
}

struct FarmAPI {
    let baseURL: URL
    let token: String?
    let workspaceID: String?
    // Preserve established non-report response behavior; report JSON has its own bounded receiver.
    private static let transport: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 45
        return URLSession(configuration: configuration)
    }()
    init(baseURL: URL, token: String? = nil, workspaceID: String? = nil) {
        self.baseURL = baseURL; self.token = token; self.workspaceID = workspaceID
    }
    static func validatedBase(_ text: String) throws -> URL {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local"))) else {
            throw ServiceError(status: 0, message: "Use an HTTPS service, or HTTP localhost / a .local host for local development.")
        }
        return URL(string: url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")))!
    }
    func send(_ path: String, method: String = "GET", body: [String: JSONValue]? = nil, idempotency: String? = nil) async throws -> Data {
        var request = URLRequest(url: endpoint(ReportTransport.path(path, method: method)))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return try await perform(request, idempotency: idempotency)
    }
    func fileRequest(_ path: String) -> URLRequest {
        var request = URLRequest(url: endpoint(path))
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let workspaceID { request.setValue(workspaceID, forHTTPHeaderField: "X-Workspace-ID") }
        return request
    }
    func upload(_ edit: PendingEdit, bytes: Data) async throws -> Data {
        var fields: [String: String] = [:]
        if let farm = edit.farmID { fields["farm_id"] = farm }
        return try await multipart(path: "/documents", filename: edit.filename ?? "evidence", mime: edit.mimeType ?? "application/octet-stream", bytes: bytes, fields: fields, idempotency: edit.id.uuidString)
    }
    func multipart(path: String, filename: String, mime: String, bytes: Data, fields: [String: String], idempotency: String) async throws -> Data {
        let boundary = "farm-" + UUID().uuidString
        var request = URLRequest(url: endpoint(path)); request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }
        for key in fields.keys.sorted() {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(fields[key] ?? "")\r\n")
        }
        let safeName = filename.replacingOccurrences(of: "\"", with: "_").replacingOccurrences(of: "\r", with: "_").replacingOccurrences(of: "\n", with: "_")
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName)\"\r\nContent-Type: \(mime)\r\n\r\n")
        body.append(bytes); append("\r\n--\(boundary)--\r\n")
        request.httpBody = body
        return try await perform(request, idempotency: idempotency)
    }
    private func endpoint(_ path: String) -> URL {
        let suffix = path.hasPrefix("/") ? String(path.dropFirst()) : path
        // Paths are constructed by this app; identifiers are UUIDs from the service.
        return URL(string: baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + suffix)!
    }
    private func perform(_ original: URLRequest, idempotency: String?) async throws -> Data {
        var request = original
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let workspaceID { request.setValue(workspaceID, forHTTPHeaderField: "X-Workspace-ID") }
        if let idempotency { request.setValue(idempotency, forHTTPHeaderField: "Idempotency-Key") }
        let path = request.url?.path ?? ""
        let reportJSON = path.contains("/reports") && !path.hasSuffix("/download")
        let result: (Data, URLResponse)
        if reportJSON {
            let bounded = try await BoundedJSONTransfer(request: request, limit: ReportTransport.pageBytes).run()
            result = (bounded.0, bounded.1)
        } else { result = try await Self.transport.data(for: request) }
        let (bytes, response) = result
        guard let http = response as? HTTPURLResponse else { throw ServiceError(status: 0, message: "The service returned no HTTP response.") }
        guard (200..<300).contains(http.statusCode) else {
            let json = (try? JSONDecoder().decode(JSONValue.self, from: bytes))?.object ?? [:]
            let message = json["error"]?.object["message"]?.text ?? "Request failed (\(http.statusCode)). Try again or review the record."
            throw ServiceError(status: http.statusCode, message: message, code: json["error"]?.object["code"]?.text, details: json["error"]?.object["details"])
        }
        return bytes
    }
}
