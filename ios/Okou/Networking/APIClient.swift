import Foundation
import OSLog

enum APIClientError: LocalizedError, Sendable {
  case http(status: Int, message: String)
  case invalidResponse
  case incompatibleData
  case invalidURL

  var statusCode: Int? {
    if case .http(let status, _) = self { return status }
    return nil
  }

  var errorDescription: String? {
    switch self {
    case .http(401, _): "Your session expired. Sign in again."
    case .http(426, _): "Update Okou in TestFlight to continue."
    case .http(402, let message): "\(message) Manage your plan on the Okou website."
    case .http(403, let message): "\(message) Check your workspace access on the Okou website."
    case .http(429, let message): "\(message) Wait a moment, then refresh."
    case .http(_, let message): message
    case .invalidResponse: "The server returned an invalid response. Try refreshing."
    case .incompatibleData:
      "This app could not read the server response. Please try again or use Okou on the web."
    case .invalidURL: "The app's API address is invalid. Check its configuration."
    }
  }
}

struct APIResponse: Sendable {
  let data: Data
  let response: HTTPURLResponse
}

/// Calls the canonical API using a fresh, organization-scoped session token.
/// Requests are never automatically resubmitted by this client.
struct APIClient: Sendable {
  let baseURL: URL
  private let bearerToken: @Sendable () async throws -> String
  private let session: URLSession

  init(
    baseURL: URL,
    session: URLSession = .shared,
    bearerToken: @escaping @Sendable () async throws -> String
  ) {
    self.baseURL = baseURL
    self.session = session
    self.bearerToken = bearerToken
  }

  func request<Response: Decodable & Sendable>(
    _ path: String,
    method: String = "GET",
    query: [URLQueryItem] = [],
    body: Data? = nil,
    headers: [String: String] = [:],
    as type: Response.Type = Response.self
  ) async throws -> Response {
    let result = try await data(path, method: method, query: query, body: body, headers: headers)
    do {
      return try Self.decoder().decode(type, from: result.data)
    } catch let error as DecodingError {
      let field: String
      switch error {
      case .keyNotFound(let key, let context):
        field =
          "missing field " + (context.codingPath + [key]).map(\.stringValue).joined(separator: ".")
      case .typeMismatch(let type, let context):
        field =
          "expected \(type) at " + context.codingPath.map(\.stringValue).joined(separator: ".")
      case .valueNotFound(let type, let context):
        field = "null \(type) at " + context.codingPath.map(\.stringValue).joined(separator: ".")
      case .dataCorrupted(let context):
        field = "invalid value at " + context.codingPath.map(\.stringValue).joined(separator: ".")
      @unknown default:
        field = "unknown decoding failure"
      }
      Logger(subsystem: "ai.okou.ios", category: "API")
        .error("Cannot decode \(path, privacy: .public): \(field, privacy: .public)")
      throw APIClientError.incompatibleData
    } catch {
      throw APIClientError.incompatibleData
    }
  }

  @discardableResult
  func data(
    _ path: String,
    method: String = "GET",
    query: [URLQueryItem] = [],
    body: Data? = nil,
    headers: [String: String] = [:]
  ) async throws -> APIResponse {
    guard path.hasPrefix("/api/"),
      var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    else { throw APIClientError.invalidURL }
    components.path = path
    components.queryItems = query.isEmpty ? nil : query
    guard let url = components.url else { throw APIClientError.invalidURL }
    let token = try await bearerToken()
    try Task.checkCancellation()
    guard !token.isEmpty else {
      throw APIClientError.http(status: 401, message: "Sign in to continue.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.httpBody = body
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue(UUID().uuidString, forHTTPHeaderField: "X-Client-Request-Id")
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    let result = try await execute(request)
    if let requiredVersion = headers["X-Chat-Event-Schema-Version"],
      result.response.value(forHTTPHeaderField: "X-Chat-Event-Schema-Version") != requiredVersion
    {
      throw APIClientError.incompatibleData
    }
    return result
  }

  /// Snapshot URLs are signed separately. Never forward the user's bearer token.
  func downloadSnapshot(_ url: URL) async throws -> Data {
    guard
      url.scheme == "https"
        || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(url.host ?? ""))
    else {
      throw APIClientError.invalidURL
    }
    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    return try await execute(request).data
  }

  private func execute(_ request: URLRequest) async throws -> APIResponse {
    try Task.checkCancellation()
    let (data, response) = try await session.data(for: request)
    try Task.checkCancellation()
    guard let response = response as? HTTPURLResponse else { throw APIClientError.invalidResponse }
    guard (200..<300).contains(response.statusCode) else {
      let serverError = try? Self.decoder().decode(ErrorEnvelope.self, from: data)
      throw APIClientError.http(
        status: response.statusCode,
        message: serverError?.error.message
          ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
      )
    }
    return APIResponse(data: data, response: response)
  }

  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let value = try decoder.singleValueContainer().decode(String.self)
      let fractional = ISO8601DateFormatter()
      fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      if let date = fractional.date(from: value) { return date }
      if let date = ISO8601DateFormatter().date(from: value) { return date }
      // The list snapshot SQL serializes UTC timestamp-without-timezone columns directly.
      if value.range(
        of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?$"#,
        options: .regularExpression
      ) != nil,
        let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: value.contains("."))
          .parse(value + "Z")
      {
        return date
      }
      throw DecodingError.dataCorrupted(
        .init(codingPath: decoder.codingPath, debugDescription: "Invalid API timestamp"))
    }
    return decoder
  }

  private struct ErrorEnvelope: Decodable {
    let error: Detail
    struct Detail: Decodable { let message: String }
  }
}
