import Foundation

/// Opt-in diagnostics for one authenticated operation, including its 401 refresh.
public actor APIRequestTrace {
  private var requests: [APIRequestDiagnostic] = []
  private var authentication: [APIAuthenticationDiagnostic] = []
  private var phase: APIRequestPhase?
  private var deadline: APIRequestDeadline?
  private var timing: APIRequestTiming?

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

  func recordOperation(_ timing: APIRequestTiming) { self.timing = timing }

  func snapshot() -> APIRequestTraceSnapshot {
    APIRequestTraceSnapshot(
      requests: requests, authentication: authentication, phase: phase, deadline: deadline,
      timing: timing)
  }
}

enum APIRequestPhase: String, Sendable {
  case tokenLookup = "token_lookup"
  case tokenRefresh = "token_refresh"
  case httpRequest = "http_request"
}

enum APIRequestDeadline: String, Sendable {
  case authenticatedRequest = "operation"
  case httpRequest = "http_request"
}

struct APIRequestTiming: Sendable {
  let duration: Duration
  let awakeDuration: Duration

  var context: [String: Any] {
    let elapsed = duration.seconds * 1000
    let awakeElapsed = awakeDuration.seconds * 1000
    return [
      "durationMs": elapsed, "awakeElapsedMs": awakeElapsed,
      "systemSuspendedMs": max(0, elapsed - awakeElapsed),
    ]
  }
}

struct APIAuthenticationDiagnostic: Sendable {
  let phase: APIRequestPhase
  let timing: APIRequestTiming
  let errorType: String?
  let urlErrorCode: Int?

  init(phase: APIRequestPhase, timing: APIRequestTiming, error: Error? = nil) {
    self.phase = phase
    self.timing = timing
    errorType = error.map { String(describing: type(of: $0)) }
    urlErrorCode = (error as? URLError)?.code.rawValue
  }

  var context: [String: Any] {
    var fields = timing.context
    fields["phase"] = phase.rawValue
    fields["outcome"] = errorType == nil ? "succeeded" : "failed"
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
  let timing: APIRequestTiming?

  var operationContext: [String: Any] {
    // Keep fixed diagnostic labels independent of credential-related scrubber matches.
    var fields: [String: Any] = ["phaseTimings": authentication.map(\.context)]
    if let phase { fields["phase"] = phase.rawValue }
    if let deadline { fields["budgetScope"] = deadline.rawValue }
    if let timing {
      for (key, value) in timing.context { fields[key] = value }
    }
    return fields
  }
}

struct APIRequestDiagnostic: Sendable {
  let requestId: String
  let sessionId: String
  let startedAt: Date
  let timing: APIRequestTiming
  let status: Int?
  let responseBytes: Int?
  let headers: [String: String]
  let errorType: String?
  let urlErrorCode: Int?
  let transport: APITransportDiagnostic?

  init(
    requestId: String, sessionId: String, startedAt: Date, timing: APIRequestTiming,
    response: HTTPURLResponse? = nil, responseBytes: Int? = nil, error: Error? = nil,
    transport: APITransportDiagnostic? = nil
  ) {
    self.requestId = requestId
    self.sessionId = sessionId
    self.startedAt = startedAt
    self.timing = timing
    let metadata = response.map(APIHTTPResponseDiagnostic.init) ?? transport?.response
    status = metadata?.status
    self.responseBytes = responseBytes
    headers = metadata?.headers ?? [:]
    errorType = error.map { String(describing: type(of: $0)) }
    urlErrorCode = (error as? URLError)?.code.rawValue
    self.transport = transport
  }

  var context: [String: Any] {
    var fields = timing.context
    fields["clientRequestId"] = requestId
    fields["clientSessionId"] = sessionId
    fields["startedAt"] = ISO8601DateFormatter().string(from: startedAt)
    fields["responseHeaders"] = headers
    if let status { fields["status"] = status }
    if let responseBytes { fields["responseBytes"] = responseBytes }
    if let errorType { fields["errorType"] = errorType }
    if let urlErrorCode { fields["urlErrorCode"] = urlErrorCode }
    if let transport { fields["transport"] = transport.context }
    return fields
  }
}
