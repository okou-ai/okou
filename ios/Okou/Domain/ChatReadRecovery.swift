import ChatData
import Foundation
import OSLog
import UIKit

/// Recovery belongs to repeatable reads, never to message or settings commands.
@MainActor
enum ChatReadRecovery {
  static func read<Value: Sendable>(
    _ operation: String,
    sleep: @Sendable (Duration) async throws -> Void,
    body: @MainActor () async throws -> Value
  ) async throws -> Value {
    var attempt = 0
    while true {
      try Task.checkCancellation()
      let startedIn = UIApplication.shared.applicationState.rawValue
      do {
        let result = try await body()
        try Task.checkCancellation()
        return result
      } catch {
        if Task.isCancelled || error is CancellationError
          || (error as? URLError)?.code == .cancelled
        {
          throw CancellationError()
        }
        let failure = error as NSError
        let endedIn = UIApplication.shared.applicationState.rawValue
        Logger(subsystem: "ai.okou.ios", category: "ChatSync")
          .notice(
            "Read failed: \(operation, privacy: .public), attempt \(attempt + 1), \(failure.domain, privacy: .public)/\(failure.code), app state \(startedIn)->\(endedIn)"
          )
        guard let delay = retryDelay(for: error, attempt: attempt) else { throw error }
        try await sleep(delay)
        attempt += 1
      }
    }
  }

  static func retryDelay(for error: Error, attempt: Int) -> Duration? {
    let delays: [Duration] = [.seconds(1), .seconds(3)]
    guard attempt < delays.count else { return nil }
    if let api = error as? APIClientError,
      [429, 500, 502, 503, 504].contains(api.statusCode ?? 0)
    {
      // A longer server deadline ends this foreground attempt rather than retrying early.
      if let seconds = api.retryAfter {
        guard seconds <= 60 else { return nil }
        return max(delays[attempt], .seconds(seconds))
      }
      return delays[attempt]
    }
    return isTransient(error) ? delays[attempt] : nil
  }

  private static func isTransient(_ error: Error) -> Bool {
    guard let error = error as? URLError else { return false }
    switch error.code {
    case .timedOut, .notConnectedToInternet, .networkConnectionLost,
      .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
      return true
    default:
      return false
    }
  }
}
