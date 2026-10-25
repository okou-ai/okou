import Foundation
import Synchronization

public struct ChatHTTPResponse: Sendable {
  public var status = 200
  public var body: String
  public var headers = ["Content-Type": "application/json"]

  public init(
    status: Int = 200, body: String,
    headers: [String: String] = ["Content-Type": "application/json"]
  ) {
    self.status = status
    self.body = body
    self.headers = headers
  }
}

/// HTTP boundary fixture. Production decoding, pagination, and commands remain real.
public final class ChatHTTPFixture: Sendable {
  public typealias Handler = @Sendable (URLRequest) async throws -> ChatHTTPResponse
  public let baseURL: URL
  public let clientVersion: String
  public let session: URLSession

  public init(
    clientVersion: String = "1.2.3",
    onUnhandledRequest: @escaping @Sendable (String) -> Void, handler: @escaping Handler
  ) {
    self.clientVersion = clientVersion
    let fixtureHost = UUID().uuidString.lowercased() + ".example.invalid"
    baseURL = URL(string: "https://" + fixtureHost)!
    ChatFixtureURLProtocol.handlers.withLock {
      $0[fixtureHost] = ChatFixtureURLProtocol.Route(handler: handler, report: onUnhandledRequest)
    }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ChatFixtureURLProtocol.self]
    configuration.httpAdditionalHeaders = [ChatFixtureURLProtocol.ownerHeader: fixtureHost]
    session = URLSession(
      configuration: configuration,
      delegate: ChatFixtureSessionDelegate(host: fixtureHost), delegateQueue: nil)
  }

  deinit {
    session.invalidateAndCancel()
  }
}

private final class ChatFixtureSessionDelegate: NSObject, URLSessionDelegate {
  let host: String

  init(host: String) { self.host = host }

  func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
    // Cancellation is asynchronous. Keep this route until all session tasks have
    // finished so a retiring request cannot be reported to another fixture.
    _ = ChatFixtureURLProtocol.handlers.withLock { $0.removeValue(forKey: host) }
  }
}

// URLProtocol's SDK conformance is unchecked; all mutable shared state is behind Mutex.
private final class ChatFixtureURLProtocol: URLProtocol, @unchecked Sendable {
  struct Route: Sendable {
    let handler: ChatHTTPFixture.Handler
    let report: @Sendable (String) -> Void
  }
  static let ownerHeader = "X-Okou-Test-Fixture"
  static let handlers = Mutex<[String: Route]>([:])
  private let loadingTask = Mutex<Task<Void, Never>?>(nil)

  override class func canInit(with request: URLRequest) -> Bool {
    guard let url = request.url, let scheme = url.scheme, ["http", "https"].contains(scheme) else {
      return false
    }
    return !ChatFileHTTPServer.owns(url)
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    // The protocol task must retain its route even if session invalidation
    // finishes before this task observes cancellation.
    let owner = request.value(forHTTPHeaderField: Self.ownerHeader) ?? request.url?.host ?? ""
    let route = Self.handlers.withLock { $0[owner] }
    let task = Task { @Sendable [self] in
      await deliverResponse(owner: owner, route: route)
    }
    loadingTask.withLock { $0 = task }
  }

  private func deliverResponse(owner: String, route: Route?) async {
    guard !Task.isCancelled else { return }
    let description =
      "Unhandled fixture request: \(request.httpMethod ?? "GET") \(request.url?.absoluteString ?? "<missing URL>")"
    do {
      guard let url = request.url, let route, url.host == owner else {
        if let route {
          route.report(description + " [fixture owner \(owner); URL origin mismatch]")
        } else {
          for (registeredHost, registeredRoute) in Self.handlers.withLock({ Array($0) }) {
            registeredRoute.report(
              description
                + " [no live route for owner \(owner); reported to fixture \(registeredHost)]")
          }
        }
        throw URLError(.unsupportedURL, userInfo: [NSLocalizedDescriptionKey: description])
      }
      var forwarded = request
      forwarded.setValue(nil, forHTTPHeaderField: Self.ownerHeader)
      let result: ChatHTTPResponse
      do { result = try await route.handler(forwarded) } catch let error as URLError
        where error.code == .unsupportedURL
      {
        route.report(description + " [owned handler rejected request for fixture \(owner)]")
        throw error
      }
      try Task.checkCancellation()
      guard
        let response = HTTPURLResponse(
          url: url, statusCode: result.status,
          httpVersion: "HTTP/1.1", headerFields: result.headers)
      else { throw URLError(.badServerResponse) }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(result.body.utf8))
      client?.urlProtocolDidFinishLoading(self)
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

public func chatRequestBody(_ request: URLRequest) -> Data {
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

/// `/api/model-catalog` fixture with one retired model.
public func modelCatalogResponse() -> ChatHTTPResponse {
  let entries: [(model: String, displayName: String, replacedBy: String?)] = [
    ("okou-1.0", "Auto", nil),
    ("gpt-5.6-sol", "GPT-5.6 Sol", nil),
    ("claude-opus-5-5", "Claude Opus 5.5", nil),
    ("claude-opus-4-8", "Claude Opus 4.8", "claude-opus-5-5"),
  ]
  let models = entries.enumerated().map { index, entry -> String in
    let (model, displayName, replacedBy) = entry
    let replacement = replacedBy.map { "\"\($0)\"" } ?? "null"
    return """
      {"model":"\(model)","displayName":"\(displayName)","sortOrder":\(index),\
      "replacedBy":\(replacement),"resolvedModel":"\(replacedBy ?? model)"}
      """
  }
  return ChatHTTPResponse(
    body:
      "{\"systemDefaultModel\":\"okou-1.0\",\"models\":[\(models.joined(separator: ","))],\"routes\":[]}"
  )
}

/// A connected personal-subscription row in a `/api/run-models` response.
public struct SubscriptionRunModel {
  public let model: String
  public let providerType: String
  public var serviceTier: String?
  public var availability = "available"

  public init(
    model: String, providerType: String, serviceTier: String? = nil,
    availability: String = "available"
  ) {
    self.model = model
    self.providerType = providerType
    self.serviceTier = serviceTier
    self.availability = availability
  }
}

/// `/api/run-models` fixture: Auto plus the member's connected subscription rows.
public func runModelsResponse(_ subscriptions: [SubscriptionRunModel] = []) -> ChatHTTPResponse {
  let auto = """
    {"model":null,"modelLabel":"Auto","modelProviderId":null,\
    "memberEffective":{"providerType":"built-in","runtimeProviderType":"openrouter-codex",\
    "credentialScope":"org","availability":"available","accountSelection":"not_applicable"}}
    """
  let rows = subscriptions.map { row -> String in
    let tier = row.serviceTier.map { "\"\($0)\"" } ?? "null"
    return """
      {"model":"\(row.model)","modelLabel":"\(row.model)","modelProviderId":null,\
      "memberEffective":{"providerType":"\(row.providerType)","runtimeProviderType":"\(row.providerType)",\
      "credentialScope":"member","availability":"\(row.availability)","accountSelection":"capture_required"},\
      "subscriptionOptions":{"efforts":["low","medium","high"],"serviceTier":\(tier)}}
      """
  }
  return ChatHTTPResponse(
    body:
      "{\"models\":[\(([auto] + rows).joined(separator: ","))]}"
  )
}
