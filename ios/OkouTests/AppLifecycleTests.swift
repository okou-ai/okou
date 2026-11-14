import ChatData
import ChatDataTestSupport
import CryptoKit
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class AppLifecycleTests: XCTestCase {
  func testInactiveRoundTripReusesLoadedWorkspaceReads() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let fixture = LifecycleHTTPFixture()
    let lifecycle = try lifecycle(authentication, fixture)
    await lifecycle.setPhase(.active)?.value
    await lifecycle.updateScope()
    let workspace = try XCTUnwrap(lifecycle.workspace)
    await workspace.start()
    await workspace.store.newModelSelection.open()
    await workspace.store.projects.activate()
    await workspace.store.newComposer.synchronize()
    let reads = fixture.history.requests.values.withLock { $0.filter { $0.hasPrefix("GET ") } }

    lifecycle.setPhase(.inactive)
    await lifecycle.setPhase(.active)?.value

    XCTAssertEqual(workspace.store.newModelSelection.selection.model, "codex-model")
    XCTAssertTrue(workspace.store.newModelSelection.canSend)
    XCTAssertEqual(workspace.store.list.threads.map(\.id), [ConversationHistoryFixture.threadID])
    XCTAssertEqual(
      fixture.history.requests.values.withLock { $0.filter { $0.hasPrefix("GET ") } }, reads)
  }

  func testInactiveScenePreservesAnInFlightMessageRefresh() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let held = expectation(description: "The message response is pending")
    let gate = ModelResponseGate()
    let holding = Mutex(false)
    let fixture = LifecycleHTTPFixture(beforeEventRows: { _ in
      if holding.withLock({ $0 }) {
        held.fulfill()
        await gate.wait()
      }
    })
    let lifecycle = try lifecycle(authentication, fixture)
    addTeardownBlock { gate.open() }
    await lifecycle.setPhase(.active)?.value
    await lifecycle.updateScope()
    let workspace = try XCTUnwrap(lifecycle.workspace)
    workspace.store.selectedThreadID = ConversationHistoryFixture.threadID
    await workspace.start()
    let conversation = try XCTUnwrap(workspace.store.selectedConversation)
    XCTAssertEqual(conversation.messages.count, 2)
    let path = "GET /api/chat-threads/\(ConversationHistoryFixture.threadID)/event-rows"
    let reads = fixture.history.requests.values.withLock { $0.filter { $0 == path }.count }
    fixture.history.appendMessage()
    holding.withLock { $0 = true }
    workspace.store.requestRefresh(.history(threadID: ConversationHistoryFixture.threadID))
    await fulfillment(of: [held], timeout: 3)

    lifecycle.setPhase(.inactive)
    gate.open()
    await lifecycle.setPhase(.active)?.value

    XCTAssertEqual(conversation.messages.count, 3)
    XCTAssertEqual(
      fixture.history.requests.values.withLock { $0.filter { $0 == path }.count }, reads + 1)
  }

  func testCancelledPresentationWaiterDoesNotRetireWorkspaceStartup() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let held = expectation(description: "Navigation HTTP is held")
    let gate = ModelResponseGate()
    let fixture = LifecycleHTTPFixture(beforeNavigation: {
      held.fulfill()
      await gate.wait()
    })
    let lifecycle = try lifecycle(authentication, fixture)
    lifecycle.setPhase(.active)
    await lifecycle.updateScope()
    let workspace = try XCTUnwrap(lifecycle.workspace)
    workspace.store.newChatDraft = "Input entered before navigation completes"
    let waiter = Task { await workspace.start() }
    addTeardownBlock { @MainActor in
      lifecycle.close()
      waiter.cancel()
      gate.open()
      await waiter.value
    }
    await fulfillment(of: [held], timeout: 3)
    waiter.cancel()
    gate.open()
    await workspace.start()
    await waiter.value

    XCTAssertEqual(workspace.store.list.agents.map(\.agentId), [ConversationHistoryFixture.agentID])
    XCTAssertEqual(workspace.store.newChatDraft, "Input entered before navigation completes")
  }

  func testForegroundCatchUpAndMemoryPressurePreserveTheSelectedChatAndDraft() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let fixture = LifecycleHTTPFixture()
    let lifecycle = try lifecycle(authentication, fixture)
    addTeardownBlock { @MainActor in lifecycle.close() }
    lifecycle.setPhase(.active)
    await lifecycle.updateScope()
    let workspace = try XCTUnwrap(lifecycle.workspace)
    workspace.store.selectedThreadID = ConversationHistoryFixture.threadID
    await workspace.start()
    let conversation = try XCTUnwrap(workspace.store.selectedConversation)
    XCTAssertEqual(conversation.messages.count, 2)
    conversation.draft = "Unsent draft survives lifecycle changes"

    lifecycle.setPhase(.inactive)
    lifecycle.setPhase(.background)
    fixture.history.appendMessage()
    lifecycle.setPhase(.inactive)
    await lifecycle.setPhase(.active)?.value
    XCTAssertEqual(conversation.messages.count, 3)
    await lifecycle.reduceMemory()

    XCTAssertEqual(workspace.store.selectedThreadID, ConversationHistoryFixture.threadID)
    XCTAssertTrue(conversation.messages.last?.text.contains("Message 3") == true)
    XCTAssertEqual(conversation.draft, "Unsent draft survives lifecycle changes")
  }

  func testWorkspaceReplacementFencesHeldStartupAndKeepsTheNewWorkspaceUsable() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    identity.state.withLock { $0.workspaceIDs = ["org_one", "org_two"] }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let held = expectation(description: "First workspace navigation is held")
    let gate = ModelResponseGate()
    let first = Mutex(true)
    let fixture = LifecycleHTTPFixture(beforeNavigation: {
      if first.withLock({ value in
        let wasFirst = value
        value = false
        return wasFirst
      }) {
        held.fulfill()
        await gate.wait()
      }
    })
    let lifecycle = try lifecycle(authentication, fixture)
    lifecycle.setPhase(.active)
    await lifecycle.updateScope()
    let previous = try XCTUnwrap(lifecycle.workspace)
    previous.store.newChatDraft = "Previous workspace input"
    let startup = Task { await previous.start() }
    addTeardownBlock { @MainActor in
      lifecycle.close()
      startup.cancel()
      gate.open()
      await startup.value
    }
    await fulfillment(of: [held], timeout: 3)

    try await authentication.switchWorkspace("org_two")
    await lifecycle.updateScope()
    let current = try XCTUnwrap(lifecycle.workspace)
    await current.start()
    XCTAssertTrue(current.store.newChatDraft.isEmpty)
    current.store.newChatDraft = "Current workspace input"
    gate.open()
    await startup.value

    XCTAssertEqual(current.store.list.agents.map(\.agentId), [ConversationHistoryFixture.agentID])
    XCTAssertEqual(current.store.newChatDraft, "Current workspace input")
    XCTAssertEqual(fixture.navigationWorkspaces.first, "org_one")
    XCTAssertEqual(fixture.navigationWorkspaces.last, "org_two")
  }

  func testRootCancellationCancelsOriginalWorkspaceHttpBeforeItsReplyIsReleased() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let held = expectation(description: "Workspace HTTP is held")
    let cancelled = expectation(description: "Original HTTP is cancelled before its reply")
    let gate = ModelResponseGate()
    let fixture = LifecycleHTTPFixture(beforeNavigation: {
      held.fulfill()
      await withTaskCancellationHandler {
        await gate.wait()
      } onCancel: {
        cancelled.fulfill()
      }
    })
    let lifecycle = try lifecycle(authentication, fixture)
    let root = Task { await lifecycle.run() }
    lifecycle.setPhase(.active)
    await lifecycle.updateScope()
    let workspace = try XCTUnwrap(lifecycle.workspace)
    let startup = Task { await workspace.start() }
    addTeardownBlock { @MainActor in
      root.cancel()
      lifecycle.close()
      startup.cancel()
      gate.open()
      await root.value
      await startup.value
    }
    await fulfillment(of: [held], timeout: 3)
    root.cancel()
    await fulfillment(of: [cancelled], timeout: 3)
    await root.value
    gate.open()
    await startup.value

    XCTAssertNil(lifecycle.workspace)
  }

  func testPendingNotificationOpensThroughTheCurrentWorkspaceOwner() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    let authentication = try await identity.authentication()
    await authentication.refresh()
    let fixture = LifecycleHTTPFixture()
    let lifecycle = try lifecycle(authentication, fixture)
    addTeardownBlock { @MainActor in lifecycle.close() }
    lifecycle.setPhase(.active)
    await lifecycle.updateScope()
    let workspace = try XCTUnwrap(lifecycle.workspace)
    await workspace.start()
    let destination = try XCTUnwrap(
      NotificationDestination(userInfo: [
        "okou": [
          "version": 1, "userId": try XCTUnwrap(authentication.userID),
          "workspaceId": "org_one", "threadId": ConversationHistoryFixture.threadID,
          "runId": "60000000-0000-4000-8000-000000000003", "notificationId": "lifecycle-complete",
        ]
      ]))
    lifecycle.notifications.receiveTap(destination)
    await lifecycle.updateNotificationDemand()
    let opened = await workspace.openPendingNotification()

    XCTAssertTrue(opened)
    XCTAssertNil(lifecycle.notifications.pendingDestination)
    XCTAssertEqual(workspace.store.selectedThreadID, ConversationHistoryFixture.threadID)
    XCTAssertEqual(workspace.store.selectedConversation?.messages.count, 2)
  }

  private func lifecycle(_ authentication: AuthenticationService, _ fixture: LifecycleHTTPFixture)
    throws -> AppLifecycle
  {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let bundleURL = directory.appending(path: "Lifecycle.bundle")
    try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    let info = [
      "CFBundleIdentifier": "ai.okou.tests.lifecycle", "CFBundleShortVersionString": "1.0.0",
      "APIBaseURL": fixture.history.http.baseURL.absoluteString,
      "WebBaseURL": fixture.history.http.baseURL.absoluteString,
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      .write(to: bundleURL.appending(path: "Info.plist"))
    let configuration = try AppConfiguration(bundle: XCTUnwrap(Bundle(url: bundleURL)))
    let suite = "lifecycle-" + UUID().uuidString
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    let lifecycle = AppLifecycle(
      authentication: authentication, configuration: configuration,
      session: fixture.history.http.session,
      notifications: NotificationService(system: NotificationSystemFixture(), defaults: defaults))
    let scopes = try authentication.workspaces.map {
      ChatCacheScope(
        apiBaseURL: configuration.apiURL, userID: try XCTUnwrap(authentication.userID),
        workspaceID: $0.id)
    }
    let caches = LifecycleFixtureCaches()
    caches.add(lifecycle.workspace?.data.cache)
    addTeardownBlock { @MainActor [fixture] in
      await caches.close()
      try Self.removeFixtureFiles(scopes)
      withExtendedLifetime(fixture) {}
    }
    // The HTTP fixture itself must outlive its URLSession and every service-owned worker.
    addTeardownBlock { @MainActor [fixture] in
      let current = lifecycle.notifications.data(
        authentication: authentication, configuration: configuration,
        session: fixture.history.http.session)
      caches.add(current?.cache)
      await lifecycle.close().value
      do { try await authentication.signOut() } catch {
        XCTFail("Cannot sign out the lifecycle fixture: \(error)")
      }
      await lifecycle.notifications.update(workspace: nil)
      await lifecycle.notifications.refreshNotificationState(userID: nil)
      let remaining = lifecycle.notifications.data(
        authentication: authentication, configuration: configuration,
        session: fixture.history.http.session)
      caches.add(remaining?.cache)
    }
    return lifecycle
  }

  /// Teardown only: remove this fixture's reserved-origin namespaces, never sibling data.
  private static func removeFixtureFiles(_ scopes: [ChatCacheScope]) throws {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[
      0]
    let cacheRoots = Set([support] + [PushConfiguration.directory()].compactMap { $0 })
    for scope in scopes {
      let identity = [scope.apiBaseURL.absoluteString, scope.userID, scope.workspaceID]
        .joined(separator: "\u{0}")
      let name = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
      var paths = [support.appending(path: "ChatDrafts/" + name)]
      for suffix in [".sqlite", ".sqlite-wal", ".sqlite-shm"] {
        paths.append(support.appending(path: "ProjectDisclosure/" + name + suffix))
        paths += cacheRoots.map { $0.appending(path: "ChatCache/" + name + suffix) }
      }
      for path in paths {
        do { try FileManager.default.removeItem(at: path) } catch let error as CocoaError
          where error.code == .fileNoSuchFile
        {}
      }
    }
  }
}

/// Own the actual scoped connections, independently of ARC release timing.
@MainActor
private final class LifecycleFixtureCaches {
  private var caches: [ChatCache] = []

  func add(_ cache: ChatCache?) {
    if let cache, !caches.contains(where: { $0 === cache }) { caches.append(cache) }
  }

  func close() async {
    for cache in caches { await cache.close() }
    caches = []
  }
}

/// Canonical external HTTP for the root's real SDK, workspace, draft and notification consumers.
private final class LifecycleHTTPFixture: Sendable {
  let history: ConversationHistoryFixture
  private let state = LifecycleHTTPState()
  var navigationWorkspaces: [String] { state.navigationWorkspaces.withLock { $0 } }

  init(
    beforeNavigation: (@Sendable () async -> Void)? = nil,
    beforeEventRows: (@Sendable (URLRequest) async throws -> Void)? = nil
  ) {
    let state = state
    history = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: beforeEventRows,
      detail: { request in
        if request.httpMethod == "PATCH" {
          let key = try Self.workspace(request) + request.url!.path + "/draft"
          state.drafts.withLock {
            $0[key] = String(decoding: chatRequestBody(request), as: UTF8.self)
          }
        }
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      },
      additional: { request in
        if let response = ModelHTTPFixtures.response(request.url!.path) { return response }
        switch request.url!.path {
        case "/api/agents":
          let workspace = try Self.workspace(request)
          state.navigationWorkspaces.withLock { $0.append(workspace) }
          await beforeNavigation?()
          return ChatHTTPResponse(
            body:
              "[{\"agentId\":\"\(ConversationHistoryFixture.agentID)\",\"displayName\":\"Lifecycle fixture\",\"isDefaultAgent\":true}]"
          )
        case "/api/indicators":
          return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
        case "/api/chat-thread-drafts":
          return ChatHTTPResponse(body: #"{"draftThreadIds":[]}"#)
        case "/api/projects/events":
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        case "/api/projects/snapshot":
          return ChatHTTPResponse(body: #"{"latestEventId":null,"latestSeqId":0,"projects":[]}"#)
        case "/api/agents/\(ConversationHistoryFixture.agentID)/draft",
          "/api/chat-threads/\(ConversationHistoryFixture.threadID)/draft":
          let key = try Self.workspace(request) + request.url!.path
          if request.httpMethod == "PATCH" {
            state.drafts.withLock {
              $0[key] = String(decoding: chatRequestBody(request), as: UTF8.self)
            }
          }
          return ChatHTTPResponse(
            body: state.drafts.withLock { $0[key] }
              ?? #"{"draftUserMessage":null,"draftAttachments":null}"#)
        case "/api/ios-notifications/reconcile":
          return ChatHTTPResponse(body: #"{"unreadCount":0,"badgeCount":0,"removeIdentifiers":[]}"#)
        case "/api/realtime/token":
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Fixture offline"}}"#)
        default: throw URLError(.unsupportedURL)
        }
      })
  }

  private static func workspace(_ request: URLRequest) throws -> String {
    let header = request.value(forHTTPHeaderField: "Authorization") ?? ""
    let pieces = header.split(separator: ".")
    guard pieces.count == 3 else { throw URLError(.userAuthenticationRequired) }
    var payload = String(pieces[1]).replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
    guard let data = Data(base64Encoded: payload) else {
      throw URLError(.userAuthenticationRequired)
    }
    return try JSONDecoder().decode(Claims.self, from: data).o.id
  }

  private struct Claims: Decodable {
    let o: Organization
    struct Organization: Decodable { let id: String }
  }
}

private final class LifecycleHTTPState: Sendable {
  let navigationWorkspaces = Mutex<[String]>([])
  let drafts = Mutex<[String: String]>([:])
}
