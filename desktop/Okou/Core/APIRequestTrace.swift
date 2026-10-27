import Foundation

/// Opt-in diagnostics for one authenticated operation, including its 401 refresh.
public actor APIRequestTrace {
  private var requests: [APIRequestDiagnostic] = []

  public init() {}

  func record(_ request: APIRequestDiagnostic) {
    requests.append(request)
    requests = Array(requests.suffix(2))
  }

  func snapshot() -> [APIRequestDiagnostic] { requests }
}

struct APIRequestDiagnostic: Sendable {
  let requestId: String
  let sessionId: String
  let startedAt: Date
  let durationMs: Double
  let status: Int?
  let responseBytes: Int?
  let headers: [String: String]
  let errorType: String?
  let urlErrorCode: Int?

  init(
    requestId: String, sessionId: String, startedAt: Date, duration: Duration,
    response: HTTPURLResponse? = nil, responseBytes: Int? = nil, error: Error? = nil
  ) {
    self.requestId = requestId
    self.sessionId = sessionId
    self.startedAt = startedAt
    durationMs = duration.seconds * 1000
    status = response?.statusCode
    self.responseBytes = responseBytes
    headers = Dictionary(
      uniqueKeysWithValues: [
        "cf-ray", "x-vercel-id", "x-vercel-cache", "x-request-id", "server", "content-type",
        "retry-after",
      ].compactMap { name -> (String, String)? in
        guard let value = response?.value(forHTTPHeaderField: name) else { return nil }
        return (name, String(value.prefix(256)))
      })
    errorType = error.map { String(describing: type(of: $0)) }
    urlErrorCode = (error as? URLError)?.code.rawValue
  }

  var context: [String: Any] {
    var fields: [String: Any] = [
      "clientRequestId": requestId, "clientSessionId": sessionId,
      "startedAt": ISO8601DateFormatter().string(from: startedAt), "durationMs": durationMs,
      "responseHeaders": headers,
    ]
    if let status { fields["status"] = status }
    if let responseBytes { fields["responseBytes"] = responseBytes }
    if let errorType { fields["errorType"] = errorType }
    if let urlErrorCode { fields["urlErrorCode"] = urlErrorCode }
    return fields
  }
}
