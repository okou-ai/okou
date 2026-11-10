import CCState
import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NavigationResourceTests: XCTestCase {
  func testNavigationFailureRetainsCachedAgentsAndRetryPersistsFreshData()
    async throws
  {
    let directory = CacheTestDirectory(owner: self)
    let phase = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      let current = phase.withLock { $0 }
      if current == 1, request.url?.path == "/api/agents" {
        return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
      }
      switch request.url?.path {
      case "/api/agents":
        return navigationAgents(name: current == 0 ? "Cached assistant" : "Fresh assistant")
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
    XCTAssertEqual(store.currentAgentName, "Cached assistant")
    let failed = try store.list.stateStore.get(store.list.navigationValue)
    guard case .failure(let error) = await failed.result else {
      return XCTFail("Cached navigation must not hide the current read failure")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    let reader = directory.cache(scope: scope)
    let retained = try await reader.loadNavigation()
    XCTAssertEqual(retained?.agents.first?.displayName, "Cached assistant")
    await reader.close()

    phase.withLock { $0 = 2 }
    await store.refreshNavigation()
    XCTAssertEqual(store.currentAgentName, "Fresh assistant")
    XCTAssertEqual(store.selectedAgentID, navigationAgent)
    let refreshed = try await store.list.stateStore.get(store.list.navigationValue).value
    XCTAssertEqual(refreshed.first?.displayName, "Fresh assistant")
    let reopened = directory.cache(scope: scope)
    let committed = try await reopened.loadNavigation()
    XCTAssertEqual(committed?.agents.first?.displayName, "Fresh assistant")
    await reopened.close()
  }

  func testRetiredWorkspaceResponsesPreserveEachWorkspacesCommittedNavigation() async throws {
    let directory = CacheTestDirectory(owner: self)
    let switching = Mutex(false)
    let started = expectation(description: "Old workspace responses are pending")
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
    XCTAssertTrue(fresh.list.agents.isEmpty)
    switching.withLock { $0 = false }
    await fresh.refreshNavigation()
    gate.open()
    await refresh.value
    XCTAssertEqual(old.currentAgentName, "Old assistant")
    XCTAssertEqual(fresh.currentAgentName, "Old assistant")
    let reader = directory.cache(scope: oldScope)
    let retained = try await reader.loadNavigation()
    XCTAssertEqual(retained?.agents.first?.displayName, "Old assistant")
    await reader.close()
  }

  func testDetachingOneNavigationConsumerDoesNotCancelAnotherConsumersRead() async throws {
    let began = expectation(description: "The shared Agent HTTP read is pending")
    let gate = NavigationResponseGate()
    let requests = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/agents" else { throw URLError(.unsupportedURL) }
      requests.withLock { $0 += 1 }
      began.fulfill()
      await gate.wait()
      return navigationAgents(name: "Shared assistant")
    }
    let resources = WorkspaceResources(client: fixture.client, sleep: { _ in })
    let sync = ChatSync(client: fixture.client)
    let commands = ChatCommands(client: fixture.client, sync: sync)
    let first = ThreadListStore(
      client: fixture.client, sync: sync, commands: commands, resources: resources,
      didRefresh: { _ in }, didFail: { XCTFail("Unexpected failure: \($0)") })
    let second = ThreadListStore(
      client: fixture.client, sync: sync, commands: commands, resources: resources,
      didRefresh: { _ in }, didFail: { XCTFail("Unexpected failure: \($0)") })
    let leaving = Task.immediate { await first.refreshNavigation() }
    let surviving = Task.immediate { await second.refreshNavigation() }
    addTeardownBlock { @MainActor in
      first.close()
      second.close()
      resources.close()
      leaving.cancel()
      surviving.cancel()
      gate.open()
      await leaving.value
      await surviving.value
    }
    await fulfillment(of: [began], timeout: 3)
    leaving.cancel()
    first.close()
    gate.open()
    await surviving.value
    await leaving.value

    XCTAssertEqual(second.agents.first?.displayName, "Shared assistant")
    XCTAssertTrue(first.agents.isEmpty)
    // This is the external HTTP deduplication contract, not a graph evaluation count.
    XCTAssertEqual(requests.withLock { $0 }, 1)
  }

  func testPermissionFailureRemainsVisibleAlongsideConfirmedNavigation() async throws {
    for status in [401, 403] {
      let denied = Mutex(false)
      let fixture = ChatHTTPFixture { request in
        guard request.url?.path == "/api/agents" else { throw URLError(.unsupportedURL) }
        if denied.withLock({ $0 }) {
          return ChatHTTPResponse(status: status, body: #"{"error":{"message":"Denied"}}"#)
        }
        return navigationAgents(name: "Confirmed assistant")
      }
      let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { workspace.close() }
      await workspace.refreshNavigation()
      denied.withLock { $0 = true }
      await workspace.refreshNavigation()

      XCTAssertEqual(workspace.currentAgentName, "Confirmed assistant")
      let current = try workspace.list.stateStore.get(workspace.list.navigationValue)
      guard case .failure(let error) = await current.result else {
        return XCTFail("An authorization failure must remain a failed resource")
      }
      XCTAssertEqual((error as? APIClientError)?.statusCode, status)
    }
  }

  func testUpgradeFailureRetiresCachedNavigationAndFutureReads() async throws {
    let obsolete = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/agents" else { throw URLError(.unsupportedURL) }
      if obsolete.withLock({ $0 }) {
        return ChatHTTPResponse(status: 426, body: #"{"error":{"message":"Update required"}}"#)
      }
      return navigationAgents(name: "Confirmed assistant")
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.refreshNavigation()
    obsolete.withLock { $0 = true }
    await workspace.refreshNavigation()

    XCTAssertTrue(workspace.needsUpgrade)
    XCTAssertThrowsError(try workspace.list.stateStore.get(workspace.list.navigationValue)) {
      XCTAssertTrue($0 is CancellationError)
    }
  }

  func testReloadFencesAnOlderReadFromTheConfirmedAndPersistedSnapshot() async throws {
    let directory = CacheTestDirectory(owner: self)
    let began = expectation(description: "The superseded Agent read is pending")
    let completed = expectation(description: "The superseded HTTP handler completed")
    let gate = NavigationResponseGate()
    let phase = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/agents" else { throw URLError(.unsupportedURL) }
      let old = phase.withLock { $0 == 0 }
      if old {
        began.fulfill()
        await gate.wait()
        completed.fulfill()
      }
      return navigationAgents(name: old ? "Old assistant" : "New assistant")
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "navigation-user", workspaceID: "reload-workspace")
    let sync = ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
    let resources = WorkspaceResources(client: fixture.client, sleep: { _ in })
    let list = ThreadListStore(
      client: fixture.client, sync: sync,
      commands: ChatCommands(client: fixture.client, sync: sync),
      resources: resources, didRefresh: { _ in },
      didFail: { XCTFail("Unexpected failure: \($0)") })
    let old = Task.immediate { await list.refreshNavigation() }
    addTeardownBlock { @MainActor in
      list.close()
      resources.close()
      old.cancel()
      gate.open()
      await old.value
    }
    await fulfillment(of: [began], timeout: 3)
    phase.withLock { $0 = 1 }
    try resources.store.set(resources.reloadNavigation)
    await list.refreshNavigation()
    gate.open()
    await fulfillment(of: [completed], timeout: 3)
    await old.value

    XCTAssertEqual(list.agents.first?.displayName, "New assistant")
    let reader = directory.cache(scope: scope)
    let snapshot = try await reader.loadNavigation()
    XCTAssertEqual(snapshot?.agents.first?.displayName, "New assistant")
    await reader.close()
  }

  func testClosedResourcesRejectPreviouslySuccessfulNavigation() async throws {
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/agents" else { throw URLError(.unsupportedURL) }
      return navigationAgents(name: "Confirmed assistant")
    }
    let resources = WorkspaceResources(client: fixture.client, sleep: { _ in })
    defer { resources.close() }
    let confirmed = try await resources.store.get(resources.navigation).value
    XCTAssertEqual(confirmed.first?.displayName, "Confirmed assistant")

    resources.close()

    XCTAssertThrowsError(try resources.store.get(resources.navigation)) {
      XCTAssertTrue($0 is CancellationError)
    }
  }

  func testClosingResourcesNotifiesConsumersAndCancelsPendingAndFutureReads() async throws {
    let began = expectation(description: "Agent read started")
    let cancelled = expectation(description: "The original HTTP request was cancelled")
    let gate = NavigationResponseGate()
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/agents" else { throw URLError(.unsupportedURL) }
      began.fulfill()
      await withTaskCancellationHandler {
        await gate.wait()
      } onCancel: {
        cancelled.fulfill()
      }
      return navigationAgents(name: "Retired assistant")
    }
    let resources = WorkspaceResources(client: fixture.client, sleep: { _ in })
    let retired = expectation(description: "A mounted resource observes retirement")
    let subscription = try resources.store.watch(resources.navigation) {
      do {
        _ = try resources.store.get(resources.navigation)
        XCTFail("A retired workspace must not supply another navigation Task")
      } catch is CancellationError {
        retired.fulfill()
      }
    }
    let pending = try resources.store.get(resources.navigation)
    addTeardownBlock { @MainActor in
      resources.close()
      try subscription.cancel()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [began], timeout: 3)
    resources.close()
    await fulfillment(of: [retired, cancelled], timeout: 3)
    gate.open()
    guard case .failure = await pending.result else {
      return XCTFail("The retired read must not publish late success")
    }
    XCTAssertThrowsError(try resources.store.get(resources.navigation))
    XCTAssertThrowsError(try resources.store.set(resources.reloadNavigation))
    XCTAssertThrowsError(try resources.invalidate([.reconnected]))
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
