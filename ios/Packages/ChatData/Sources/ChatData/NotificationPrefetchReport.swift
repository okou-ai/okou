import Foundation
import OSLog

/// Diagnostic facts only: never message content, device tokens, or credentials.
public struct NotificationPrefetchReport: Encodable, Sendable {
  public let notificationId: String
  public let threadId: String
  public let runId: String
  public let source: String
  public let outcome: String
  public let durationMs: Int
  public let lastSeqId: Int?
  public let containsRun: Bool

  public init(
    notificationId: String, threadId: String, runId: String, source: String, outcome: String,
    durationMs: Int, lastSeqId: Int?, containsRun: Bool
  ) {
    self.notificationId = notificationId
    self.threadId = threadId
    self.runId = runId
    self.source = source
    self.outcome = outcome
    self.durationMs = durationMs
    self.lastSeqId = lastSeqId
    self.containsRun = containsRun
  }
}

extension APIClient {
  public func reportNotificationPrefetch(_ report: NotificationPrefetchReport) async {
    do {
      _ = try await data(
        "/api/ios-notifications/prefetch", method: "POST", body: JSONEncoder().encode(report))
    } catch {
      // Reporting is best effort, including when a supported API rollback lacks this route.
      Logger(subsystem: "ai.okou.ios", category: "Notifications")
        .info(
          "Cannot report notification prefetch: \(error.localizedDescription, privacy: .public)")
    }
  }
}
