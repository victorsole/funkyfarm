import Foundation

/// A serial, file-backed transfer: only the current URLSession chunk is held in memory.
final class ProtectedFileTransfer: NSObject, URLSessionDataDelegate {
    static let maximumBytes: Int64 = 512 * 1024 * 1024
    static let reservedFreeBytes: Int64 = 64 * 1024 * 1024
    private let destination: URL
    private let request: URLRequest
    private let lock = NSLock()
    private var handle: FileHandle?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var continuation: CheckedContinuation<Void, Error>?
    private var finished = false
    private var received: Int64 = 0
    private var expected: Int64?
    private let budget: Int64

    init(request: URLRequest, destination: URL) throws {
        self.request = request; self.destination = destination
        let free = try Self.freeBytes(destination.deletingLastPathComponent())
        guard free > Self.reservedFreeBytes else { throw ServiceError(status: 0, message: "Free some device storage before exporting. The app keeps a 64 MiB free-space reserve.") }
        budget = min(Self.maximumBytes, free - Self.reservedFreeBytes)
        super.init()
        guard FileManager.default.createFile(atPath: destination.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else { throw ServiceError(status: 0, message: "The protected export file could not be created.") }
        do { handle = try FileHandle(forWritingTo: destination); var file = destination; var resource = URLResourceValues(); resource.isExcludedFromBackup = true; try file.setResourceValues(resource) }
        catch { try? handle?.close(); try? FileManager.default.removeItem(at: destination); throw error }
    }

    func run() async throws {
        try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                guard !finished else { lock.unlock(); continuation.resume(throwing: CancellationError()); return }
                self.continuation = continuation
                let configuration = URLSessionConfiguration.ephemeral
                configuration.urlCache = nil; configuration.httpShouldSetCookies = false
                configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
                configuration.timeoutIntervalForRequest = 60; configuration.timeoutIntervalForResource = 600
                let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
                self.session = session
                let task = session.dataTask(with: request); self.task = task
                lock.unlock(); task.resume()
            }
        }, onCancel: { self.cancel() })
    }

    func cancel() { finish(CancellationError()) }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, Self.sameOrigin(request.url, response.url) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            completionHandler(.cancel); finish(ServiceError(status: status, message: "The authorized file download failed (\(status)). No export is available to share.")); return
        }
        lock.lock()
        guard !finished else { lock.unlock(); completionHandler(.cancel); return }
        guard response.expectedContentLength <= budget else { lock.unlock(); completionHandler(.cancel); finish(ServiceError(status: 0, message: "This export exceeds the available private download budget (up to 512 MiB). No partial file will be shared.")); return }
        if response.expectedContentLength >= 0, response.value(forHTTPHeaderField: "Content-Encoding") == nil || response.value(forHTTPHeaderField: "Content-Encoding") == "identity" { expected = response.expectedContentLength }
        lock.unlock(); completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard !finished, let handle else { lock.unlock(); return }
        do {
            guard Int64(data.count) <= budget - received else { throw ServiceError(status: 0, message: "The export exceeded the protected file budget. No partial file will be shared.") }
            let free = try Self.freeBytes(destination.deletingLastPathComponent())
            guard free - Int64(data.count) >= Self.reservedFreeBytes else { throw ServiceError(status: 0, message: "Device storage became low. The incomplete export was removed.") }
            try handle.write(contentsOf: data); received += Int64(data.count)
            lock.unlock()
        } catch { lock.unlock(); finish(error) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); let incomplete = expected.map { $0 != received } ?? false; lock.unlock()
        if let error { finish(error) }
        else if incomplete { finish(ServiceError(status: 0, message: "The export ended before the complete file arrived. The partial file was removed.")) }
        else { finish(nil) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
        finish(ServiceError(status: 0, message: "The file request redirected. No credentials were forwarded and no partial file will be shared. Reload the report from the selected service."))
    }

    private func finish(_ failure: Error?) {
        lock.lock()
        guard !finished else { lock.unlock(); return }
        finished = true
        var result = failure
        do { try handle?.close() } catch { if result == nil { result = error } }
        handle = nil
        if result != nil { try? FileManager.default.removeItem(at: destination) }
        let continuation = self.continuation, task = self.task, session = self.session
        self.continuation = nil; self.task = nil; self.session = nil
        lock.unlock()
        if result != nil { task?.cancel(); session?.invalidateAndCancel() } else { session?.finishTasksAndInvalidate() }
        if let result { continuation?.resume(throwing: result) } else { continuation?.resume(returning: ()) }
    }
    private static func freeBytes(_ directory: URL) throws -> Int64 {
        guard let size = try FileManager.default.attributesOfFileSystem(forPath: directory.path)[.systemFreeSize] as? NSNumber else { throw ServiceError(status: 0, message: "Available storage could not be checked. No export was started.") }
        return size.int64Value
    }
    private static func sameOrigin(_ first: URL?, _ second: URL?) -> Bool { guard let first, let second, second.user == nil, second.password == nil else { return false }; return first.scheme == second.scheme && first.host == second.host && first.port == second.port }
}
