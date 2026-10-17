import Foundation

/// Stops receipt at the response budget, rather than buffering an oversized reply first.
final class BoundedJSONTransfer: NSObject, URLSessionDataDelegate {
    private let request: URLRequest
    private let limit: Int
    private let lock = NSLock()
    private var bytes = Data()
    private var response: HTTPURLResponse?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?
    private var finished = false
    init(request: URLRequest, limit: Int) { self.request = request; self.limit = limit; super.init() }
    func run() async throws -> (Data, HTTPURLResponse) {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>) in
                lock.lock()
                guard !finished else { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                let configuration = URLSessionConfiguration.ephemeral
                configuration.urlCache = nil; configuration.httpShouldSetCookies = false
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.timeoutIntervalForRequest = 45; configuration.timeoutIntervalForResource = 120
                let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
                self.session = session; let task = session.dataTask(with: request); self.task = task
                lock.unlock(); task.resume()
            }
        }, onCancel: { self.finish(CancellationError()) })
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else { completionHandler(.cancel); finish(ServiceError(status: 0, message: "The service returned no HTTP response.")); return }
        lock.lock()
        guard !finished else { lock.unlock(); completionHandler(.cancel); return }
        guard response.expectedContentLength <= Int64(limit) else { lock.unlock(); completionHandler(.cancel); finish(oversize()); return }
        self.response = response; lock.unlock(); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        guard data.count <= limit - bytes.count else { lock.unlock(); finish(oversize()); return }
        bytes.append(data); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) { finish(error) }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); finish(ServiceError(status: 0, message: "The service redirected this authenticated request. Reopen the selected service; no credentials were forwarded."))
    }
    private func oversize() -> ServiceError { ServiceError(status: 0, message: "The service response exceeded the bounded page budget. No partial review was accepted.") }
    private func finish(_ error: Error?) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        let continuation = self.continuation, session = self.session, task = self.task
        let response = self.response, bytes = self.bytes
        self.continuation = nil; self.session = nil; self.task = nil; self.bytes = Data()
        lock.unlock()
        if let error { task?.cancel(); session?.invalidateAndCancel(); continuation?.resume(throwing: error) }
        else if let response { session?.finishTasksAndInvalidate(); continuation?.resume(returning: (bytes, response)) }
        else { session?.invalidateAndCancel(); continuation?.resume(throwing: ServiceError(status: 0, message: "The service did not return a complete response.")) }
    }
}
