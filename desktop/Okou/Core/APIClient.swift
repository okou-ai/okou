import Foundation

private struct APIRequestDeadlineExceeded: Error {
  let phase: APIRequestPhase?
}

public struct APIResponse: Sendable {
  public let status: Int
  /// Raw response bytes, decoded on demand into generated contract types.
  public let data: Data
  /// Dynamic view of the body for payloads the app relays without reading them.
  /// Non-JSON error responses expose `.null`; their status and raw bytes remain available.
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
  private let now: @Sendable () -> ContinuousClock.Instant
  private let awakeNow: @Sendable () -> SuspendingClock.Instant

  public init(
    baseURL: URL, version: String, session: URLSession = .shared,
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
    awakeNow: @escaping @Sendable () -> SuspendingClock.Instant = { .now }
  ) {
    self.baseURL = baseURL
    self.version = version
    self.session = session
    self.now = now
    self.awakeNow = awakeNow
  }

  private func timing(
    _ started: ContinuousClock.Instant, _ awakeStarted: SuspendingClock.Instant
  ) -> APIRequestTiming {
    APIRequestTiming(
      duration: started.duration(to: now()), awakeDuration: awakeStarted.duration(to: awakeNow()))
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
    _ route: ApiRoute, body: JSONValue? = nil, timeout: TimeInterval,
    trace: APIRequestTrace? = nil,
    tokenProvider: @escaping @Sendable (Bool) async throws -> String
  ) async throws -> APIResponse {
    let started = now()
    let awakeStarted = awakeNow()
    // Keep timeout attribution available without enabling transport diagnostics.
    let progress = trace ?? APIRequestTrace()
    await progress.begin(.tokenLookup)
    do {
      let response = try await withDeadline(
        route: route, timeout: timeout, scope: .authenticatedRequest, trace: progress
      ) { deadline in
        let token = try await self.readToken(
          forceRefresh: false, trace: progress, provider: tokenProvider)
        try Task.checkCancellation()
        await progress.begin(.httpRequest)
        let response = try await self.sendRequest(
          route, token: token, body: body, timeout: timeout, deadline: deadline, trace: trace)
        guard response.status == 401 else { return response }
        let renewed = try await self.readToken(
          forceRefresh: true, trace: progress, provider: tokenProvider)
        try Task.checkCancellation()
        await progress.begin(.httpRequest)
        return try await self.sendRequest(
          route, token: renewed, body: body, timeout: timeout, deadline: deadline, trace: trace)
      }
      await trace?.recordOperation(timing(started, awakeStarted))
      return response
    } catch {
      await trace?.recordOperation(timing(started, awakeStarted))
      throw error
    }
  }

  /// One total deadline owns the whole operation, including cancellation of its transport.
  private func withDeadline<Value: Sendable>(
    route: ApiRoute, timeout: TimeInterval, scope: APIRequestDeadline, trace: APIRequestTrace?,
    operation: @escaping @Sendable (ContinuousClock.Instant) async throws -> Value
  ) async throws -> Value {
    let deadline = now().advanced(by: .seconds(timeout))
    do {
      return try await withThrowingTaskGroup(of: Value.self) { group in
        group.addTask { try await operation(deadline) }
        group.addTask {
          try await Task.sleep(until: deadline)
          let progress = await trace?.snapshot()
          throw APIRequestDeadlineExceeded(phase: progress?.phase)
        }
        defer { group.cancelAll() }
        return try await group.next()!
      }
    } catch let error as APIRequestDeadlineExceeded {
      await trace?.expired(scope)
      let message: String
      switch error.phase {
      case .tokenLookup: message = "Desktop session token lookup timed out"
      case .tokenRefresh: message = "Desktop session token refresh timed out"
      case .httpRequest, nil: message = "Desktop API request timed out"
      }
      throw DesktopFailure("network_error", "\(message) (\(route.method) \(route.path))")
    }
  }

  private func readToken(
    forceRefresh: Bool, trace: APIRequestTrace?,
    provider: @escaping @Sendable (Bool) async throws -> String
  ) async throws -> String {
    let phase: APIRequestPhase = forceRefresh ? .tokenRefresh : .tokenLookup
    await trace?.begin(phase)
    let started = now()
    let awakeStarted = awakeNow()
    do {
      try Task.checkCancellation()
      // SDK token reads can await a shared task that ignores caller cancellation.
      // Terminate this waiter promptly; only cancel its provider task, not the
      // SDK's shared refresh. Late results cannot update this trace or send HTTP.
      let (tokens, completion) = AsyncThrowingStream<String, Error>.makeStream(
        bufferingPolicy: .bufferingNewest(1))
      let read = Task {
        do {
          try Task.checkCancellation()
          let token = try await provider(forceRefresh)
          try Task.checkCancellation()
          completion.yield(token)
          completion.finish()
        } catch {
          completion.finish(throwing: error)
        }
      }
      completion.onTermination = { _ in read.cancel() }
      var iterator = tokens.makeAsyncIterator()
      guard let token = try await iterator.next() else { throw CancellationError() }
      try Task.checkCancellation()
      await trace?.recordAuthentication(
        APIAuthenticationDiagnostic(phase: phase, timing: timing(started, awakeStarted)))
      return token
    } catch {
      await trace?.recordAuthentication(
        APIAuthenticationDiagnostic(
          phase: phase, timing: timing(started, awakeStarted), error: error))
      throw error
    }
  }
  /// Transport errors propagate unchanged unless a native timeout exhausts the total budget.
  /// Total budget expiry throws a `DesktopFailure` with code `network_error`.
  public func request(
    _ route: ApiRoute, token: String? = nil, body: JSONValue? = nil, timeout: TimeInterval = 30,
    trace: APIRequestTrace? = nil
  ) async throws -> APIResponse {
    try await withDeadline(
      route: route, timeout: timeout, scope: .httpRequest, trace: trace
    ) { deadline in
      try await self.sendRequest(
        route, token: token, body: body, timeout: timeout, deadline: deadline, trace: trace)
    }
  }

  /// Authenticated requests already have an earlier total deadline covering SDK reads and HTTP.
  private func sendRequest(
    _ route: ApiRoute, token: String?, body: JSONValue?, timeout: TimeInterval,
    deadline: ContinuousClock.Instant,
    trace: APIRequestTrace?
  ) async throws -> APIResponse {
    await trace?.begin(.httpRequest)
    var request = URLRequest(
      url: try Self.url(for: route, baseURL: baseURL), timeoutInterval: timeout)
    request.httpMethod = route.method
    if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    request.setValue(
      ApiConstants.clientTypeDesktop, forHTTPHeaderField: ApiConstants.clientTypeHeader)
    request.setValue(version, forHTTPHeaderField: ApiConstants.clientVersionHeader)
    request.setValue(sessionId, forHTTPHeaderField: ApiConstants.clientSessionIdHeader)
    let requestId = UUID().uuidString.lowercased()
    request.setValue(requestId, forHTTPHeaderField: ApiConstants.clientRequestIdHeader)
    if let body {
      request.httpBody = try JSONEncoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    // URLRequest's timeout is an inactivity timeout. The public entry point owns
    // the total wall-clock deadline even if bytes keep arriving.
    let started = now()
    let awakeStarted = awakeNow()
    let startedAt = Date()
    let metrics = trace.map { _ in APIRequestMetrics() }
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request, delegate: metrics)
    } catch {
      // Native inactivity timeout can win before the total deadline's sleeper resumes.
      // Capture expiry before recording diagnostics can suspend an otherwise early error.
      let expired =
        (error as? URLError)?.code == .timedOut && !Task.isCancelled && now() >= deadline
      await trace?.record(
        APIRequestDiagnostic(
          requestId: requestId, sessionId: sessionId, startedAt: startedAt,
          timing: timing(started, awakeStarted), error: error, transport: metrics?.snapshot()))
      if expired { throw APIRequestDeadlineExceeded(phase: .httpRequest) }
      throw error
    }
    // Preserve HTTP evidence even when an edge's HTML error page fails JSON decoding.
    await trace?.record(
      APIRequestDiagnostic(
        requestId: requestId, sessionId: sessionId, startedAt: startedAt,
        timing: timing(started, awakeStarted), response: response as? HTTPURLResponse,
        responseBytes: data.count, transport: metrics?.snapshot()))
    guard let http = response as? HTTPURLResponse else {
      throw DesktopFailure("network_error", "Invalid API response")
    }
    let value: JSONValue
    do {
      value = data.isEmpty ? .null : try JSONDecoder().decode(JSONValue.self, from: data)
    } catch let error as DecodingError {
      guard !(200..<300).contains(http.statusCode) else { throw error }
      // An edge's error page must not hide the HTTP status from auth/recovery handling.
      value = .null
    }
    let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
    return APIResponse(status: http.statusCode, data: data, body: value, retryAfter: retryAfter)
  }
}
