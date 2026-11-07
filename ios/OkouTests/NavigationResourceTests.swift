import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NavigationResourceTests: XCTestCase {
  func testNavigationLoadsAgentsAndPreferencesTogether() async {
    let started = expectation(description: "Both navigation responses are pending")
    started.expectedFulfillmentCount = 2
    let gate = NavigationResponseGate()
    defer { gate.open() }
    let fixture = ChatHTTPFixture { request in
      started.fulfill()
      await gate.wait()
      switch request.url?.path {
      case "/api/agents": return navigationAgents(name: "Current assistant")
      case "/api/user-preferences": return navigationPreferences(pinned: true)
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let refresh = Task { await store.refreshNavigation() }
    addTeardownBlock { @MainActor in
      store.close()
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [started], timeout: 3)
    gate.open()
    await refresh.value
    XCTAssertEqual(store.currentAgentName, "Current assistant")
    XCTAssertEqual(
      store.list.visiblePinnedAgents.map(\.agentId), [navigationAgent, navigationPinned])
    XCTAssertNil(store.list.navigationError)
  }

  func testPartialNavigationFailureRetainsSuccessfulDataAndRetryCommitsACompleteSnapshot()
    async throws
  {
    for failingPath in ["/api/agents", "/api/user-preferences"] {
      let directory = CacheTestDirectory(owner: self)
      let phase = Mutex(0)
      let fixture = ChatHTTPFixture { request in
        let current = phase.withLock { $0 }
        if current == 1, request.url?.path == failingPath {
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
        }
        switch request.url?.path {
        case "/api/agents":
          return navigationAgents(name: current == 0 ? "Cached assistant" : "Fresh assistant")
        case "/api/user-preferences": return navigationPreferences(pinned: current == 0)
        default: throw URLError(.unsupportedURL)
        }
      }
      let scope = ChatCacheScope(
        apiBaseURL: fixture.baseURL, userID: "navigation-user", workspaceID: "navigation-workspace")
      let store = WorkspaceStore(
        client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope),
        readRetrySleep: { _ in })
      defer { store.close() }
      await store.refreshNavigation()
      phase.withLock { $0 = 1 }
      await store.refreshNavigation()
      XCTAssertEqual(
        store.currentAgentName,
        failingPath == "/api/agents" ? "Cached assistant" : "Fresh assistant")
      XCTAssertEqual(
        store.list.visiblePinnedAgents.map(\.agentId),
        failingPath == "/api/user-preferences"
          ? [navigationAgent, navigationPinned] : [navigationAgent])
      XCTAssertNotNil(store.list.navigationError)
      let reader = directory.cache(scope: scope)
      let retained = try await reader.loadNavigation()
      XCTAssertEqual(retained?.agents.first?.displayName, "Cached assistant")
      XCTAssertEqual(retained?.preferences.pinnedAgentIds, [navigationPinned])
      await reader.close()

      phase.withLock { $0 = 2 }
      await store.refreshNavigation()
      XCTAssertEqual(store.currentAgentName, "Fresh assistant")
      XCTAssertEqual(store.list.visiblePinnedAgents.map(\.agentId), [navigationAgent])
      XCTAssertNil(store.list.navigationError)
      let reopened = directory.cache(scope: scope)
      let committed = try await reopened.loadNavigation()
      XCTAssertEqual(committed?.agents.first?.displayName, "Fresh assistant")
      XCTAssertEqual(committed?.preferences.pinnedAgentIds, [])
      await reopened.close()
    }
  }

  func testMissingPreferencesClearCachedPinsAndPersistFreshAgents() async throws {
    let directory = CacheTestDirectory(owner: self)
    let missingPreferences = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      let missing = missingPreferences.withLock { $0 }
      switch request.url?.path {
      case "/api/agents":
        return navigationAgents(name: missing ? "Fresh assistant" : "Cached assistant")
      case "/api/user-preferences":
        return missing
          ? ChatHTTPResponse(status: 409, body: #"{"error":{"message":"No preferences yet"}}"#)
          : navigationPreferences(pinned: true)
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "navigation-user", workspaceID: "navigation-workspace")
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope))
    defer { store.close() }
    await store.refreshNavigation()
    missingPreferences.withLock { $0 = true }
    await store.refreshNavigation()
    XCTAssertEqual(store.currentAgentName, "Fresh assistant")
    XCTAssertEqual(store.list.visiblePinnedAgents.map(\.agentId), [navigationAgent])
    XCTAssertNil(store.list.navigationError)
    let reopened = directory.cache(scope: scope)
    let persisted = try await reopened.loadNavigation()
    XCTAssertEqual(persisted?.agents.first?.displayName, "Fresh assistant")
    XCTAssertEqual(persisted?.preferences.pinnedAgentIds, [])
    await reopened.close()
  }

  func testRetiredWorkspaceResponsesPreserveEachWorkspacesCommittedNavigation() async throws {
    let directory = CacheTestDirectory(owner: self)
    let switching = Mutex(false)
    let started = expectation(description: "Old workspace responses are pending")
    started.expectedFulfillmentCount = 2
    let gate = NavigationResponseGate()
    defer { gate.open() }
    let fixture = ChatHTTPFixture { request in
      let late = switching.withLock { $0 }
      if late {
        started.fulfill()
        await gate.wait()
      }
      switch request.url?.path {
      case "/api/agents": return navigationAgents(name: late ? "Late assistant" : "Old assistant")
      case "/api/user-preferences": return navigationPreferences(pinned: !late)
      default: throw URLError(.unsupportedURL)
      }
    }
    let oldScope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "navigation-user", workspaceID: "old-workspace")
    let old = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: oldScope))
    defer { old.close() }
    await old.refreshNavigation()
    switching.withLock { $0 = true }
    let refresh = Task { await old.refreshNavigation() }
    addTeardownBlock { @MainActor in
      old.close()
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [started], timeout: 3)
    old.close()
    let freshScope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "navigation-user", workspaceID: "fresh-workspace")
    let fresh = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: freshScope))
    defer { fresh.close() }
    await fresh.list.restoreCached()
    XCTAssertTrue(fresh.list.visiblePinnedAgents.isEmpty)
    switching.withLock { $0 = false }
    await fresh.refreshNavigation()
    gate.open()
    await refresh.value
    XCTAssertEqual(old.currentAgentName, "Old assistant")
    XCTAssertEqual(
      fresh.list.visiblePinnedAgents.map(\.agentId), [navigationAgent, navigationPinned])
    let reader = directory.cache(scope: oldScope)
    let retained = try await reader.loadNavigation()
    XCTAssertEqual(retained?.agents.first?.displayName, "Old assistant")
    XCTAssertEqual(retained?.preferences.pinnedAgentIds, [navigationPinned])
    await reader.close()
  }
}

private let navigationAgent = "50000000-0000-4000-8000-000000000001"
private let navigationPinned = "50000000-0000-4000-8000-000000000002"

private func navigationAgents(name: String) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: """
      [{"agentId":"\(navigationAgent)","isDefaultAgent":true,"displayName":"\(name)"},
      {"agentId":"\(navigationPinned)","isDefaultAgent":false,"displayName":"Pinned assistant"}]
      """)
}

private func navigationPreferences(pinned: Bool) -> ChatHTTPResponse {
  ChatHTTPResponse(body: "{\"pinnedAgentIds\":\(pinned ? "[\"\(navigationPinned)\"]" : "[]")}")
}

private final class NavigationResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func open() { continuation.finish() }

  func wait() async {
    for await _ in stream { return }
  }
}
