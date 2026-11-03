import Foundation

/// Owned by HostRuntime so concurrent API calls cannot overwrite a heartbeat's evidence.
struct HeartbeatDiagnostics {
  enum Outcome: String {
    case failed, recovered, stopped
    case authorityRejected = "authority_rejected"
  }

  private struct Episode {
    let id = UUID().uuidString.lowercased()
    let started: ContinuousClock.Instant
    let awakeStarted: SuspendingClock.Instant
    let initialTiming: APIRequestTiming?
    let startedAt = Date()
    var attempts = 0
    var firstFailure: [String: Any] = [:]
    var recentFailures: [[String: Any]] = []
    var reportedError = false

    func timing(at now: ContinuousClock.Instant, awakeAt awakeNow: SuspendingClock.Instant)
      -> APIRequestTiming
    {
      var duration = started.duration(to: now)
      var awakeDuration = awakeStarted.duration(to: awakeNow)
      if let initialTiming {
        duration += initialTiming.duration
        awakeDuration += initialTiming.awakeDuration
      }
      return APIRequestTiming(duration: duration, awakeDuration: awakeDuration)
    }

    func context(at now: ContinuousClock.Instant, awakeAt awakeNow: SuspendingClock.Instant)
      -> [String: Any]
    {
      var fields: [String: Any] = [
        "episodeId": id, "startedAt": ISO8601DateFormatter().string(from: startedAt),
        "observedDurationMs": started.duration(to: now).seconds * 1000,
        "failedAttempts": attempts, "firstFailure": firstFailure,
        "recentFailures": recentFailures,
        "omittedFailures": max(0, attempts - recentFailures.count - 1),
      ]
      for (key, value) in timing(at: now, awakeAt: awakeNow).context { fields[key] = value }
      return fields
    }
  }

  private let now: @Sendable () -> ContinuousClock.Instant
  private let awakeNow: @Sendable () -> SuspendingClock.Instant
  private var episode: Episode?

  init(
    now: @escaping @Sendable () -> ContinuousClock.Instant = { .now },
    awakeNow: @escaping @Sendable () -> SuspendingClock.Instant = { .now }
  ) {
    self.now = now
    self.awakeNow = awakeNow
  }

  mutating func failed(
    error: Error, requests: [APIRequestDiagnostic], retryDelay: Double,
    operation: APIRequestTraceSnapshot? = nil
  ) {
    let instant = now()
    let awakeInstant = awakeNow()
    var current =
      episode
      ?? Episode(started: instant, awakeStarted: awakeInstant, initialTiming: operation?.timing)
    current.attempts += 1
    var failure: [String: Any] = [
      "attempt": current.attempts, "observedAt": ISO8601DateFormatter().string(from: Date()),
      "errorType": String(describing: type(of: error)), "retryDelayMs": retryDelay * 1000,
      "requests": requests.map(\.context),
    ]
    if let code = (error as? URLError)?.code.rawValue { failure["urlErrorCode"] = code }
    if let operation { failure["operation"] = operation.operationContext }
    if current.attempts == 1 { current.firstFailure = failure }
    current.recentFailures.append(failure)
    current.recentFailures = Array(current.recentFailures.suffix(10))
    let retryable: Bool
    switch error {
    case let failure as DesktopFailure where failure.code == "network_error":
      if let status = requests.last?.status, !(200..<300).contains(status) {
        retryable = status == 408 || status == 429 || (500..<600).contains(status)
      } else {
        retryable = true
      }
    case let error as URLError:
      switch error.code {
      case .cancelled, .timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
        .dnsLookupFailed, .notConnectedToInternet, .secureConnectionFailed,
        .internationalRoamingOff, .callIsActive, .dataNotAllowed, .resourceUnavailable:
        retryable = true
      default: retryable = false
      }
    case is CancellationError: retryable = true
    default: retryable = false
    }
    // Retryable attempts are ordinary recovery work. Keep unexpected errors and
    // prolonged awake failure visible without reporting every subsequent retry.
    let sustained = current.timing(at: instant, awakeAt: awakeInstant).awakeDuration >= .seconds(90)
    if !current.reportedError && (!retryable || sustained) {
      DesktopTelemetry.captureHeartbeatEpisode(
        id: current.id, outcome: .failed, level: .error,
        context: current.context(at: instant, awakeAt: awakeInstant))
      current.reportedError = true
    } else if current.attempts == 1 {
      DesktopTelemetry.captureHeartbeatEpisode(
        id: current.id, outcome: .failed,
        context: current.context(at: instant, awakeAt: awakeInstant))
    }
    episode = current
  }

  mutating func finish(
    outcome: Outcome, requests: [APIRequestDiagnostic] = [], terminalStatus: Int? = nil,
    operation: APIRequestTraceSnapshot? = nil
  ) {
    guard let current = episode else { return }
    episode = nil
    let instant = now()
    let awakeInstant = awakeNow()
    var context = current.context(at: instant, awakeAt: awakeInstant)
    context["finalRequests"] = requests.map(\.context)
    if let operation { context["finalOperation"] = operation.operationContext }
    if let terminalStatus { context["terminalStatus"] = terminalStatus }
    // A successful retry or stop must not hide a long awake episode whose
    // threshold was crossed between failed attempts.
    if !current.reportedError,
      current.timing(at: instant, awakeAt: awakeInstant).awakeDuration >= .seconds(90)
    {
      DesktopTelemetry.captureHeartbeatEpisode(
        id: current.id, outcome: .failed, level: .error, context: context)
    }
    DesktopTelemetry.captureHeartbeatEpisode(id: current.id, outcome: outcome, context: context)
  }
}
