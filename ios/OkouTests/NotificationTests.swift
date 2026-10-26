import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import UIKit
import UserNotifications
import XCTest

@testable import Okou

@MainActor
final class NotificationTests: XCTestCase {
  func testPermissionIsExplicitAndTheDelegateRegistersTheCurrentTokenWithIncreasingRevisions()
    async throws
  {
    let writes = Mutex<[(String, Data)]>([])
    let registered = expectation(description: "OS token registered through canonical API")
    let fixture = ConversationHistoryFixture(additional: { request in
      if request.url?.path == "/api/ios-push-registrations" {
        writes.withLock { $0.append((request.httpMethod!, chatRequestBody(request))) }
        if request.httpMethod == "POST" { registered.fulfill() }
        return ChatHTTPResponse(body: #"{"success":true}"#)
      }
      throw URLError(.unsupportedURL)
    })
    let system = NotificationSystemFixture()
    let service = notifications(system: system)
    await service.update(workspace: workspace(fixture))
    XCTAssertEqual(system.prompts, 0)
    await service.enable()
    XCTAssertEqual(system.prompts, 1)
    let delegate = NotificationAppDelegate(notifications: service)
    delegate.application(
      UIApplication.shared,
      didRegisterForRemoteNotificationsWithDeviceToken: Data(repeating: 0xab, count: 32))
    await fulfillment(of: [registered], timeout: 3)
    system.status = .denied
    await service.refreshRegistration()
    let observed = writes.withLock { $0 }
    XCTAssertEqual(observed.map(\.0), ["POST", "DELETE"])
    let bodies = try observed.map { try JSONDecoder().decode(Registration.self, from: $0.1) }
    XCTAssertEqual(bodies[0].deviceToken, String(repeating: "ab", count: 32))
    XCTAssertEqual(bodies[0].environment, "production")
    XCTAssertEqual(bodies[0].installationId, bodies[1].installationId)
    XCTAssertGreaterThan(bodies[1].revision, bodies[0].revision)
  }

  func testBackgroundDelegatePersistsAuthoritativeHistoryForOfflineReopenWithoutMarkingRead()
    async throws
  {
    let fixture = ConversationHistoryFixture(count: 2)
    let http = fixture.http
    let directory = directory()
    let scope = ChatCacheScope(
      apiBaseURL: http.baseURL, userID: "user_push", workspaceID: "org_push")
    let sync = ChatSync(client: http.client, cache: ChatCache(scope: scope, directory: directory))
    let service = notifications()
    await service.update(
      workspace: NotificationWorkspace(
        scopeID: "session_push", userID: "user_push", workspaceID: "org_push", client: http.client,
        sync: sync))
    let complete = expectation(description: "Background callback completed")
    NotificationAppDelegate(notifications: service).application(
      UIApplication.shared, didReceiveRemoteNotification: payload()
    ) { result in
      XCTAssertEqual(result, .newData)
      complete.fulfill()
    }
    await fulfillment(of: [complete], timeout: 3)
    // Simulate an existing cache's protection policy before reopening it with the new build.
    let cacheDirectory = directory.appending(path: "ChatCache")
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.complete], ofItemAtPath: cacheDirectory.path)
    for file in try FileManager.default.contentsOfDirectory(
      at: cacheDirectory, includingPropertiesForKeys: nil)
    {
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete], ofItemAtPath: file.path)
    }
    let reopened = ChatSync(
      client: http.client, cache: ChatCache(scope: scope, directory: directory))
    let history = await reopened.cachedHistory(threadID: ConversationHistoryFixture.threadID)
    XCTAssertEqual(history?.messages.count, 2)
    XCTAssertTrue(history?.messages.last?.text.contains("Message 2") == true)
    XCTAssertFalse(fixture.requests.values.withLock { $0.contains { $0.contains("mark-read") } })
  }

  func testAccountReplacementCancelsBackgroundWorkAndOtherWorkspacesAreDeferred() async throws {
    let started = expectation(description: "Background snapshot request")
    let gate = AuthenticationRequestGate()
    await gate.hold()
    addTeardownBlock { await gate.releaseAll() }
    let fixture = ConversationHistoryFixture(
      snapshot: { _ in
        started.fulfill()
        await gate.enter()
        try Task.checkCancellation()
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      })
    let service = notifications()
    await service.update(workspace: workspace(fixture))
    let elsewhere = try XCTUnwrap(
      NotificationDestination(userInfo: payload(workspace: "org_elsewhere")))
    let deferred = await service.synchronize(elsewhere)
    XCTAssertFalse(deferred)
    let destination = try XCTUnwrap(NotificationDestination(userInfo: payload()))
    let work = Task { await service.synchronize(destination) }
    addTeardownBlock {
      work.cancel()
      _ = await work.value
    }
    await fulfillment(of: [started], timeout: 3)
    await service.update(workspace: nil)
    await gate.releaseAll()
    let updated = await work.value
    XCTAssertFalse(updated)
    XCTAssertFalse(fixture.requests.values.withLock { $0.contains { $0.contains("mark-read") } })
  }

  func testRetainedConversationPublishesPrefetchedMessagesBeforeForegroundHTTPCompletes()
    async throws
  {
    let holdNetwork = Mutex(false)
    let networkStarted = expectation(description: "Foreground catch-up is held")
    let release = AuthenticationRequestGate()
    await release.hold()
    addTeardownBlock { await release.releaseAll() }
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        if holdNetwork.withLock({ $0 }) {
          networkStarted.fulfill()
          await release.enter()
        }
      })
    let data = workspace(fixture)
    let conversation = fixture.conversation(sharedSync: data.sync, isVisible: { false })
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.count, 2)
    fixture.appendMessage()
    fixture.appendMessage()
    let service = notifications()
    await service.update(workspace: data)
    let destination = try XCTUnwrap(NotificationDestination(userInfo: payload()))
    let synchronized = await service.synchronize(destination)
    XCTAssertTrue(synchronized)
    holdNetwork.withLock { $0 = true }
    let refreshing = Task { await conversation.refresh() }
    addTeardownBlock {
      refreshing.cancel()
      await release.releaseAll()
      await refreshing.value
    }
    await fulfillment(of: [networkStarted], timeout: 3)
    XCTAssertEqual(conversation.messages.count, 4)
    XCTAssertTrue(conversation.messages.last?.text.contains("Message 4") == true)
    await release.releaseAll()
    await refreshing.value
  }

  func testColdTapWaitsForMembershipAndWorkspaceStartupAndRejectsAnotherAccount() async throws {
    let identity = try AuthenticationHTTPFixture()
    addTeardownBlock { await identity.close() }
    identity.state.withLock {
      $0.workspaceIDs = ["org_one", "org_two"]
      $0.activeWorkspaceID = nil
    }
    let authentication = try await identity.authentication()
    addTeardownBlock { try? await authentication.signOut() }
    let service = notifications()
    let chat = ChatLinkFixture()
    let initial = chat.workspace()
    defer { initial.close() }
    let userID = identity.state.withLock { $0.userID }
    let destination = try XCTUnwrap(
      NotificationDestination(
        userInfo: payload(
          user: userID, workspace: "org_two", thread: ChatLinkFixture.sourceID,
          run: ChatLinkFixture.runID(1))))
    service.receiveTap(destination)
    await service.openPending(authentication: authentication, store: initial)
    XCTAssertNil(initial.selectedThreadID)
    await authentication.refresh()
    XCTAssertNil(authentication.activeWorkspaceID)
    service.preparePending(authentication: authentication)
    await service.openPending(authentication: authentication, store: initial)
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    XCTAssertNil(initial.selectedThreadID)
    let target = chat.workspace()
    defer { target.close() }
    await service.update(
      workspace: NotificationWorkspace(
        scopeID: "second", userID: userID, workspaceID: "org_two", client: identity.api.client,
        sync: ChatSync(client: identity.api.client)))
    await service.openPending(authentication: authentication, store: target)
    XCTAssertEqual(target.selectedThreadID, ChatLinkFixture.sourceID)
    service.receiveTap(
      try XCTUnwrap(
        NotificationDestination(userInfo: payload(user: "different_account", workspace: "org_one")))
    )
    await service.openPending(authentication: authentication, store: target)
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
    service.receiveTap(
      try XCTUnwrap(
        NotificationDestination(userInfo: payload(user: userID, workspace: "org_unavailable"))))
    await service.openPending(authentication: authentication, store: target)
    XCTAssertEqual(authentication.activeWorkspaceID, "org_two")
  }

  private func notifications(system: NotificationSystemFixture = NotificationSystemFixture())
    -> NotificationService
  {
    let suite = "notification-tests-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
    return NotificationService(system: system, defaults: defaults)
  }

  private func directory() -> URL {
    let directory = FileManager.default.temporaryDirectory.appending(
      path: "notification-tests-" + UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return directory
  }

  private func workspace(_ fixture: ConversationHistoryFixture) -> NotificationWorkspace {
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user_push", workspaceID: "org_push")
    return NotificationWorkspace(
      scopeID: "session_push", userID: "user_push", workspaceID: "org_push",
      client: fixture.http.client,
      sync: ChatSync(
        client: fixture.http.client, cache: ChatCache(scope: scope, directory: directory())))
  }

  private func payload(
    user: String = "user_push", workspace: String = "org_push",
    thread: String = ConversationHistoryFixture.threadID,
    run: String = "60000000-0000-4000-8000-000000000003"
  ) -> [AnyHashable: Any] {
    [
      "okou": [
        "version": 1, "userId": user, "workspaceId": workspace, "threadId": thread, "runId": run,
        "notificationId": run + ":completed",
      ]
    ]
  }

  private struct Registration: Decodable {
    let installationId: String
    let revision: Int
    let deviceToken: String?
    let environment: String?
  }
}

@MainActor
private final class NotificationSystemFixture: NotificationSystem {
  var status = UNAuthorizationStatus.notDetermined
  var prompts = 0
  let environment: String? = "production"
  func authorizationStatus() async -> UNAuthorizationStatus { status }
  func requestAuthorization() async throws -> Bool {
    prompts += 1
    status = .authorized
    return true
  }
  func register() {}
  func openSettings() async {}
}
