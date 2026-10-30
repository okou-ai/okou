import Foundation

/// Opt-in diagnostics for one authenticated operation, including its 401 refresh.
public actor APIRequestTrace {
  private var requests: [APIRequestDiagnostic] = []
  private var authentication: [APIAuthenticationDiagnostic] = []
  private var phase: APIRequestPhase?
  private var deadline: APIRequestDeadline?

  public init() {}

  func record(_ request: APIRequestDiagnostic) {
    requests.append(request)
    requests = Array(requests.suffix(2))
  }

  func begin(_ phase: APIRequestPhase) { self.phase = phase }

  func recordAuthentication(_ diagnostic: APIAuthenticationDiagnostic) {
    authentication.append(diagnostic)
    authentication = Array(authentication.suffix(2))
  }

  func expired(_ deadline: APIRequestDeadline) { self.deadline = deadline }

  func snapshot() -> APIRequestTraceSnapshot {
    APIRequestTraceSnapshot(
      requests: requests, authentication: authentication, phase: phase, deadline: deadline)
  }
}

enum APIRequestPhase: String, Sendable {
  case tokenLookup = "token_lookup"
  case tokenRefresh = "token_refresh"
  case httpRequest = "http_request"
}

enum APIRequestDeadline: String, Sendable {
  case authenticatedRequest = "authenticated_request"
  case httpRequest = "http_request"
}

struct APIAuthenticationDiagnostic: Sendable {
  let phase: APIRequestPhase
  let duration: Duration
  let errorType: String?
  let urlErrorCode: Int?

  init(phase: APIRequestPhase, duration: Duration, error: Error? = nil) {
    self.phase = phase
    self.duration = duration
    errorType = error.map { String(describing: type(of: $0)) }
    urlErrorCode = (error as? URLError)?.code.rawValue
  }

  var context: [String: Any] {
    var fields: [String: Any] = [
      "phase": phase.rawValue, "durationMs": duration.seconds * 1000,
      "outcome": errorType == nil ? "succeeded" : "failed",
    ]
    if let errorType { fields["errorType"] = errorType }
    if let urlErrorCode { fields["urlErrorCode"] = urlErrorCode }
    return fields
  }
}

struct APIRequestTraceSnapshot: Sendable {
  let requests: [APIRequestDiagnostic]
  let authentication: [APIAuthenticationDiagnostic]
  let phase: APIRequestPhase?
  let deadline: APIRequestDeadline?

  var operationContext: [String: Any] {
    var fields: [String: Any] = ["authentication": authentication.map(\.context)]
    if let phase { fields["phase"] = phase.rawValue }
    if let deadline { fields["deadline"] = deadline.rawValue }
    return fields
  }
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
  let transport: APITransportDiagnostic?

  init(
    requestId: String, sessionId: String, startedAt: Date, duration: Duration,
    response: HTTPURLResponse? = nil, responseBytes: Int? = nil, error: Error? = nil,
    transport: APITransportDiagnostic? = nil
  ) {
    self.requestId = requestId
    self.sessionId = sessionId
    self.startedAt = startedAt
    durationMs = duration.seconds * 1000
    let metadata = response.map(APIHTTPResponseDiagnostic.init) ?? transport?.response
    status = metadata?.status
    self.responseBytes = responseBytes
    headers = metadata?.headers ?? [:]
    errorType = error.map { String(describing: type(of: $0)) }
    urlErrorCode = (error as? URLError)?.code.rawValue
    self.transport = transport
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
    if let transport { fields["transport"] = transport.context }
    return fields
  }
}
