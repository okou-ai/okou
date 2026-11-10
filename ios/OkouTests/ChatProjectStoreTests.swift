import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatProjectStoreTests: XCTestCase {
  private static let project = "30000000-0000-4000-8000-000000000071"

  func testExplicitRenameRetryKeepsItsIdentityAndPublishesTheConfirmedName() async throws {
    struct Server: Sendable {
      var name = "Launch"
      var writes: [String] = []
    }
    let server = Mutex(Server())
    let projectID = Self.project
    let fixture = ChatHTTPFixture { request in
      let record: @Sendable (String) -> String = { name in
        "{\"id\":\"\(projectID)\",\"name\":\"\(name)\",\"createdAt\":\"2026-11-09T01:00:00Z\",\"updatedAt\":\"2026-11-09T01:00:00Z\"}"
      }
      if request.httpMethod == "PATCH" {
        let body = try JSONDecoder().decode(RenameBody.self, from: chatRequestBody(request))
        let fail = server.withLock {
          $0.writes.append(body.eventId)
          if $0.writes.count == 1 { return true }
          $0.name = body.name
          return false
        }
        if fail {
          return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try again\"}}")
        }
        return ChatHTTPResponse(body: record(body.name))
      }
      guard request.url?.path == "/api/projects" else { throw URLError(.unsupportedURL) }
      return ChatHTTPResponse(body: "{\"projects\":[\(record(server.withLock { $0.name }))]}")
    }
    let resources = WorkspaceResources(client: fixture.client, sleep: { _ in })
    let store = ChatProjectStore(
      client: fixture.client, resources: resources,
      sync: ChatSync(client: fixture.client), didFail: { _ in }, didChangeMembership: {})
    defer {
      store.close()
      resources.close()
    }
    await store.activate()
    let failed = await store.rename(Self.project, name: "Release")
    XCTAssertFalse(failed)
    XCTAssertEqual(store.projects.first?.name, "Launch")
    XCTAssertEqual(server.withLock { $0.writes.count }, 1)
    let saved = await store.rename(Self.project, name: "Release")
    XCTAssertTrue(saved)
    XCTAssertEqual(store.projects.first?.name, "Release")
    let writes = server.withLock { $0.writes }
    XCTAssertEqual(writes.count, 2)
    XCTAssertEqual(writes.first, writes.last)
    XCTAssertNil(store.actionError)
  }

  func testWorkspaceSidebarFiltersCrossAgentProjectsAndKeepsNativeDisclosure() async throws {
    let fixture = SidebarFixture()
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    await workspace.projects.activate()
    let sidebar = workspace.sidebar
    XCTAssertEqual(
      sidebar.contents.projects.map(\.id), [SidebarFixture.project, SidebarFixture.empty])
    XCTAssertEqual(sidebar.contents.projects.first?.threads.map(\.id), [SidebarFixture.id(2)])
    XCTAssertEqual(
      sidebar.contents.threads.map(\.id), [SidebarFixture.id(5), SidebarFixture.id(1)])
    workspace.projects.expand(SidebarFixture.project)

    sidebar.selectFilter(.unread)
    XCTAssertEqual(sidebar.filter, .unread)
    XCTAssertEqual(
      sidebar.contents.projects.first?.threads.map(\.id),
      [SidebarFixture.id(3), SidebarFixture.id(2)])
    XCTAssertEqual(sidebar.contents.projects.first?.marker, .unread)
    XCTAssertEqual(sidebar.contents.threads.map(\.id), [SidebarFixture.id(1)])
    XCTAssertEqual(
      sidebar.recentSearchThreads.map(\.id), [SidebarFixture.id(3), SidebarFixture.id(1)])

    sidebar.selectFilter(.muted)
    XCTAssertEqual(sidebar.contents.projects.first?.threads.map(\.id), [SidebarFixture.id(4)])
    XCTAssertEqual(sidebar.contents.projects.first?.marker, .running)
    XCTAssertEqual(sidebar.contents.threads.map(\.id), [SidebarFixture.id(5)])
    XCTAssertEqual(sidebar.contents.threads.first?.marker, .pinned)

    sidebar.selectFilter(.archived)
    XCTAssertEqual(
      sidebar.contents.projects.first?.threads.map(\.id),
      [SidebarFixture.id(4), SidebarFixture.id(3)])
    XCTAssertEqual(sidebar.contents.projects.first?.marker, .running)
    XCTAssertTrue(sidebar.contents.threads.isEmpty)
    XCTAssertTrue(workspace.projects.isExpanded(SidebarFixture.project))
    workspace.projects.toggle(SidebarFixture.project)
    XCTAssertFalse(workspace.projects.isExpanded(SidebarFixture.project))

    sidebar.selectFilter(.recent)
    workspace.selectChat(SidebarFixture.id(6))
    XCTAssertEqual(sidebar.contents.threads.map(\.id), [SidebarFixture.id(6)])
    XCTAssertEqual(sidebar.contents.projects.first?.threads.map(\.id), [SidebarFixture.id(2)])
    workspace.startNewChat()
    XCTAssertEqual(
      sidebar.contents.threads.map(\.id), [SidebarFixture.id(5), SidebarFixture.id(1)])
    workspace.newChatDraft = "Unrelated composer input"
    XCTAssertEqual(sidebar.filter, .recent)
    XCTAssertEqual(sidebar.contents.projects.first?.threads.map(\.id), [SidebarFixture.id(2)])
  }

  func testSidebarKeepsChatsReachableAfterProjectFailureAndRegroupsOnRetry() async throws {
    let started = expectation(description: "Project retry reached HTTP")
    let gate = SidebarResponseGate()
    defer { gate.open() }
    let fixture = SidebarFixture(onHeldProjectRead: { started.fulfill() })
    fixture.unavailable.withLock { $0 = true }
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    await workspace.projects.activate()
    XCTAssertNotNil(workspace.projects.readError)
    XCTAssertTrue(workspace.sidebar.contents.projects.isEmpty)
    XCTAssertEqual(
      workspace.sidebar.contents.threads.map(\.id), [SidebarFixture.id(5), SidebarFixture.id(1)])
    workspace.sidebar.selectFilter(.unread)
    XCTAssertEqual(
      workspace.sidebar.contents.threads.map(\.id), [SidebarFixture.id(3), SidebarFixture.id(1)])

    fixture.unavailable.withLock { $0 = false }
    fixture.projectGate.withLock { $0 = gate }
    let retry = Task { await workspace.projects.refresh() }
    addTeardownBlock { @MainActor in
      workspace.close()
      retry.cancel()
      gate.open()
      await retry.value
    }
    await fulfillment(of: [started], timeout: 3)
    workspace.sidebar.selectFilter(.muted)
    XCTAssertEqual(workspace.sidebar.contents.threads.map(\.id), [SidebarFixture.id(5)])
    gate.open()
    await retry.value
    XCTAssertNil(workspace.projects.readError)
    XCTAssertEqual(workspace.sidebar.filter, .muted)
    XCTAssertEqual(
      workspace.sidebar.contents.projects.first?.threads.map(\.id), [SidebarFixture.id(4)])
    XCTAssertEqual(workspace.sidebar.contents.threads.map(\.id), [SidebarFixture.id(5)])
  }

  func testClosingWorkspaceCancelsTheProjectReadAndFencesSidebarPublication() async throws {
    let started = expectation(description: "Project read reached HTTP")
    let cancelled = expectation(description: "Original Project HTTP observed cancellation")
    let gate = SidebarResponseGate()
    defer { gate.open() }
    let fixture = SidebarFixture(
      onHeldProjectRead: { started.fulfill() },
      onCancelledProjectRead: { cancelled.fulfill() })
    fixture.projectGate.withLock { $0 = gate }
    let workspace = fixture.workspace()
    defer { workspace.close() }
    let read = Task { await workspace.projects.activate() }
    addTeardownBlock { @MainActor in
      workspace.close()
      read.cancel()
      gate.open()
      await read.value
    }
    await fulfillment(of: [started], timeout: 3)
    workspace.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await read.value
    workspace.sidebar.selectFilter(.unread)
    XCTAssertEqual(workspace.sidebar.filter, .recent)
    XCTAssertTrue(workspace.sidebar.contents.projects.isEmpty)

    let next = fixture.workspace()
    defer { next.close() }
    await next.projects.activate()
    XCTAssertEqual(
      next.sidebar.contents.projects.map(\.id), [SidebarFixture.project, SidebarFixture.empty])
    XCTAssertEqual(next.sidebar.filter, .recent)
  }

  private struct RenameBody: Decodable {
    let eventId: String
    let name: String
  }
}

/// External HTTP supplies membership and names independently, as in the production sync path.
private final class SidebarFixture: Sendable {
  static let project = "30000000-0000-4000-8000-000000000071"
  static let empty = "30000000-0000-4000-8000-000000000072"
  static let agent = "30000000-0000-4000-8000-000000000081"
  static let otherAgent = "30000000-0000-4000-8000-000000000082"
  let unavailable: Mutex<Bool>
  let http: ChatHTTPFixture
  let projectGate: Mutex<SidebarResponseGate?>

  init(
    onHeldProjectRead: @escaping @Sendable () -> Void = {},
    onCancelledProjectRead: @escaping @Sendable () -> Void = {}
  ) {
    let unavailable = Mutex(false)
    self.unavailable = unavailable
    let projectGate = Mutex<SidebarResponseGate?>(nil)
    self.projectGate = projectGate
    http = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(Self.agent)\",\"isDefaultAgent\":true},{\"agentId\":\"\(Self.otherAgent)\",\"isDefaultAgent\":false}]"
        )
      case "/api/agents/\(Self.agent)/draft":
        return ChatHTTPResponse(body: "{\"draftUserMessage\":null,\"draftAttachments\":null}")
      case "/api/projects":
        let gate = projectGate.withLock { value in
          let gate = value
          value = nil
          return gate
        }
        if let gate {
          onHeldProjectRead()
          await gate.wait()
          if Task.isCancelled { onCancelledProjectRead() }
        }
        if unavailable.withLock({ $0 }) {
          return ChatHTTPResponse(
            status: 503, body: "{\"error\":{\"message\":\"Project names unavailable\"}}")
        }
        let projects = [Self.project, Self.empty].map {
          "{\"id\":\"\($0)\",\"name\":\"Launch\",\"createdAt\":\"2026-11-09T01:00:00Z\",\"updatedAt\":\"2026-11-09T01:00:00Z\"}"
        }.joined(separator: ",")
        return ChatHTTPResponse(body: "{\"projects\":[\(projects)]}")
      case "/api/chat-threads/snapshot":
        let threads = (1...6).map { index in
          let project = (2...4).contains(index) ? "\"\(Self.project)\"" : "null"
          let agent = index == 2 || index == 4 || index == 6 ? Self.otherAgent : Self.agent
          return """
            {"id":"\(Self.id(index))","agentId":"\(agent)","title":"Chat \(index)","projectId":\(project),"archived":\(index == 3 || index == 4),"muted":\(index == 4 || index == 5),"createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z","sortAt":"2026-11-09T01:00:00Z","pinnedAt":\(index == 5 ? "\"2026-11-09T01:00:00Z\"" : "null"),"pinOrder":\(index == 5 ? "\"a0\"" : "null")}
            """
        }.joined(separator: ",")
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(
          body: """
            {"agents":{},"threads":{"\(Self.id(1))":"unread","\(Self.id(2))":"unread","\(Self.id(3))":"unread","\(Self.id(4))":"active"},"unreadAt":{"\(Self.id(1))":"2026-11-09T01:00:00Z","\(Self.id(2))":"2026-11-09T01:00:00Z","\(Self.id(3))":"2026-11-09T01:00:00Z"}}
            """)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func workspace() -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL, readRetrySleep: { _ in })
  }

  static func id(_ index: Int) -> String { String(format: "30000000-0000-4000-8000-%012d", index) }
}

private final class SidebarResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func wait() async { for await _ in stream { break } }
  func open() {
    continuation.yield()
    continuation.finish()
  }
}
