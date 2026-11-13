import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import UserNotifications
import XCTest

@testable import Okou

/// The widget's refresh and the notification extension's mark share the App Group snapshot and
/// the session the App keeps in the shared Keychain.
@MainActor
final class OkouWidgetRefreshTests: XCTestCase {
  nonisolated private static let thread = ConversationHistoryFixture.threadID
  nonisolated private static let started = "60000000-0000-4000-8000-000000000041"

  func testRefreshAppliesTheAccountsChatStatesAndKeepsTheLastSnapshotWhenTheAPIFails() async throws
  {
    let failing = Mutex(false)
    let fixture = ConversationHistoryFixture(
      count: 2,
      additional: { request in
        guard request.url?.path == "/api/chat-threads/\(Self.started)/metadata" else {
          throw URLError(.unsupportedURL)
        }
        return ChatHTTPResponse(
          body: #"{"title":"⏳ Started on the web","pinnedAt":null,"archived":false,"muted":false}"#)
      },
      indicators: { _ in
        if failing.withLock({ $0 }) {
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Unavailable"}}"#)
        }
        return ChatHTTPResponse(
          body: """
            {"agents":{},"threads":{"\(Self.thread)":"unread","\(Self.started)":"active"},\
            "unreadAt":{"\(Self.thread)":"2026-10-20T00:00:00.000Z"}}
            """)
      })
    let (session, user) = try await session(fixture)
    let store = temporaryStore()
    try store.write(snapshot(user: user, state: .working))
    try age(store)

    let refreshed = await OkouWidgetRefresh().run(store: store, session: session)
    XCTAssertEqual(refreshed?.chats.map(\.id), [Self.thread, Self.started])
    XCTAssertEqual(refreshed?.chats.map(\.state), [.finished, .working])
    XCTAssertEqual(refreshed?.chats.last?.title, "Started on the web")
    XCTAssertEqual(try store.read(), refreshed)

    failing.withLock { $0 = true }
    try age(store)
    let kept = await OkouWidgetRefresh().run(store: store, session: session)
    XCTAssertEqual(kept, refreshed)
    XCTAssertEqual(try store.read(), refreshed)
  }

  func testRefreshReadsNothingForAFreshSnapshotAnotherAccountOrAnOlderAppsSnapshot() async throws {
    let fixture = ConversationHistoryFixture(count: 2)
    let (session, user) = try await session(fixture)
    let store = temporaryStore()
    let mine = snapshot(user: user, state: .working)
    try store.write(mine)
    let fresh = await OkouWidgetRefresh().run(store: store, session: session)
    XCTAssertEqual(fresh, mine, "The App wrote it moments ago")

    let foreign = snapshot(user: "user_foreign", state: .working)
    try store.write(foreign)
    try age(store)
    let other = await OkouWidgetRefresh().run(store: store, session: session)
    XCTAssertEqual(other, foreign)

    let older = OkouWidgetSnapshot(
      userID: nil, workspaceID: "org_one", greetings: mine.greetings, chats: mine.chats)
    try store.write(older)
    try age(store)
    let unowned = await OkouWidgetRefresh().run(store: store, session: session)
    XCTAssertEqual(unowned, older)
    XCTAssertFalse(
      fixture.requests.values.withLock { $0.contains { $0.hasSuffix("/api/indicators") } })
  }

  func testWidgetsReloadingTogetherShareOneRefresh() async throws {
    let fixture = ConversationHistoryFixture(count: 2)
    let (session, user) = try await session(fixture)
    let store = temporaryStore()
    try store.write(snapshot(user: user, state: .working))
    try age(store)
    let refresh = OkouWidgetRefresh()
    async let small = refresh.run(store: store, session: session)
    async let medium = refresh.run(store: store, session: session)
    async let lockScreen = refresh.run(store: store, session: session)
    let results = await [small, medium, lockScreen]
    XCTAssertEqual(Set(results.map { $0?.chats.first?.state }), [.idle])
    XCTAssertEqual(
      fixture.requests.values.withLock { $0.filter { $0.hasSuffix("/api/indicators") }.count }, 1)
  }

  func testFinishedAlertMarksItsWidgetChatBeforeDeliveryAndOnlyForThatAccount() async throws {
    let fixture = ConversationHistoryFixture(count: 2)
    let (session, user) = try await session(fixture)
    let store = temporaryStore()
    for (target, expected) in [
      ("user_foreign", OkouWidgetSnapshot.Chat.State.working), (user, .finished),
    ] {
      try store.write(snapshot(user: user, state: .working))
      let service = NotificationServiceExtension(session: session, widgets: store)
      let delivered = expectation(description: "The original alert is delivered")
      service.didReceive(alert(user: target)) { content in
        XCTAssertEqual(content.body, "Your result is ready")
        delivered.fulfill()
      }
      await fulfillment(of: [delivered], timeout: 5)
      XCTAssertEqual(try store.read()?.chats.first?.state, expected)
    }
  }

  private func snapshot(
    user: String, state: OkouWidgetSnapshot.Chat.State
  ) -> OkouWidgetSnapshot {
    OkouWidgetSnapshot(
      userID: user, workspaceID: "org_one",
      greetings: .init(morning: "m", day: "d", evening: "e", night: "n"),
      chats: [
        .init(
          id: Self.thread, title: "History", emoji: nil, state: state, isPinned: false,
          activityAt: Date(timeIntervalSince1970: 1_790_000_000))
      ])
  }

  private var snapshotURL: URL?

  private func temporaryStore() -> OkouWidgetSnapshotStore {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("widget-refresh-" + UUID().uuidString)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("snapshot.json")
    snapshotURL = url
    return OkouWidgetSnapshotStore(url: url)
  }

  /// A snapshot nobody wrote in the last moments, as when a widget push arrives.
  private func age(_ store: OkouWidgetSnapshotStore) throws {
    let url = try XCTUnwrap(snapshotURL)
    try FileManager.default.setAttributes(
      [.modificationDate: Date(timeIntervalSinceNow: -60)], ofItemAtPath: url.path)
    XCTAssertLessThan(store.modifiedAt() ?? .now, Date(timeIntervalSinceNow: -30))
  }

  private func session(
    _ fixture: ConversationHistoryFixture
  ) async throws -> (NotificationExtensionSession, String) {
    let provider = try AuthenticationHTTPFixture()
    addTeardownBlock { await provider.close() }
    let auth = try await provider.authentication(
      restoredAccessGroup: PushConfiguration.keychain().accessGroup)
    let directory = CacheTestDirectory(owner: self)
    return (
      NotificationExtensionSession(
        clerk: try XCTUnwrap(auth.clerk), apiURL: fixture.http.baseURL,
        version: "1.0.0", directory: directory.url, session: fixture.http.session),
      provider.state.withLock { $0.userID }
    )
  }

  private func alert(user: String) -> UNNotificationRequest {
    let content = UNMutableNotificationContent()
    content.body = "Your result is ready"
    content.userInfo = [
      "okou": [
        "version": 1, "userId": user, "workspaceId": "org_one", "threadId": Self.thread,
        "runId": "60000000-0000-4000-8000-000000000003",
        "notificationId": "60000000-0000-4000-8000-000000000003:completed",
      ]
    ]
    return UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
  }
}
