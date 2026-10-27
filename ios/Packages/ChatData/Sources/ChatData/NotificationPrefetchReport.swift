import Foundation
import OSLog

/// Diagnostic facts only: never message content, device tokens, or credentials.
public struct NotificationPrefetchReport: Codable, Sendable {
  public let notificationId: String
  public let threadId: String
  public let runId: String
  public let source: String
  public let outcome: String
  public let durationMs: Int
  public let lastSeqId: Int?
  public let containsRun: Bool
  public let observedAt: String?

  public init(
    notificationId: String, threadId: String, runId: String, source: String, outcome: String,
    durationMs: Int, lastSeqId: Int?, containsRun: Bool,
    observedAt: String? = Date().ISO8601Format(.init(includingFractionalSeconds: true))
  ) {
    self.notificationId = notificationId
    self.threadId = threadId
    self.runId = runId
    self.source = source
    self.outcome = outcome
    self.durationMs = min(max(durationMs, 0), 60000)
    self.lastSeqId = lastSeqId
    self.containsRun = containsRun
    self.observedAt = observedAt
  }
}

extension APIClient {
  @discardableResult
  public func reportNotificationPrefetch(_ report: NotificationPrefetchReport) async -> Bool {
    do {
      let response = try await data(
        "/api/ios-notifications/prefetch", method: "POST", body: JSONEncoder().encode(report))
      return response.response.statusCode == 200
    } catch {
      // Reporting is best effort, including when a supported API rollback lacks this route.
      Logger(subsystem: "ai.okou.ios", category: "Notifications")
        .info(
          "Cannot report notification prefetch: \(error.localizedDescription, privacy: .public)")
      return false
    }
  }
}
