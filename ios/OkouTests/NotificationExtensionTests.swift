import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import UserNotifications
import XCTest

@testable import Okou

@MainActor
final class NotificationExtensionTests: XCTestCase {
  func testExtensionRestoresSessionAndPersistsHistoryBeforeDeliveringTheOriginalAlert() async throws
  {
    let offline = Mutex(false)
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeRequest: {
        if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      })
    let (session, user, directory) = try await session(fixture)
    let service = NotificationServiceExtension(session: session)
    let delivered = expectation(description: "Original alert delivered after prefetch")
    service.didReceive(request(user: user)) { content in
      XCTAssertEqual(content.body, "Your result is ready")
      delivered.fulfill()
    }
    await fulfillment(of: [delivered], timeout: 5)
    let cache = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: user, workspaceID: "org_one"),
      directory: directory)
    addTeardownBlock { await cache.close() }
    let sync = ChatSync(client: fixture.http.client, cache: cache)
    let history = await sync.cachedHistory(threadID: ConversationHistoryFixture.threadID)
    XCTAssertEqual(history?.messages.count, 2)
    let threads = await sync.cachedThreads()
    XCTAssertEqual(threads?.first?.id, ConversationHistoryFixture.threadID)
    let receipts = try await sync.pendingPrefetchReports()
    XCTAssertEqual(receipts.count, 1)
    XCTAssertEqual(receipts.first?.report.source, "extension")
    XCTAssertEqual(receipts.first?.report.outcome, "saved")
    let domain = "nse-reports-" + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: domain))
    addTeardownBlock { defaults.removePersistentDomain(forName: domain) }
    let notifications = NotificationService(system: NotificationSystemFixture(), defaults: defaults)
    await notifications.update(
      workspace: NotificationWorkspace(
        scopeID: "session", userID: user,
        workspaceID: "org_one", client: fixture.http.client, sync: sync))
    offline.withLock { $0 = true }
    await notifications.flushPrefetchReports()
    let retained = try await sync.pendingPrefetchReports()
    XCTAssertEqual(retained.count, 1)
    offline.withLock { $0 = false }
    await notifications.flushPrefetchReports()
    let acknowledged = try await sync.pendingPrefetchReports()
    XCTAssertTrue(acknowledged.isEmpty)
    XCTAssertFalse(fixture.requests.values.withLock { $0.contains { $0.contains("mark-read") } })
  }

  func testExpiryDeliversTheOriginalAlertWhileTheNetworkIsStillHeld() async throws {
    let started = expectation(description: "History request held")
    let gate = AuthenticationRequestGate()
    await gate.hold()
    addTeardownBlock { await gate.releaseAll() }
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        started.fulfill()
        await gate.enter()
      })
    let (session, user, directory) = try await session(fixture)
    let service = NotificationServiceExtension(session: session)
    let delivered = expectation(description: "Expiry delivers without waiting for HTTP")
    delivered.assertForOverFulfill = true
    service.didReceive(request(user: user)) { content in
      XCTAssertEqual(content.body, "Your result is ready")
      delivered.fulfill()
    }
    await fulfillment(of: [started], timeout: 5)
    service.serviceExtensionTimeWillExpire()
    await fulfillment(of: [delivered], timeout: 1)
    await gate.releaseAll()
    let cache = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: user, workspaceID: "org_one"),
      directory: directory)
    addTeardownBlock { await cache.close() }
    let deadline = ContinuousClock.now + .seconds(3)
    var receipts = try await cache.prefetchReports()
    while receipts.isEmpty, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(10))
      receipts = try await cache.prefetchReports()
    }
    XCTAssertEqual(receipts.first?.report.outcome, "expired")
  }

  func testUnavailableAccountOrWorkspaceDeliversTheAlertWithoutCachingForeignHistory() async throws
  {
    let fixture = ConversationHistoryFixture(count: 2)
    let (session, user, directory) = try await session(fixture)
    for (targetUser, targetWorkspace) in [("user_foreign", "org_one"), (user, "org_elsewhere")] {
      let service = NotificationServiceExtension(session: session)
      let delivered = expectation(description: "Unavailable scope still displays its alert")
      service.didReceive(request(user: targetUser, workspace: targetWorkspace)) { content in
        XCTAssertEqual(content.body, "Your result is ready")
        delivered.fulfill()
      }
      await fulfillment(of: [delivered], timeout: 5)
      let cache = ChatCache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.http.baseURL,
          userID: targetUser, workspaceID: targetWorkspace), directory: directory)
      let history = try await cache.loadHistory(threadID: ConversationHistoryFixture.threadID)
      await cache.close()
      XCTAssertNil(history)
    }
  }

  private func session(_ fixture: ConversationHistoryFixture) async throws -> (
    NotificationExtensionSession, String, URL
  ) {
    let provider = try AuthenticationHTTPFixture()
    addTeardownBlock { await provider.close() }
    let auth = try await provider.authentication(
      restoredAccessGroup: PushConfiguration.keychain().accessGroup)
    let directory = FileManager.default.temporaryDirectory.appending(
      path: "nse-" + UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return (
      NotificationExtensionSession(
        clerk: try XCTUnwrap(auth.clerk), apiURL: fixture.http.baseURL,
        version: "1.0.0", directory: directory, session: fixture.http.session),
      provider.state.withLock { $0.userID }, directory
    )
  }

  private func request(user: String, workspace: String = "org_one") -> UNNotificationRequest {
    let content = UNMutableNotificationContent()
    content.body = "Your result is ready"
    content.userInfo = [
      "okou": [
        "version": 1, "userId": user, "workspaceId": workspace,
        "threadId": ConversationHistoryFixture.threadID,
        "runId": "60000000-0000-4000-8000-000000000003",
        "notificationId": "60000000-0000-4000-8000-000000000003:completed",
      ]
    ]
    return UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  }
}
