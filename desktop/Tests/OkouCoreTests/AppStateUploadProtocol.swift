import Foundation

/// An interrupted first PUT and the exact bytes seen by the retry, isolated per command.
final class AppStateUploadProtocol: URLProtocol, @unchecked Sendable {
  private final class Requests: @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [String: [Data]] = [:]

    func add(_ data: Data, for key: String) -> Int {
      lock.withLock {
        bodies[key, default: []].append(data)
        return bodies[key]?.count ?? 0
      }
    }

    func take(_ key: String) -> [Data] { lock.withLock { bodies.removeValue(forKey: key) ?? [] } }
  }

  private static let requests = Requests()
  static func takeBodies(for command: String) -> [Data] { requests.take(command) }
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func stopLoading() {}

  override func startLoading() {
    guard let url = request.url else { return }
    var body = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
      stream.open()
      defer { stream.close() }
      var buffer = [UInt8](repeating: 0, count: 4096)
      while true {
        let n = stream.read(&buffer, maxLength: buffer.count)
        guard n > 0 else { break }
        body.append(contentsOf: buffer.prefix(n))
      }
    }
    let isProbe = request.httpMethod == "GET"
    let attempt = isProbe ? 0 : Self.requests.add(body, for: url.lastPathComponent)
    if ["retry.runner.example", "receipt.runner.example"].contains(url.host), attempt == 1 {
      client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
      return
    }
    let authorized = request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture"
    let digest = request.value(forHTTPHeaderField: "x-okou-content-sha256") ?? ""
    let status = authorized && url.host != "retired.runner.example"
      ? (isProbe && url.host == "retry.runner.example" ? 204 : 200) : 403
    guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)
    else { return }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    let reply = url.host == "invalid.runner.example" ? digest + "x" : digest
    client?.urlProtocol(self, didLoad: Data(reply.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }
}
