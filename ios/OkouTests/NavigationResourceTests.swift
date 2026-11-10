import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NavigationResourceTests: XCTestCase {
  func testProjectLoadingAndFailureKeepCachedProjectsAndIndependentChatsUsable() async throws {
    let phase = Mutex(0)
    let hold = Mutex(false)
    let started = expectation(description: "Project request pending independently of chats")
    let gate = NavigationResponseGate()
    let projectID = "50000000-0000-4000-8000-000000000071"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/projects":
        let current = phase.withLock { $0 }
        let shouldHold = hold.withLock {
          let pending = $0
          $0 = false
          return pending
        }
        if shouldHold {
          started.fulfill()
          await gate.wait()
        }
        if current == 1 {
          return ChatHTTPResponse(
            status: 503, body: #"{"error":{"message":"Projects unavailable"}}"#)
        }
        return ChatHTTPResponse(
          body: """
            {"projects":[{"id":"\(projectID)","name":"\(current == 0 ? "Cached" : "Fresh")","createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z"}]}
            """)
      case "/api/agents": return navigationAgents(name: "Independent assistant")
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(navigationPinned)","agentId":"\(navigationAgent)","title":"Independent chat","projectId":"\(projectID)","createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z","sortAt":"2026-11-09T01:00:00Z"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "navigation-user", workspaceID: "project-recovery")
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope),
      readRetrySleep: { _ in })
    defer { store.close() }
    await store.projects.activate()
    phase.withLock { $0 = 1 }
    hold.withLock { $0 = true }
    let refresh = Task { await store.projects.refresh() }
    addTeardownBlock { @MainActor in
      store.close()
      refresh.cancel()
      gate.open()
      await refresh.value
    }
    await fulfillment(of: [started], timeout: 3)
    await store.refreshNavigation()
    await store.list.refresh()
    XCTAssertEqual(store.currentAgentName, "Independent assistant")
    XCTAssertEqual(store.list.threads.first?.title, "Independent chat")
    XCTAssertEqual(store.projects.projects.first?.name, "Cached")
    gate.open()
    await refresh.value
    let failed = try store.projects.stateStore.get(store.projects.value)
    do {
      _ = try await failed.value
      XCTFail("The original Project resource must retain its error")
    } catch { XCTAssertEqual((error as? APIClientError)?.statusCode, 503) }
    XCTAssertEqual(store.projects.projects.first?.name, "Cached")
    phase.withLock { $0 = 2 }
    await store.projects.refresh()
    let recovered = try await store.projects.stateStore.get(store.projects.value).value
    XCTAssertEqual(recovered.first?.name, "Fresh")
    let reader = directory.cache(scope: scope)
    let persisted = try await reader.loadProjects()
    XCTAssertEqual(persisted, recovered)
    await reader.close()
  }

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
    XCTAssertNotNil(store.list.navigationError)
    let reader = directory.cache(scope: scope)
    let retained = try await reader.loadNavigation()
    XCTAssertEqual(retained?.agents.first?.displayName, "Cached assistant")
    await reader.close()

    phase.withLock { $0 = 2 }
    await store.refreshNavigation()
    XCTAssertEqual(store.currentAgentName, "Fresh assistant")
    XCTAssertEqual(store.selectedAgentID, navigationAgent)
    XCTAssertNil(store.list.navigationError)
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
