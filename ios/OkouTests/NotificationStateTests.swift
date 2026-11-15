import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NotificationStateTests: XCTestCase {
  func testReconciliationClearsReadReceiptsAndUsesTheDeviceBadgeCount() async throws {
    let system = NotificationSystemFixture()
    let requests = Mutex(0)
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
      requests.withLock { $0 += 1 }
      return ChatHTTPResponse(
        body: #"{"unreadCount":12,"badgeCount":7,"removeIdentifiers":["read"]}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.delivered.map(\.identifier), ["unread"])
    XCTAssertEqual(system.badgeCount, 7)
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(requests.withLock { $0 }, 1)
    system.delivered.insert(try receipt("read", user: "current"), at: 0)
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(requests.withLock { $0 }, 2)
    XCTAssertEqual(system.delivered.map(\.identifier), ["unread"])
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
      return ChatHTTPResponse(
        body: #"{"unreadCount":99,"badgeCount":99,"removeIdentifiers":["old"]}"#)
    }
    let current = ChatHTTPFixture { request in
      guard request.url?.path == "/api/ios-notifications/reconcile", request.httpMethod == "POST"
      else { throw URLError(.unsupportedURL) }
      return ChatHTTPResponse(body: #"{"unreadCount":12,"badgeCount":2,"removeIdentifiers":[]}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(previous, user: "previous"))
    let opening = Task { await service.refreshNotificationState(userID: "previous") }
    addTeardownBlock {
      await gate.releaseAll()
      await opening.value
    }
    await fulfillment(of: [started], timeout: 3)
    system.delivered = [try receipt("current", user: "current")]
    await service.update(workspace: workspace(current, user: "current"))
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

  func testOpeningClearsTheBadgeBeforeTheNetworkRespondsAndPreservesUnreadNotifications()
    async throws
  {
    let system = NotificationSystemFixture()
    system.badgeCount = 4
    system.delivered = [try receipt("unread", user: "current")]
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/ios-notifications/reconcile" else {
        throw URLError(.unsupportedURL)
      }
      let badgeCount = await MainActor.run { system.badgeCount }
      XCTAssertEqual(badgeCount, 0)
      return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Unavailable"}}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    service.setForeground(true)
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 0)
    XCTAssertEqual(system.delivered.map(\.identifier), ["unread"])
  }

  func testAnOlderApiCannotRestoreChatUnreadCountsAfterOpening() async throws {
    let system = NotificationSystemFixture()
    system.badgeCount = 9
    system.delivered = [try receipt("unread", user: "current")]
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(body: #"{"unreadCount":9,"removeIdentifiers":[]}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    service.setForeground(true)
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 0)
  }

  func testOpeningClearsTheBadgeWhileAnEarlierTokenRequestIsStillBlocked() async throws {
    let system = NotificationSystemFixture()
    system.badgeCount = 9
    system.delivered = [try receipt("unread", user: "current")]
    let gate = AuthenticationRequestGate()
    await gate.hold()
    let observation = await gate.observeRequests()
    var arrivals = observation.arrivals.makeAsyncIterator()
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(body: #"{"unreadCount":9,"badgeCount":0,"removeIdentifiers":[]}"#)
    }
    let client = APIClient(
      baseURL: fixture.baseURL, clientVersion: fixture.clientVersion, session: fixture.session
    ) { [fixture] in
      await gate.enter()
      return withExtendedLifetime(fixture) { "fixture-token" }
    }
    let service = notifications(system)
    await service.update(
      workspace: NotificationWorkspace(
        scopeID: "current", userID: "current", workspaceID: "org_test", client: client,
        sync: ChatSync(client: client)))
    let syncing = Task { await service.refreshNotificationState(userID: "current") }
    addTeardownBlock {
      syncing.cancel()
      await gate.releaseAll()
      await syncing.value
      await gate.stopObserving(observation.id)
    }
    _ = await arrivals.next()
    let cleared = expectation(description: "Icon clears before the token request is released")
    system.didSetBadgeCount = { count in
      if count == 0 {
        cleared.fulfill()
        system.didSetBadgeCount = nil
      }
    }
    service.setForeground(true)
    await fulfillment(of: [cleared], timeout: 3)
    XCTAssertEqual(system.badgeCount, 0)
    await gate.releaseAll()
    await syncing.value
  }

  func testOpeningPersistsTheBadgeCursorForLaterBackgroundReconciliation() async throws {
    let suite = "notification-badge-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    let system = NotificationSystemFixture()
    system.status = .authorized
    let firstCursor = expectation(description: "Foreground badge cursor is sent")
    let cursors = NotificationBadgeCursorFixture()
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/ios-push-registrations" {
        return ChatHTTPResponse(body: "{}")
      }
      guard request.url?.path == "/api/ios-notifications/reconcile" else {
        throw URLError(.unsupportedURL)
      }
      let body = try JSONDecoder().decode(
        SubmittedNotifications.self, from: chatRequestBody(request))
      if let cursor = body.badgeClearSequence {
        let previous = await cursors.record(cursor)
        if let previous {
          XCTAssertEqual(cursor, previous)
        } else {
          firstCursor.fulfill()
        }
      }
      return ChatHTTPResponse(body: #"{"unreadCount":9,"badgeCount":0,"removeIdentifiers":[]}"#)
    }
    let service = NotificationService(system: system, defaults: defaults)
    service.didRegister(deviceToken: Data([1, 2]))
    await service.update(workspace: workspace(fixture, user: "current"))
    service.setForeground(true)
    await service.refreshNotificationState(userID: "current")
    await fulfillment(of: [firstCursor], timeout: 3)

    let restoredCursor = expectation(description: "Background launch reuses the badge cursor")
    let backgroundFixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/ios-push-registrations" {
        return ChatHTTPResponse(body: "{}")
      }
      guard request.url?.path == "/api/ios-notifications/reconcile" else {
        throw URLError(.unsupportedURL)
      }
      let body = try JSONDecoder().decode(
        SubmittedNotifications.self, from: chatRequestBody(request))
      let previous = await cursors.current()
      XCTAssertNotNil(body.badgeClearSequence)
      XCTAssertEqual(body.badgeClearSequence, previous)
      if await cursors.observeBackground() { restoredCursor.fulfill() }
      return ChatHTTPResponse(body: #"{"unreadCount":9,"badgeCount":0,"removeIdentifiers":[]}"#)
    }
    let background = NotificationService(system: system, defaults: defaults)
    background.didRegister(deviceToken: Data([1, 2]))
    await background.update(workspace: workspace(backgroundFixture, user: "current"))
    await background.refreshNotificationState(userID: "current")
    await fulfillment(of: [restoredCursor], timeout: 3)
    XCTAssertEqual(system.badgeCount, 0)
  }

  func testUnboundEmptyWorkStaysLocalAcrossCoordinationAndForegroundVisits() async throws {
    let system = NotificationSystemFixture()
    system.delivered = [try receipt("previous-account", user: "previous")]
    system.badgeCount = 8
    let fixture = ChatHTTPFixture { _ in
      XCTFail("No binding or current-account receipts require an HTTP request")
      throw URLError(.unsupportedURL)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    for _ in 0..<3 {
      service.setForeground(false)
      service.setForeground(true)
      await service.refreshNotificationState(userID: "current")
      await service.refreshNotificationState(userID: "current")
    }
    XCTAssertTrue(system.delivered.isEmpty)
    XCTAssertEqual(system.badgeCount, 0)
  }

  func testBoundCoordinationJoinsTheRequestAndNewReceiptsAndVisitsStillReconcile() async throws {
    let system = NotificationSystemFixture()
    system.status = .authorized
    let cursors = Mutex<[Int?]>([])
    let started = expectation(description: "First bound reconciliation is held")
    let joined = expectation(description: "Equivalent coordinator joins the request")
    let gate = AuthenticationRequestGate()
    await gate.hold()
    addTeardownBlock { await gate.releaseAll() }
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/ios-push-registrations" {
        return ChatHTTPResponse(body: "{}")
      }
      let body = try JSONDecoder().decode(
        SubmittedNotifications.self, from: chatRequestBody(request))
      XCTAssertNotNil(body.registrationRevision)
      let count = cursors.withLock { values in
        values.append(body.badgeClearSequence)
        return values.count
      }
      if count == 1 {
        started.fulfill()
        await gate.enter()
      }
      return ChatHTTPResponse(body: #"{"unreadCount":0,"badgeCount":0,"removeIdentifiers":[]}"#)
    }
    let service = notifications(system)
    service.didRegister(deviceToken: Data([1, 2]))
    await service.update(workspace: workspace(fixture, user: "current"))
    service.setForeground(true)
    let opening = Task { await service.refreshNotificationState(userID: "current") }
    await fulfillment(of: [started], timeout: 3)
    let coordination = Task {
      joined.fulfill()
      await service.refreshNotificationState(userID: "current")
    }
    await fulfillment(of: [joined], timeout: 3)
    await gate.releaseAll()
    await opening.value
    await coordination.value
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(cursors.withLock { $0.count }, 1)

    service.setForeground(false)
    service.setForeground(true)
    await service.refreshNotificationState(userID: "current")
    let visits = cursors.withLock { $0 }
    XCTAssertEqual(visits.count, 2)
    XCTAssertGreaterThan(try XCTUnwrap(visits.last ?? nil), try XCTUnwrap(visits.first ?? nil))

    system.delivered = [try receipt("new-delivery", user: "current")]
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(cursors.withLock { $0.count }, 3)
  }

  func testRealInvalidationRejectsTheOldResponseEvenWhenThePayloadIsUnchanged() async throws {
    let system = NotificationSystemFixture()
    system.delivered = [try receipt("unread", user: "current")]
    let requests = Mutex<[Data]>([])
    let started = expectation(description: "Old read state is held")
    let gate = AuthenticationRequestGate()
    await gate.hold()
    addTeardownBlock { await gate.releaseAll() }
    let fixture = ChatHTTPFixture { request in
      let body = chatRequestBody(request)
      let count = requests.withLock { values in
        values.append(body)
        return values.count
      }
      if count == 1 {
        started.fulfill()
        await gate.enter()
      }
      return ChatHTTPResponse(
        body: "{\"unreadCount\":2,\"badgeCount\":\(count == 1 ? 99 : 2),\"removeIdentifiers\":[]}")
    }
    var badgeWrites: [Int] = []
    system.didSetBadgeCount = { badgeWrites.append($0) }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    let opening = Task { await service.refreshNotificationState(userID: "current") }
    await fulfillment(of: [started], timeout: 3)
    service.requestNotificationStateRefresh()
    await gate.releaseAll()
    await opening.value
    let bodies = requests.withLock { $0 }
    XCTAssertEqual(bodies.count, 2)
    let payloads = try bodies.map { try JSONSerialization.jsonObject(with: $0) as? NSDictionary }
    XCTAssertEqual(payloads.first, payloads.last)
    XCTAssertFalse(badgeWrites.contains(99))
    XCTAssertEqual(system.badgeCount, 2)
  }

  func testFailedDemandCanRetryWithoutANewInvalidation() async throws {
    let system = NotificationSystemFixture()
    system.delivered = [try receipt("unread", user: "current")]
    let requests = Mutex(0)
    let fixture = ChatHTTPFixture { _ in
      let count = requests.withLock {
        $0 += 1
        return $0
      }
      if count == 1 {
        return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Unavailable"}}"#)
      }
      return ChatHTTPResponse(body: #"{"unreadCount":2,"badgeCount":2,"removeIdentifiers":[]}"#)
    }
    let service = notifications(system)
    await service.update(workspace: workspace(fixture, user: "current"))
    await service.refreshNotificationState(userID: "current")
    await service.refreshNotificationState(userID: "current")
    XCTAssertEqual(requests.withLock { $0 }, 2)
    XCTAssertEqual(system.badgeCount, 2)
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
    let registrationRevision: Int?
    let badgeClearSequence: Int?
  }
}

private actor NotificationBadgeCursorFixture {
  private var cursor: Int?
  private var observedBackground = false
  func record(_ value: Int) -> Int? {
    let previous = cursor
    cursor = value
    return previous
  }
  func current() -> Int? { cursor }
  func observeBackground() -> Bool {
    guard !observedBackground else { return false }
    observedBackground = true
    return true
  }
}
