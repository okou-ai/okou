import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NotificationRefreshTests: XCTestCase {
  func testMetadataPreservesReceiptsAndReadChangesReconcileNotificationsAndBadge() async throws {
    let metadata = Mutex((title: "Original", muted: false, pinned: false, project: false))
    let response = Mutex((badge: 7, remove: false))
    let threadID = "74000000-0000-4000-8000-000000000001"
    let agentID = "74000000-0000-4000-8000-000000000002"
    let fixture = ChatHTTPFixture { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/api/chat-threads/snapshot"):
        let state = metadata.withLock { $0 }
        let project = state.project ? #""74000000-0000-4000-8000-000000000003""# : "null"
        let pin = state.pinned ? #""a0""# : "null"
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(threadID)","agentId":"\(agentID)",\
            "title":"\(state.title)","muted":\(state.muted),"pinOrder":\(pin),\
            "projectId":\(project),"createdAt":"2026-10-20T00:00:00Z",\
            "updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}],\
            "latestEventId":null,"latestSeqId":null}
            """)
      case ("GET", "/api/chat-threads/events"):
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case ("GET", "/api/indicators"):
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      case ("GET", "/api/agents"): return ChatHTTPResponse(body: "[]")
      case ("POST", "/api/chat-threads/\(threadID)/mark-read"):
        return ChatHTTPResponse(body: #"{"lastReadAt":"2026-11-16T00:00:00Z"}"#)
      case ("POST", "/api/ios-notifications/reconcile"):
        let state = response.withLock { $0 }
        let removed = state.remove ? #""read-state""# : ""
        return ChatHTTPResponse(
          body:
            "{\"unreadCount\":\(state.badge),\"badgeCount\":\(state.badge),\"removeIdentifiers\":[\(removed)]}"
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let system = NotificationSystemFixture()
    let destination = try notificationDestination(threadID: threadID)
    system.delivered = [
      DeliveredChatNotification(identifier: "read-state", destination: destination)
    ]
    let suite = "notification-refresh-" + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    let notifications = NotificationService(system: system, defaults: defaults)
    addTeardownBlock { @MainActor in
      await notifications.update(workspace: nil)
      await notifications.refreshNotificationState(userID: nil)
    }
    let sync = ChatSync(client: fixture.client)
    await notifications.update(
      workspace: NotificationWorkspace(
        scopeID: "current", userID: "current", workspaceID: "org_test",
        client: fixture.client, sync: sync))
    await notifications.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 7)
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, sharedSync: sync,
      didRefreshReadState: { notifications.requestNotificationStateRefresh() })
    addTeardownBlock { @MainActor in await store.close().value }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.count, 1)
    XCTAssertEqual(system.delivered.map(\.identifier), ["read-state"])

    metadata.withLock {
      $0.title = "Renamed"
      $0.pinned = true
      $0.project = true
    }
    response.withLock { $0.badge = 99 }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.first?.title, "Renamed")
    XCTAssertEqual(store.list.threads.first?.pinOrder, "a0")
    XCTAssertNotNil(store.list.threads.first?.projectId)
    await store.list.refresh()
    await notifications.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 7)
    XCTAssertEqual(system.delivered.map(\.identifier), ["read-state"])

    response.withLock { $0.badge = 4 }
    metadata.withLock { $0.muted = true }
    await store.list.refresh()
    await notifications.refreshNotificationState(userID: "current")
    XCTAssertEqual(store.list.threads.first?.isMuted, true)
    XCTAssertEqual(system.badgeCount, 4)

    // The sidebar can already look read while a notification still needs a newer watermark.
    response.withLock { $0.badge = 3 }
    let thread = try XCTUnwrap(store.list.threads.first)
    let read = await store.list.setRead(thread, read: true)
    XCTAssertTrue(read)
    await notifications.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 3)
    response.withLock { $0.badge = 2 }
    await store.refresh([.indicators])
    await notifications.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 2)
    response.withLock { $0 = (0, true) }
    await store.refresh([.readCursor])
    await notifications.refreshNotificationState(userID: "current")
    XCTAssertEqual(system.badgeCount, 0)
    XCTAssertTrue(system.delivered.isEmpty)
  }

  func testArchiveMetadataDismissesNotificationsWhilePreservingUnreadChats() async throws {
    let archived = Mutex(false)
    let threadID = "74000000-0000-4000-8000-000000000001"
    let agentID = "74000000-0000-4000-8000-000000000002"
    let fixture = ChatHTTPFixture { request in
      switch (request.httpMethod, request.url?.path) {
      case ("GET", "/api/chat-threads/snapshot"):
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(threadID)","agentId":"\(agentID)",\
            "title":"Unread result","archived":\(archived.withLock { $0 }),\
            "createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z",\
            "sortAt":"2026-10-20T00:00:00Z"}],"latestEventId":null,"latestSeqId":null}
            """)
      case ("GET", "/api/chat-threads/events"):
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case ("GET", "/api/indicators"):
        let agents = archived.withLock { $0 } ? "{}" : "{\"\(agentID)\":\"unread\"}"
        return ChatHTTPResponse(
          body: """
            {"agents":\(agents),"threads":{"\(threadID)":"unread"},\
            "unreadAt":{"\(threadID)":"2026-10-20T00:00:00Z"}}
            """)
      case ("GET", "/api/agents"): return ChatHTTPResponse(body: "[]")
      case ("POST", "/api/ios-notifications/reconcile"):
        let isArchived = archived.withLock { $0 }
        let removed = isArchived ? #""archived""# : ""
        let count = isArchived ? 0 : 1
        return ChatHTTPResponse(
          body:
            "{\"unreadCount\":\(count),\"badgeCount\":\(count),\"removeIdentifiers\":[\(removed)]}"
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let system = NotificationSystemFixture()
    system.delivered = [
      DeliveredChatNotification(
        identifier: "archived", destination: try notificationDestination(threadID: threadID))
    ]
    let suite = "notification-archive-" + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    let notifications = NotificationService(system: system, defaults: defaults)
    addTeardownBlock { @MainActor in
      await notifications.update(workspace: nil)
      await notifications.refreshNotificationState(userID: nil)
    }
    let sync = ChatSync(client: fixture.client)
    await notifications.update(
      workspace: NotificationWorkspace(
        scopeID: "current", userID: "current", workspaceID: "org_test",
        client: fixture.client, sync: sync))
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, sharedSync: sync,
      didRefreshReadState: { notifications.requestNotificationStateRefresh() })
    addTeardownBlock { @MainActor in await store.close().value }
    await store.list.refresh()
    await notifications.refreshNotificationState(userID: "current")
    let unreadAt = try XCTUnwrap(store.list.threads.first).unreadAt
    XCTAssertTrue(try XCTUnwrap(store.list.threads.first).isUnread)
    XCTAssertEqual(system.badgeCount, 1)

    archived.withLock { $0 = true }
    await store.list.refresh()
    await notifications.refreshNotificationState(userID: "current")

    let thread = try XCTUnwrap(store.list.threads.first)
    XCTAssertTrue(thread.isArchived)
    XCTAssertTrue(thread.isUnread)
    XCTAssertEqual(thread.unreadAt, unreadAt)
    XCTAssertFalse(store.list.hasUnreadThreads)
    XCTAssertEqual(system.badgeCount, 0)
    XCTAssertTrue(system.delivered.isEmpty)
  }

  private func notificationDestination(threadID: String) throws -> NotificationDestination {
    try XCTUnwrap(
      NotificationDestination(userInfo: [
        "okou": [
          "version": 1, "userId": "current", "workspaceId": "org_test",
          "threadId": threadID, "runId": "74000000-0000-4000-8000-000000000004",
          "notificationId": "read-state"
        ]
      ]))
  }
}
