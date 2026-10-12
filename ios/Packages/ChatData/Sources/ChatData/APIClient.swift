import Foundation
import OSLog
import Synchronization

public enum APIClientError: LocalizedError, Sendable {
  case http(status: Int, message: String, code: String? = nil)
  case invalidResponse
  case incompatibleData
  case invalidURL

  public var statusCode: Int? {
    if case .http(let status, _, _) = self { return status }
    return nil
  }

  public var serverCode: String? {
    if case .http(_, _, let code) = self { return code }
    return nil
  }

  public var errorDescription: String? {
    switch self {
    case .http(401, _, _): "Your session expired. Sign in again."
    case .http(426, _, _): "Update Okou in TestFlight to continue."
    case .http(402, let message, _): "\(message) Manage your plan on the Okou website."
    case .http(403, let message, _): "\(message) Check your workspace access on the Okou website."
    case .http(429, let message, _): "\(message) Wait a moment, then refresh."
    case .http(_, let message, _): message
    case .invalidResponse: "The server returned an invalid response. Try refreshing."
    case .incompatibleData:
      "This app could not read the server response. Please try again or use Okou on the web."
    case .invalidURL: "The app's API address is invalid. Check its configuration."
    }
  }
}

public struct APIResponse: Sendable {
  public let data: Data
  public let response: HTTPURLResponse
}

/// Calls the canonical API using a fresh, organization-scoped session token.
/// Requests are never automatically resubmitted by this client.
public struct APIClient: Sendable {
  public let baseURL: URL
  private let clientVersion: String
  private let clientSessionId = UUID().uuidString.lowercased()
  private let bearerToken: @Sendable () async throws -> String
  private let session: URLSession

  public init(
    baseURL: URL,
    clientVersion: String,
    session: URLSession = .shared,
    bearerToken: @escaping @Sendable () async throws -> String
  ) {
    self.baseURL = baseURL
    self.clientVersion = clientVersion
    self.session = session
    self.bearerToken = bearerToken
  }

  public func request<Response: Decodable & Sendable>(
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
  public func data(
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
    // Case-sensitive wire value; the API keys the iOS compatibility floor on it.
    request.setValue("iOS", forHTTPHeaderField: "X-Client-Type")
    request.setValue(clientVersion, forHTTPHeaderField: "X-Client-Version")
    request.setValue(clientSessionId, forHTTPHeaderField: "X-Client-Session-Id")
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    return try await execute(request)
  }

  /// Snapshot URLs are signed separately. Never forward the user's bearer token or client headers.
  public func downloadSnapshot(_ url: URL) async throws -> Data {
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
          ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode),
        code: serverError?.error.code
      )
    }
    return APIResponse(data: data, response: response)
  }

  public static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let formatters = Mutex((fractional, ISO8601DateFormatter()))
    decoder.dateDecodingStrategy = .custom { decoder in
      let value = try decoder.singleValueContainer().decode(String.self)
      // Reuse parsers across snapshot rows; the decoding closure can run concurrently.
      if let date = formatters.withLock({ $0.0.date(from: value) ?? $0.1.date(from: value) }) {
        return date
      }
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
    struct Detail: Decodable {
      let message: String
      let code: String?
    }
  }
}
