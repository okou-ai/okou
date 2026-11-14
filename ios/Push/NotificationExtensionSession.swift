import ChatData
import ClerkKit
import Foundation
import OSLog

@MainActor
final class NotificationExtensionSession {
  let clerk: Clerk
  let apiURL: URL
  let version: String
  let directory: URL
  let session: URLSession

  init(clerk: Clerk, apiURL: URL, version: String, directory: URL, session: URLSession = .shared) {
    self.clerk = clerk
    self.apiURL = apiURL
    self.version = version
    self.directory = directory
    self.session = session
  }

  static func live() -> NotificationExtensionSession? {
    let bundle = Bundle.main
    guard let directory = PushConfiguration.directory(),
      let key = bundle.object(forInfoDictionaryKey: "ClerkPublishableKey") as? String,
      key.hasPrefix("pk_live_") || key.hasPrefix("pk_test_"),
      let api = bundle.object(forInfoDictionaryKey: "APIBaseURL") as? String,
      let apiURL = URL(string: api), apiURL.scheme == "https",
      let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    else { return nil }
    let clerk = Clerk.configure(
      publishableKey: key,
      options: .init(telemetryEnabled: false, keychainConfig: PushConfiguration.keychain()))
    return NotificationExtensionSession(
      clerk: clerk, apiURL: apiURL, version: version, directory: directory)
  }

  /// An API client for this account and workspace. Throws `scopeUnavailable` when the shared
  /// session is signed out or belongs to another account or workspace.
  func client(userID: String, workspaceID: String) async throws -> APIClient {
    if clerk.environment == nil { try await clerk.refreshEnvironment() }
    try await clerk.refreshClient()
    try Task.checkCancellation()
    guard let identity = clerk.session, clerk.isAuthFlowComplete,
      clerk.user?.id == userID,
      identity.lastActiveOrganizationId == workspaceID
    else { throw SessionError.scopeUnavailable }
    return APIClient(baseURL: apiURL, clientVersion: version, session: session) { [self] in
      try await token(userID: userID, workspaceID: workspaceID, sessionID: identity.id)
    }
  }

  func synchronize(_ destination: NotificationDestination) async throws {
    let client = try await client(userID: destination.userId, workspaceID: destination.workspaceId)
    let cache = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: apiURL,
        userID: destination.userId, workspaceID: destination.workspaceId), directory: directory)
    let sync = ChatSync(client: client, cache: cache)
    let started = ContinuousClock.now
    do {
      let receipt = try await sync.prefetchNotification(
        threadID: destination.threadId, runID: destination.runId, tailOnly: true)
      try Task.checkCancellation()
      let elapsed = started.duration(to: .now).components
      try await cache.savePrefetchReport(
        NotificationPrefetchReport(
          notificationId: destination.notificationId, threadId: destination.threadId,
          runId: destination.runId,
          source: "extension", outcome: "saved",
          durationMs: Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000),
          lastSeqId: receipt.lastSeqID, containsRun: receipt.containsRun))
      await cache.close()
    } catch {
      let elapsed = started.duration(to: .now).components
      try? await cache.savePrefetchReport(
        NotificationPrefetchReport(
          notificationId: destination.notificationId, threadId: destination.threadId,
          runId: destination.runId, source: "extension",
          outcome: Task.isCancelled ? "expired" : "failed",
          durationMs: Int(elapsed.seconds * 1000 + elapsed.attoseconds / 1_000_000_000_000_000),
          lastSeqId: nil, containsRun: false))
      await cache.close()
      Logger(subsystem: "ai.okou.ios", category: "NotificationExtension")
        .error(
          "Prefetch failed: notification=\(destination.notificationId, privacy: .public) error=\(error.localizedDescription, privacy: .public)"
        )
      throw error
    }
  }

  private func token(userID: String, workspaceID: String, sessionID: String) async throws -> String
  {
    guard let identity = clerk.session, identity.id == sessionID,
      clerk.user?.id == userID,
      identity.lastActiveOrganizationId == workspaceID,
      let token = try await identity.getToken(),
      clerk.session?.id == sessionID, clerk.user?.id == userID,
      clerk.session?.lastActiveOrganizationId == workspaceID
    else { throw SessionError.scopeUnavailable }
    // This only fences the requested cache scope. The API verifies the JWT signature
    // and session permissions; a decoded client claim never grants access.
    let parts = token.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 3 else { throw SessionError.scopeUnavailable }
    var encoded = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(
      of: "_", with: "/")
    encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
    guard let data = Data(base64Encoded: encoded),
      let claims = try? JSONDecoder().decode(Claims.self, from: data),
      claims.sub == userID, claims.sid == sessionID,
      (claims.o?.id ?? claims.organizationID) == workspaceID
    else { throw SessionError.scopeUnavailable }
    try Task.checkCancellation()
    return token
  }

  private struct Claims: Decodable {
    struct Organization: Decodable { let id: String }
    let sub: String
    let sid: String
    let organizationID: String?
    let o: Organization?

    enum CodingKeys: String, CodingKey {
      case sub, sid, o
      case organizationID = "org_id"
    }
  }
  enum SessionError: Error { case scopeUnavailable }
}
