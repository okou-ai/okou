import Foundation
import Synchronization

@testable import Okou

struct ChatHTTPResponse: Sendable {
  var status = 200
  var body: String
  var headers = ["Content-Type": "application/json", "X-Chat-Event-Schema-Version": "7"]
}

/// HTTP boundary fixture. Production decoding, pagination, and commands remain real.
final class ChatHTTPFixture: Sendable {
  typealias Handler = @Sendable (URLRequest) async throws -> ChatHTTPResponse
  let baseURL: URL
  let client: APIClient
  private let host: String
  private let session: URLSession

  init(handler: @escaping Handler) {
    let fixtureHost = UUID().uuidString.lowercased() + ".example.invalid"
    host = fixtureHost
    baseURL = URL(string: "https://" + fixtureHost)!
    ChatFixtureURLProtocol.handlers.withLock { $0[fixtureHost] = handler }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatFixtureURLProtocol.self]
    session = URLSession(configuration: configuration)
    client = APIClient(baseURL: baseURL, session: session) { "local-test-session" }
  }

  deinit {
    session.invalidateAndCancel()
    _ = ChatFixtureURLProtocol.handlers.withLock { $0.removeValue(forKey: host) }
  }
}

// URLProtocol's SDK conformance is unchecked; all mutable shared state is behind Mutex.
private final class ChatFixtureURLProtocol: URLProtocol, @unchecked Sendable {
  static let handlers = Mutex<[String: ChatHTTPFixture.Handler]>([:])
  private let loadingTask = Mutex<Task<Void, Never>?>(nil)

  override class func canInit(with request: URLRequest) -> Bool {
    handlers.withLock { $0[request.url?.host ?? ""] != nil }
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    let task = Task { @Sendable [self] in
      await deliverResponse()
    }
    loadingTask.withLock { $0 = task }
  }

  private func deliverResponse() async {
    do {
      guard let url = request.url,
        let handler = Self.handlers.withLock({ $0[url.host ?? ""] })
      else {
        throw URLError(.unsupportedURL)
      }
      let result = try await handler(request)
      try Task.checkCancellation()
      guard
        let response = HTTPURLResponse(
          url: url, statusCode: result.status, httpVersion: "HTTP/1.1", headerFields: result.headers
        )
      else {
        throw URLError(.badServerResponse)
      }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(result.body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    } catch is CancellationError {
    } catch {
      guard !Task.isCancelled else { return }
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {
    loadingTask.withLock { task in
      task?.cancel()
      task = nil
    }
  }
}

func chatRequestBody(_ request: URLRequest) -> Data {
  if let data = request.httpBody { return data }
  guard let stream = request.httpBodyStream else { return Data() }
  stream.open()
  defer { stream.close() }
  var result = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while stream.hasBytesAvailable {
    let count = stream.read(&buffer, maxLength: buffer.count)
    if count <= 0 { break }
    result.append(contentsOf: buffer.prefix(count))
  }
  return result
}
