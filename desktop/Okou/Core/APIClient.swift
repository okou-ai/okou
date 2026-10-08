import Foundation

public struct APIResponse: Sendable {
  public let status: Int
  public let body: JSONValue
  public let retryAfter: TimeInterval?
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
  /// Includes SDK lookup, one forced refresh on 401, and HTTP in one budget.
  public func authenticatedRequest(
    _ path: String, body: JSONValue, timeout: TimeInterval,
    tokenProvider: @escaping @Sendable (Bool) async throws -> String
  ) async throws -> APIResponse {
    try await withThrowingTaskGroup(of: APIResponse.self) { group in
      group.addTask {
        let token = try await tokenProvider(false)
        try Task.checkCancellation()
        let response = try await self.request(path, token: token, body: body, timeout: timeout)
        guard response.status == 401 else { return response }
        let renewed = try await tokenProvider(true)
        try Task.checkCancellation()
        return try await self.request(path, token: renewed, body: body, timeout: timeout)
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
    _ path: String, token: String? = nil, body: JSONValue? = nil, timeout: TimeInterval = 30
  ) async throws -> APIResponse {
    var request = URLRequest(url: baseURL.appendingPathComponent(path), timeoutInterval: timeout)
    request.httpMethod = body == nil ? "GET" : "POST"
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue("Desktop", forHTTPHeaderField: "X-Client-Type")
    request.setValue(version, forHTTPHeaderField: "X-Client-Version")
    request.setValue(sessionId, forHTTPHeaderField: "X-Client-Session-Id")
    request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-Client-Request-Id")
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
    return APIResponse(status: http.statusCode, body: value, retryAfter: retryAfter)
  }
}
