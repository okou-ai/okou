import Foundation

/// Owned by HostRuntime so concurrent API calls cannot overwrite a heartbeat's evidence.
struct HeartbeatDiagnostics {
  enum Outcome: String {
    case failed, recovered, stopped
    case authorityRejected = "authority_rejected"
  }

  private struct Episode {
    let id = UUID().uuidString.lowercased()
    let started = ContinuousClock.now
    let startedAt = Date()
    var attempts = 0
    var firstFailure: [String: Any] = [:]
    var recentFailures: [[String: Any]] = []

    var context: [String: Any] {
      [
        "episodeId": id, "startedAt": ISO8601DateFormatter().string(from: startedAt),
        "observedDurationMs": started.duration(to: .now).seconds * 1000,
        "failedAttempts": attempts, "firstFailure": firstFailure,
        "recentFailures": recentFailures,
        "omittedFailures": max(0, attempts - recentFailures.count - 1),
      ]
    }
  }

  private var episode: Episode?

  mutating func failed(error: Error, requests: [APIRequestDiagnostic], retryDelay: Double) {
    var current = episode ?? Episode()
    current.attempts += 1
    var failure: [String: Any] = [
      "attempt": current.attempts, "observedAt": ISO8601DateFormatter().string(from: Date()),
      "errorType": String(describing: type(of: error)), "retryDelayMs": retryDelay * 1000,
      "requests": requests.map(\.context),
    ]
    if let code = (error as? URLError)?.code.rawValue { failure["urlErrorCode"] = code }
    if current.attempts == 1 { current.firstFailure = failure }
    current.recentFailures.append(failure)
    current.recentFailures = Array(current.recentFailures.suffix(10))
    episode = current
    if current.attempts == 1 {
      DesktopTelemetry.captureHeartbeatEpisode(
        id: current.id, outcome: .failed, context: current.context)
    }
  }

  mutating func finish(
    outcome: Outcome, requests: [APIRequestDiagnostic] = [], terminalStatus: Int? = nil
  ) {
    guard let current = episode else { return }
    episode = nil
    var context = current.context
    context["finalRequests"] = requests.map(\.context)
    if let terminalStatus { context["terminalStatus"] = terminalStatus }
    DesktopTelemetry.captureHeartbeatEpisode(id: current.id, outcome: outcome, context: context)
  }
}
