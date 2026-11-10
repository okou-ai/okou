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
  private static let thread = "30000000-0000-4000-8000-000000000001"
  private static let agent = "30000000-0000-4000-8000-000000000002"

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
    let store = ChatProjectStore(
      client: fixture.client,
      sync: ChatSync(client: fixture.client), didFail: { _ in }, didChangeMembership: {})
    defer {
      store.close()
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

  func testProjectsCollectOtherAgentsAndRespectUnreadAndArchiveFilters() async throws {
    let projectID = Self.project
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(
        body:
          "{\"projects\":[{\"id\":\"\(projectID)\",\"name\":\"Launch\",\"createdAt\":\"2026-11-09T01:00:00Z\",\"updatedAt\":\"2026-11-09T01:00:00Z\"}]}"
      )
    }
    let projects = try await ChatProjects(client: fixture.client).list()
    let ordinary = thread("ordinary", agent: Self.agent)
    var member = thread("member", agent: "another-agent")
    member.projectId = Self.project
    member.indicator = .unread
    var archived = thread("archived", agent: Self.agent)
    archived.projectId = Self.project
    archived.isArchived = true
    let threads = [ordinary, member, archived]
    let normal = ChatListContents(
      projects: projects, threads: threads, agentID: Self.agent,
      onlyUnread: false, archived: false, muted: false)
    XCTAssertEqual(normal.threads.map(\.id), [ordinary.id])
    XCTAssertEqual(normal.projects.first?.threads.map(\.id), [member.id])
    let unread = ChatListContents(
      projects: projects, threads: threads, agentID: Self.agent,
      onlyUnread: true, archived: false, muted: false)
    XCTAssertEqual(unread.projects.first?.threads.map(\.id), [member.id])
    XCTAssertTrue(unread.threads.isEmpty)
    let archive = ChatListContents(
      projects: projects, threads: threads, agentID: Self.agent,
      onlyUnread: false, archived: true, muted: false)
    XCTAssertEqual(archive.projects.first?.threads.map(\.id), [archived.id])
    let unresolved = ChatListContents(
      projects: [], threads: [archived, ordinary], agentID: Self.agent,
      onlyUnread: false, archived: true, muted: false)
    XCTAssertEqual(unresolved.threads.map(\.id), [archived.id])
  }

  func testCancellingAWaiterKeepsTheSharedProjectReadAndConfirmedCache() async throws {
    let started = expectation(description: "Shared Project request started")
    let gate = ProjectResponseGate()
    let projectID = Self.project
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/projects" else { throw URLError(.unsupportedURL) }
      started.fulfill()
      await gate.wait()
      return projectListResponse(name: "Shared", id: projectID)
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "project-reader", workspaceID: "shared-projects")
    let store = ChatProjectStore(
      client: fixture.client,
      sync: ChatSync(client: fixture.client, cache: directory.cache(scope: scope)),
      didFail: { _ in }, didChangeMembership: {})
    defer { store.close() }
    let read = try store.stateStore.get(store.value)
    let waiter = Task { try await read.value }
    addTeardownBlock { @MainActor in
      store.close()
      waiter.cancel()
      gate.open()
      _ = await waiter.result
    }
    await fulfillment(of: [started], timeout: 3)
    waiter.cancel()
    // A second production consumer awaits the same resource after the first leaves.
    let second = try store.stateStore.get(store.value)
    gate.open()
    let result = try await second.value
    XCTAssertEqual(result.first?.name, "Shared")
    XCTAssertEqual(store.projects, result)
    let reader = directory.cache(scope: scope)
    let persisted = try await reader.loadProjects()
    XCTAssertEqual(persisted, result)
    await reader.close()
    store.close()
    XCTAssertThrowsError(try store.stateStore.get(store.value)) { error in
      XCTAssertTrue(error is CancellationError)
    }
  }

  func testRenameCancelsAnOlderReadAndKeepsConfirmedPersistence() async throws {
    struct Server: Sendable {
      var name = "Launch"
      var holdRead = false
    }
    let server = Mutex(Server())
    let started = expectation(description: "Old Project read captured its response")
    let cancelled = expectation(description: "Original HTTP read cancelled")
    let gate = ProjectResponseGate()
    let projectID = Self.project
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "PATCH" {
        let body = try JSONDecoder().decode(RenameBody.self, from: chatRequestBody(request))
        server.withLock { $0.name = body.name }
        return ChatHTTPResponse(body: projectRecord(name: body.name, id: projectID))
      }
      guard request.url?.path == "/api/projects" else { throw URLError(.unsupportedURL) }
      let (name, hold) = server.withLock { value in
        let hold = value.holdRead
        value.holdRead = false
        return (value.name, hold)
      }
      if hold {
        started.fulfill()
        await withTaskCancellationHandler {
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
      return projectListResponse(name: name, id: projectID)
    }
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "project-writer", workspaceID: "rename-projects")
    let store = ChatProjectStore(
      client: fixture.client,
      sync: ChatSync(client: fixture.client, cache: directory.cache(scope: scope)),
      didFail: { _ in }, didChangeMembership: {})
    defer { store.close() }
    await store.activate()
    server.withLock { $0.holdRead = true }
    let stale = Task { await store.refresh() }
    addTeardownBlock { @MainActor in
      store.close()
      stale.cancel()
      gate.open()
      await stale.value
    }
    await fulfillment(of: [started], timeout: 3)
    let renamed = await store.rename(projectID, name: "Confirmed")
    XCTAssertTrue(renamed)
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await stale.value
    XCTAssertEqual(store.projects.first?.name, "Confirmed")
    let reader = directory.cache(scope: scope)
    let persisted = try await reader.loadProjects()
    XCTAssertEqual(persisted?.first?.name, "Confirmed")
    await reader.close()
  }

  func testWorkspaceCloseCancelsOriginalIOAndRejectsFutureProjectReads() async throws {
    let started = expectation(description: "Workspace Project read started")
    let cancelled = expectation(description: "Workspace close cancelled original HTTP")
    let gate = ProjectResponseGate()
    let projectID = Self.project
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/projects" else { throw URLError(.unsupportedURL) }
      started.fulfill()
      await withTaskCancellationHandler {
        await gate.wait()
      } onCancel: {
        cancelled.fulfill()
      }
      return projectListResponse(name: "Late", id: projectID)
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    let projects = workspace.projects
    let read = try projects.stateStore.get(projects.value)
    addTeardownBlock { @MainActor in
      workspace.close()
      gate.open()
      _ = await read.result
    }
    await fulfillment(of: [started], timeout: 3)
    workspace.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    do {
      _ = try await read.value
      XCTFail("A retired workspace cannot publish a Project read")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertTrue(projects.projects.isEmpty)
    XCTAssertThrowsError(try projects.stateStore.get(projects.value)) { error in
      XCTAssertTrue(error is CancellationError)
    }
  }

  func testProjectDisclosureRestoresOnlyWithinItsWorkspaceAndLimitsStayVisitOwned() async throws {
    let suite = "projects-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let projectID = Self.project
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/projects" else { throw URLError(.unsupportedURL) }
      return projectListResponse(name: "Scoped", id: projectID)
    }
    func makeStore() -> ChatProjectStore {
      ChatProjectStore(
        client: fixture.client, sync: ChatSync(client: fixture.client), defaults: defaults,
        didFail: { _ in }, didChangeMembership: {})
    }
    let original = makeStore()
    defer { original.close() }
    await original.restore(userID: "user", workspaceID: "original", apiURL: fixture.baseURL)
    await original.activate()
    original.expand(projectID)
    original.showMore(projectID)
    XCTAssertEqual(original.limit(for: projectID), 40)
    original.close()
    let restored = makeStore()
    defer { restored.close() }
    await restored.restore(userID: "user", workspaceID: "original", apiURL: fixture.baseURL)
    XCTAssertTrue(restored.isExpanded(projectID))
    XCTAssertEqual(restored.limit(for: projectID), 20)
    let other = makeStore()
    defer { other.close() }
    await other.restore(userID: "user", workspaceID: "other", apiURL: fixture.baseURL)
    XCTAssertFalse(other.isExpanded(projectID))
    XCTAssertEqual(other.limit(for: projectID), 20)
  }

  func testProjectUpgradeResponseRetiresTheWorkspace() async throws {
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/projects" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(
        status: 426,
        body: #"{"error":{"message":"Update required","code":"CLIENT_UPGRADE_REQUIRED"}}"#)
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.projects.activate()
    XCTAssertTrue(workspace.needsUpgrade)
    let created = await workspace.projects.create(name: "Must not write")
    XCTAssertNil(created)
    XCTAssertThrowsError(try workspace.projects.stateStore.get(workspace.projects.value))
  }

  func testConfirmedCreateMoveAndDeleteKeepMembershipAndNewChatContextWithTheirOwners()
    async throws
  {
    struct Server: Sendable {
      var projectID: String?
      var threadProjectID: String?
      var failDelete = true
      var deleteEvents: [String] = []
    }
    let server = Mutex(Server())
    let started = expectation(description: "Create Project is awaiting confirmation")
    let gate = ProjectResponseGate()
    let threadID = Self.thread
    let agentID = Self.agent
    let fixture = ChatHTTPFixture { request in
      switch (request.httpMethod, request.url?.path) {
      case ("POST", "/api/projects"):
        let body = try JSONDecoder().decode(CreateBody.self, from: chatRequestBody(request))
        started.fulfill()
        await gate.wait()
        server.withLock {
          $0.projectID = body.id
          $0.threadProjectID = body.fromThreadId == threadID ? body.id : nil
        }
        return ChatHTTPResponse(body: projectRecord(name: body.name, id: body.id))
      case ("GET", "/api/projects"):
        return server.withLock {
          $0.projectID.map { projectListResponse(name: "Created", id: $0) }
            ?? ChatHTTPResponse(body: "{\"projects\":[]}")
        }
      case ("PUT", "/api/chat-threads/\(threadID)/project"):
        let body = try JSONDecoder().decode(MoveBody.self, from: chatRequestBody(request))
        server.withLock { $0.threadProjectID = body.projectId }
        return ChatHTTPResponse(status: 204, body: "")
      case ("DELETE", _):
        let body = try JSONDecoder().decode([String: String].self, from: chatRequestBody(request))
        return server.withLock {
          guard request.url?.path == "/api/projects/\($0.projectID ?? "")" else {
            return ChatHTTPResponse(status: 404, body: "{}")
          }
          $0.deleteEvents.append(body["eventId"] ?? "")
          if $0.failDelete {
            $0.failDelete = false
            return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Retry deletion"}}"#)
          }
          $0.projectID = nil
          $0.threadProjectID = nil
          return ChatHTTPResponse(status: 204, body: "")
        }
      case ("GET", "/api/chat-threads/snapshot"):
        let project = server.withLock { $0.threadProjectID.map { "\"\($0)\"" } ?? "null" }
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(threadID)","agentId":"\(agentID)","title":"Kept chat","projectId":\(project),"createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z","sortAt":"2026-11-09T01:00:00Z"}],"latestEventId":null,"latestSeqId":null}
            """)
      case ("GET", "/api/chat-threads/events"):
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case ("GET", "/api/indicators"):
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    let creation = Task {
      await workspace.projects.create(name: "Created", fromThreadID: threadID)
    }
    addTeardownBlock { @MainActor in
      workspace.close()
      creation.cancel()
      gate.open()
      _ = await creation.value
    }
    await fulfillment(of: [started], timeout: 3)
    creation.cancel()
    gate.open()
    let created = await creation.value
    let project = try XCTUnwrap(created)
    XCTAssertEqual(workspace.projects.projects.first?.id, project.id)
    XCTAssertEqual(workspace.list.threads.first?.projectId, project.id)
    XCTAssertTrue(workspace.projects.isExpanded(project.id))
    workspace.projects.showMore(project.id)
    await workspace.projects.refresh()
    XCTAssertEqual(workspace.projects.limit(for: project.id), 40)
    let moved = await workspace.projects.move(threadID: threadID, projectID: nil)
    XCTAssertTrue(moved)
    XCTAssertNil(workspace.list.threads.first?.projectId)
    workspace.startNewChat(projectID: project.id)
    let failed = await workspace.deleteProject(project.id)
    XCTAssertFalse(failed)
    XCTAssertEqual(workspace.newChatProjectID, project.id)
    let deleted = await workspace.deleteProject(project.id)
    XCTAssertTrue(deleted)
    XCTAssertNil(workspace.newChatProjectID)
    XCTAssertTrue(workspace.projects.projects.isEmpty)
    XCTAssertFalse(workspace.projects.isExpanded(project.id))
    XCTAssertEqual(workspace.projects.limit(for: project.id), 20)
    XCTAssertEqual(workspace.list.threads.first?.title, "Kept chat")
    let events = server.withLock { $0.deleteEvents }
    XCTAssertEqual(events.count, 2)
    XCTAssertEqual(events.first, events.last)
  }

  private func thread(_ id: String, agent: String) -> ChatThread {
    ChatThread(id: id, agentID: agent, title: id, createdAt: .now, updatedAt: .now, sortAt: .now)
  }

  private struct RenameBody: Decodable {
    let eventId: String
    let name: String
  }

  private struct CreateBody: Decodable {
    let id: String
    let name: String
    let fromThreadId: String?
  }

  private struct MoveBody: Decodable { let projectId: String? }
}

private func projectRecord(name: String, id: String) -> String {
  """
  {"id":"\(id)","name":"\(name)","createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z"}
  """
}

private func projectListResponse(name: String, id: String) -> ChatHTTPResponse {
  ChatHTTPResponse(body: "{\"projects\":[\(projectRecord(name: name, id: id))]}")
}

private final class ProjectResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream()
    stream = pair.stream
    continuation = pair.continuation
  }

  func open() { continuation.finish() }
  func wait() async { for await _ in stream { return } }
}
