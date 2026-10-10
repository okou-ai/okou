import Foundation

public struct APIResponse: Sendable {
  public let status: Int
  /// Raw response bytes, decoded on demand into generated contract types.
  public let data: Data
  /// Dynamic view of the body for payloads the app relays without reading them.
  public let body: JSONValue
  public let retryAfter: TimeInterval?

  public init(status: Int, data: Data, body: JSONValue, retryAfter: TimeInterval?) {
    self.status = status
    self.data = data
    self.body = body
    self.retryAfter = retryAfter
  }

  /// Decodes the body as a contract type from `Generated/ApiTypes.swift`.
  public func decode<Value: Decodable>(_ type: Value.Type) throws -> Value {
    do {
      return try JSONDecoder().decode(type, from: data)
    } catch let error as DecodingError {
      throw DesktopFailure("invalid_response", "Unexpected API response: \(Self.describe(error))")
    } catch {
      throw DesktopFailure("invalid_response", "Unexpected API response: \(error)")
    }
  }

  private static func describe(_ error: DecodingError) -> String {
    func path(_ context: DecodingError.Context) -> String {
      context.codingPath.map(\.stringValue).joined(separator: ".")
    }
    switch error {
    case .keyNotFound(let key, let context):
      return "missing \((context.codingPath + [key]).map(\.stringValue).joined(separator: "."))"
    case .typeMismatch(_, let context):
      return "unexpected type at \(path(context))"
    case .valueNotFound(_, let context):
      return "unexpected null at \(path(context))"
    case .dataCorrupted(let context):
      return "invalid value at \(path(context))"
    @unknown default:
      return "undecodable body"
    }
  }
}

public actor APIClient {
  public let baseURL: URL
  private let version: String
  private let sessionId = UUID().uuidString.lowercased()
  private let session: URLSession
  public init(baseURL: URL, version: String, session: URLSession = .shared) {
    self.baseURL = baseURL
    self.version = version
    self.session = session
  }
  /// Resolves a contract route against an API origin.
  public static func url(for route: ApiRoute, baseURL: URL) throws -> URL {
    guard let url = URL(string: route.path, relativeTo: baseURL)?.absoluteURL else {
      throw DesktopFailure("invalid_request", "Unable to resolve \(route.path) against \(baseURL)")
    }
    return url
  }
  /// Includes SDK lookup, one forced refresh on 401, and HTTP in one budget.
  public func authenticatedRequest(
    _ route: ApiRoute, body: JSONValue, timeout: TimeInterval,
    tokenProvider: @escaping @Sendable (Bool) async throws -> String
  ) async throws -> APIResponse {
    try await withThrowingTaskGroup(of: APIResponse.self) { group in
      group.addTask {
        let token = try await tokenProvider(false)
        try Task.checkCancellation()
        let response = try await self.request(route, token: token, body: body, timeout: timeout)
        guard response.status == 401 else { return response }
        let renewed = try await tokenProvider(true)
        try Task.checkCancellation()
        return try await self.request(route, token: renewed, body: body, timeout: timeout)
      }
      group.addTask {
        try await Task.sleep(for: .seconds(timeout))
        throw DesktopFailure("network_error", "Desktop authentication request timed out")
      }
      defer { group.cancelAll() }
      return try await group.next()!
    }
  }
  public func request(
    _ route: ApiRoute, token: String? = nil, body: JSONValue? = nil, timeout: TimeInterval = 30
  ) async throws -> APIResponse {
    var request = URLRequest(
      url: try Self.url(for: route, baseURL: baseURL), timeoutInterval: timeout)
    request.httpMethod = route.method
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue(
      ApiConstants.clientTypeDesktop, forHTTPHeaderField: ApiConstants.clientTypeHeader)
    request.setValue(version, forHTTPHeaderField: ApiConstants.clientVersionHeader)
    request.setValue(sessionId, forHTTPHeaderField: ApiConstants.clientSessionIdHeader)
    request.setValue(
      UUID().uuidString.lowercased(), forHTTPHeaderField: ApiConstants.clientRequestIdHeader)
    if let body {
      request.httpBody = try JSONEncoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    // URLRequest's timeout is an inactivity timeout. Claims and completion
    // reports require a total wall-clock deadline even if bytes keep arriving.
    let (data, response) = try await withThrowingTaskGroup(of: (Data, URLResponse).self) { group in
      group.addTask { [session, request] in try await session.data(for: request) }
      group.addTask {
        try await Task.sleep(for: .seconds(timeout))
        throw DesktopFailure("network_error", "Desktop API request timed out")
      }
      defer { group.cancelAll() }
      return try await group.next()!
    }
    guard let http = response as? HTTPURLResponse else {
      throw DesktopFailure("network_error", "Invalid API response")
    }
    let value = data.isEmpty ? JSONValue.null : try JSONDecoder().decode(JSONValue.self, from: data)
    let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
    return APIResponse(status: http.statusCode, data: data, body: value, retryAfter: retryAfter)
  }
}
