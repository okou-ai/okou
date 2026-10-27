import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

@testable import Okou

@MainActor
final class NotificationStateTests: XCTestCase {
  func testForegroundReconciliationClearsReadReceiptsAndUsesTheAuthoritativeUnreadCount()
    async throws
  {
    let system = NotificationSystemFixture()
    system.delivered = [
      try receipt("read", user: "current"),
      try receipt("unread", user: "current", run: 2),
      try receipt("previous-account", user: "previous"),
    ]
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/ios-notifications/reconcile", request.httpMethod == "POST"
      else { throw URLError(.unsupportedURL) }
      let body = try JSONDecoder().decode(
        SubmittedNotifications.self, from: chatRequestBody(request))
      XCTAssertEqual(body.notifications.map(\.identifier), ["read", "unread"])
      return ChatHTTPResponse(body: #"{"unreadCount":7,"removeIdentifiers":["read"]}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.delivered.map(\.identifier), ["unread"])
    XCTAssertEqual(system.badgeCount, 7)
  }

  func testSigningOutClearsManagedNotificationsAndTheIconBadge() async throws {
    let system = NotificationSystemFixture()
    system.delivered = [try receipt("old", user: "previous")]
    system.badgeCount = 3
    let service = notifications(system)
    await service.refreshNotificationState(userID: nil)
    XCTAssertTrue(system.delivered.isEmpty)
    XCTAssertEqual(system.badgeCount, 0)
  }

  func testAccountSwitchRejectsAnOldHTTPResponseBeforeUpdatingTheDevice() async throws {
    let system = NotificationSystemFixture()
    system.delivered = [try receipt("old", user: "previous")]
    let started = expectation(description: "Previous account reconciliation is held")
    let gate = AuthenticationRequestGate()
    await gate.hold()
    addTeardownBlock { await gate.releaseAll() }
    let previous = ChatHTTPFixture { request in
      guard request.url?.path == "/api/ios-notifications/reconcile", request.httpMethod == "POST"
      else { throw URLError(.unsupportedURL) }
      started.fulfill()
      await gate.enter()
      return ChatHTTPResponse(body: #"{"unreadCount":99,"removeIdentifiers":["old"]}"#)
    }
    let current = ChatHTTPFixture { request in
      guard request.url?.path == "/api/ios-notifications/reconcile", request.httpMethod == "POST"
      else { throw URLError(.unsupportedURL) }
      return ChatHTTPResponse(body: #"{"unreadCount":2,"removeIdentifiers":[]}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(previous, user: "previous"))
    let opening = Task { await service.refreshNotificationState(userID: "previous") }
    addTeardownBlock {
      await gate.releaseAll()
      await opening.value
    }
    await fulfillment(of: [started], timeout: 3)
    await service.update(workspace: workspace(current, user: "current"))
    system.delivered = [try receipt("current", user: "current")]
    await gate.releaseAll()
    await opening.value
    XCTAssertEqual(system.delivered.map(\.identifier), ["current"])
    XCTAssertEqual(system.badgeCount, 2)
  }

  func testUnavailableReadStatePreservesCurrentNotificationsAndBadge() async throws {
    let system = NotificationSystemFixture()
    system.delivered = [try receipt("unread", user: "current")]
    system.badgeCount = 4
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/ios-notifications/reconcile", request.httpMethod == "POST"
      else { throw URLError(.unsupportedURL) }
      return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Unavailable"}}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.delivered.map(\.identifier), ["unread"])
    XCTAssertEqual(system.badgeCount, 4)
  }

  private func notifications(_ system: NotificationSystemFixture) -> NotificationService {
    let suite = "notification-state-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    return NotificationService(system: system, defaults: defaults)
  }

  private func workspace(_ fixture: ChatHTTPFixture, user: String) -> NotificationWorkspace {
    NotificationWorkspace(
      scopeID: user, userID: user, workspaceID: "org_test", client: fixture.client,
      sync: ChatSync(client: fixture.client))
  }

  private func receipt(_ id: String, user: String, run: Int = 1) throws
    -> DeliveredChatNotification
  {
    let destination = try XCTUnwrap(
      NotificationDestination(userInfo: [
        "okou": [
          "version": 1, "userId": user, "workspaceId": "org_test",
          "threadId": ChatLinkFixture.sourceID, "runId": ChatLinkFixture.runID(run),
          "notificationId": id,
        ]
      ]))
    return DeliveredChatNotification(identifier: id, destination: destination)
  }

  private struct SubmittedNotifications: Decodable {
    struct Receipt: Decodable {
      let identifier: String
    }
    let notifications: [Receipt]
  }
}
