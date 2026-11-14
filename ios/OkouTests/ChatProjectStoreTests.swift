import CCState
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
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      }
      let record: @Sendable (String) -> String = { name in
        "{\"id\":\"\(projectID)\",\"name\":\"\(name)\",\"createdAt\":\"2026-11-09T01:00:00Z\",\"updatedAt\":\"2026-11-09T01:00:00Z\"}"
      }
      if request.httpMethod == "PATCH", request.url?.path == "/api/projects/\(projectID)" {
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
      guard request.httpMethod == "GET", request.url?.path == "/api/projects/snapshot" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(
        body:
          "{\"latestEventId\":null,\"latestSeqId\":0,\"projects\":[\(record(server.withLock { $0.name }))]}"
      )
    }
    let resources = WorkspaceResources(
      client: fixture.client, sync: ChatSync(client: fixture.client), sleep: { _ in })
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

  func testProjectsCollectOtherAgentsAndRespectUnreadAndArchiveFilters() async throws {
    let projectID = Self.project
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      }
      guard request.httpMethod == "GET", request.url?.path == "/api/projects/snapshot" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(
        body:
          "{\"latestEventId\":null,\"latestSeqId\":0,\"projects\":[{\"id\":\"\(projectID)\",\"name\":\"Launch\",\"createdAt\":\"2026-11-09T01:00:00Z\",\"updatedAt\":\"2026-11-09T01:00:00Z\"}]}"
      )
    }
    let projects = try await ChatSync(client: fixture.client).projectList()
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
      filter: .recent)
    XCTAssertEqual(normal.threads.map(\.id), [ordinary.id])
    XCTAssertEqual(normal.projects.first?.threads.map(\.id), [member.id])
    let unread = ChatListContents(
      projects: projects, threads: threads, agentID: Self.agent,
      filter: .unread)
    XCTAssertEqual(unread.projects.first?.threads.map(\.id), [member.id])
    XCTAssertTrue(unread.threads.isEmpty)
    let archive = ChatListContents(
      projects: projects, threads: threads, agentID: Self.agent,
      filter: .archived)
    XCTAssertEqual(archive.projects.first?.threads.map(\.id), [archived.id])
  }

  func testReadFailureRetainsTheConfirmedCacheAndExplicitRetryPersistsFreshProjects() async throws {
    let directory = CacheTestDirectory(owner: self)
    let phase = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        if phase.withLock({ $0 }) == 1 {
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
        }
        return projectTail(request, name: phase.withLock { $0 } == 0 ? "Launch" : "Release")
      }
      guard request.url?.path == "/api/projects/snapshot" else { throw URLError(.unsupportedURL) }
      if phase.withLock({ $0 }) == 1 {
        return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
      }
      return projectList(name: phase.withLock { $0 } == 0 ? "Launch" : "Release")
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "project-reader", workspaceID: "project-workspace")
    let workspace = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope),
      readRetrySleep: { _ in })
    defer { workspace.close() }
    await workspace.projects.activate()
    phase.withLock { $0 = 1 }
    await workspace.projects.refresh()
    XCTAssertEqual(workspace.projects.projects.first?.name, "Launch")
    let failed = try workspace.projects.stateStore.get(workspace.projects.listValue)
    guard case .failure(let error) = await failed.result else {
      return XCTFail("A confirmed snapshot must not hide the current Project read failure")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
    let reader = directory.cache(scope: scope)
    let retained = try await reader.loadProjects()
    XCTAssertEqual(retained?.first?.name, "Launch")
    await reader.close()

    phase.withLock { $0 = 2 }
    await workspace.projects.refresh()
    let fresh = try await workspace.projects.stateStore.get(workspace.projects.listValue).value
    XCTAssertEqual(fresh.first?.name, "Release")
    let reopened = directory.cache(scope: scope)
    let committed = try await reopened.loadProjects()
    XCTAssertEqual(committed?.first?.name, "Release")
    await reopened.close()
  }

  func testALateReadCannotOverwriteARenameOrItsPersistedConfirmation() async throws {
    struct Server: Sendable {
      var name = "Launch"
      var holdRead = false
    }
    let directory = CacheTestDirectory(owner: self)
    let projectID = Self.project
    let server = Mutex(Server())
    let gate = ProjectResponseGate()
    let began = expectation(description: "The older Project read is pending")
    let returned = expectation(description: "The older HTTP handler completed")
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        let response = server.withLock { ($0.name, $0.holdRead) }
        if response.1 {
          server.withLock { $0.holdRead = false }
          began.fulfill()
          await gate.wait()
          returned.fulfill()
        }
        return projectTail(request, name: response.0)
      }
      if request.httpMethod == "PATCH", request.url?.path == "/api/projects/\(projectID)" {
        let body = try JSONDecoder().decode(RenameBody.self, from: chatRequestBody(request))
        server.withLock { $0.name = body.name }
        return ChatHTTPResponse(body: projectRecord(name: body.name))
      }
      guard request.httpMethod == "GET", request.url?.path == "/api/projects/snapshot" else {
        throw URLError(.unsupportedURL)
      }
      return projectList(name: server.withLock { $0.name })
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "project-writer", workspaceID: "project-workspace")
    let workspace = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope))
    defer { workspace.close() }
    await workspace.projects.activate()
    server.withLock { $0.holdRead = true }
    let oldRead = Task { await workspace.projects.refresh() }
    addTeardownBlock { @MainActor in
      workspace.close()
      oldRead.cancel()
      gate.open()
      await oldRead.value
    }
    await fulfillment(of: [began], timeout: 3)
    let renamed = await workspace.projects.rename(Self.project, name: "Release")
    XCTAssertTrue(renamed)
    gate.open()
    await fulfillment(of: [returned], timeout: 3)
    await oldRead.value
    XCTAssertEqual(workspace.projects.projects.first?.name, "Release")
    let reader = directory.cache(scope: scope)
    let committed = try await reader.loadProjects()
    XCTAssertEqual(committed?.first?.name, "Release")
    await reader.close()
  }

  func testLeavingOneProjectConsumerPreservesTheOtherConsumersOriginalRead() async throws {
    let gate = ProjectResponseGate()
    let began = expectation(description: "The shared Project request is pending")
    let requests = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      }
      guard request.url?.path == "/api/projects/snapshot" else { throw URLError(.unsupportedURL) }
      requests.withLock { $0 += 1 }
      began.fulfill()
      await gate.wait()
      return projectList(name: "Shared project")
    }
    let resources = WorkspaceResources(
      client: fixture.client, sync: ChatSync(client: fixture.client), sleep: { _ in })
    let store = ChatProjectStore(
      client: fixture.client, resources: resources, sync: ChatSync(client: fixture.client),
      didFail: { XCTFail("Unexpected failure: \($0)") }, didChangeMembership: {})
    let leaving = Task { await store.activate() }
    let surviving = try resources.store.get(resources.projectList)
    addTeardownBlock { @MainActor in
      store.close()
      resources.close()
      leaving.cancel()
      gate.open()
      await leaving.value
      _ = await surviving.result
    }
    await fulfillment(of: [began], timeout: 3)
    leaving.cancel()
    store.close()
    gate.open()
    let received = try await surviving.value
    await leaving.value
    XCTAssertEqual(received.first?.name, "Shared project")
    XCTAssertTrue(store.projects.isEmpty)
    // This is shared external HTTP work, not an internal evaluation count.
    XCTAssertEqual(requests.withLock { $0 }, 1)
  }

  func testWorkspaceCloseCancelsProjectIOAndRejectsFutureReads() async throws {
    let gate = ProjectResponseGate()
    let began = expectation(description: "Project HTTP read started")
    let cancelled = expectation(description: "Original Project HTTP read was cancelled")
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      }
      guard request.url?.path == "/api/projects/snapshot" else { throw URLError(.unsupportedURL) }
      began.fulfill()
      await withTaskCancellationHandler {
        await gate.wait()
      } onCancel: {
        cancelled.fulfill()
      }
      return projectList(name: "Retired project")
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    let pending = Task { await workspace.projects.activate() }
    let original = try workspace.projects.stateStore.get(workspace.projects.listValue)
    addTeardownBlock { @MainActor in
      workspace.close()
      pending.cancel()
      gate.open()
      await pending.value
      _ = await original.result
    }
    await fulfillment(of: [began], timeout: 3)
    workspace.close()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    await pending.value
    guard case .failure = await original.result else {
      return XCTFail("A retired workspace must reject late Project success")
    }
    XCTAssertTrue(workspace.projects.projects.isEmpty)
    XCTAssertThrowsError(try workspace.projects.stateStore.get(workspace.projects.listValue))
  }

  func testDeletingAProjectClearsOnlyItsMatchingNewChatContextAndKeepsTheDraft() async throws {
    let projectID = Self.project
    let other = "30000000-0000-4000-8000-000000000072"
    let deleted = Mutex(Set<String>())
    let gate = ProjectResponseGate()
    let began = expectation(description: "The first deletion is pending")
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      }
      if request.httpMethod == "DELETE" {
        guard let url = request.url,
          url.path == "/api/projects/\(projectID)" || url.path == "/api/projects/\(other)"
        else { throw URLError(.unsupportedURL) }
        let id = url.lastPathComponent
        if id == projectID {
          began.fulfill()
          await gate.wait()
        }
        deleted.withLock { $0.insert(id) }
        return ChatHTTPResponse(status: 204, body: "")
      }
      guard request.httpMethod == "GET" else { throw URLError(.unsupportedURL) }
      switch request.url?.path {
      case "/api/projects/snapshot":
        let records = [(projectID, "Launch"), (other, "Release")]
          .filter { id, _ in !deleted.withLock { $0.contains(id) } }
          .map { id, name in projectRecord(name: name, id: id) }
        return ChatHTTPResponse(
          body:
            "{\"latestEventId\":null,\"latestSeqId\":0,\"projects\":[\(records.joined(separator: ","))]}"
        )
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: #"{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"#)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.projects.activate()
    workspace.startNewChat(projectID: Self.project)
    workspace.newChatDraft = "Keep this draft"
    let deleting = Task { await workspace.deleteProject(Self.project) }
    addTeardownBlock { @MainActor in
      workspace.close()
      deleting.cancel()
      gate.open()
      await deleting.value
    }
    await fulfillment(of: [began], timeout: 3)
    workspace.startNewChat(projectID: other)
    gate.open()
    await deleting.value
    XCTAssertEqual(workspace.newChatProjectID, other)
    XCTAssertEqual(workspace.newChatDraft, "Keep this draft")

    await workspace.deleteProject(other)
    XCTAssertNil(workspace.newChatProjectID)
    XCTAssertEqual(workspace.newChatDraft, "Keep this draft")
    XCTAssertTrue(workspace.projects.projects.isEmpty)
  }

  func testCancellingARenameWaiterStillConfirmsAndPersistsTheAcknowledgedWrite() async throws {
    let directory = CacheTestDirectory(owner: self)
    let projectID = Self.project
    let name = Mutex("Launch")
    let began = expectation(description: "Rename reached the external service")
    let gate = ProjectResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
        return projectTail(request, name: name.withLock { $0 })
      }
      if request.httpMethod == "PATCH", request.url?.path == "/api/projects/\(projectID)" {
        let body = try JSONDecoder().decode(RenameBody.self, from: chatRequestBody(request))
        began.fulfill()
        await gate.wait()
        name.withLock { $0 = body.name }
        return ChatHTTPResponse(body: projectRecord(name: body.name))
      }
      guard request.httpMethod == "GET", request.url?.path == "/api/projects/snapshot" else {
        throw URLError(.unsupportedURL)
      }
      return projectList(name: name.withLock { $0 })
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "departing-project-writer",
      workspaceID: "project-workspace")
    let workspace = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope))
    defer { workspace.close() }
    await workspace.projects.activate()
    let leaving = Task { await workspace.projects.rename(Self.project, name: "Release") }
    addTeardownBlock { @MainActor in
      workspace.close()
      leaving.cancel()
      gate.open()
      _ = await leaving.value
    }
    await fulfillment(of: [began], timeout: 3)
    leaving.cancel()
    gate.open()
    let saved = await leaving.value
    XCTAssertTrue(saved)
    XCTAssertEqual(workspace.projects.projects.first?.name, "Release")
    let reader = directory.cache(scope: scope)
    let committed = try await reader.loadProjects()
    XCTAssertEqual(committed?.first?.name, "Release")
    await reader.close()
  }

  func testDeniedProjectReadsRemainFailuresAndUpgradeRetiresWorkspaceReads() async throws {
    for status in [401, 403, 426] {
      let denied = Mutex(false)
      let fixture = ChatHTTPFixture { request in
        if request.httpMethod == "GET", request.url?.path == "/api/projects/events" {
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        }
        guard request.url?.path == "/api/projects/snapshot" else { throw URLError(.unsupportedURL) }
        if denied.withLock({ $0 }) {
          return ChatHTTPResponse(status: status, body: #"{"error":{"message":"Denied"}}"#)
        }
        return projectList(name: "Confirmed project")
      }
      let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { workspace.close() }
      await workspace.projects.activate()
      denied.withLock { $0 = true }
      await workspace.projects.refresh()
      XCTAssertEqual(workspace.projects.projects.first?.name, "Confirmed project")
      if status == 426 {
        XCTAssertTrue(workspace.needsUpgrade)
        XCTAssertThrowsError(try workspace.projects.stateStore.get(workspace.projects.listValue))
      } else {
        let current = try workspace.projects.stateStore.get(workspace.projects.listValue)
        guard case .failure(let error) = await current.result else {
          return XCTFail("Cached names must not authorize a denied Project read")
        }
        XCTAssertEqual((error as? APIClientError)?.statusCode, status)
      }
    }
  }

  private func thread(_ id: String, agent: String) -> ChatThread {
    ChatThread(id: id, agentID: agent, title: id, createdAt: .now, updatedAt: .now, sortAt: .now)
  }

  private struct RenameBody: Decodable {
    let eventId: String
    let name: String
  }
}

private func projectRecord(
  name: String, id: String = "30000000-0000-4000-8000-000000000071"
) -> String {
  """
  {"id":"\(id)","name":"\(name)","createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z"}
  """
}

private func projectList(name: String) -> ChatHTTPResponse {
  ChatHTTPResponse(
    body: "{\"latestEventId\":null,\"latestSeqId\":0,\"projects\":[\(projectRecord(name: name))]}")
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

private func projectTail(_ request: URLRequest, name: String) -> ChatHTTPResponse {
  let since = request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
    .queryItems?.first { $0.name == "sinceSeqId" }?.value
  guard name != "Launch", since == "0" else {
    return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
  }
  return ChatHTTPResponse(
    body: """
      {"events":[{"id":"30000000-0000-4000-8000-000000000081","seqId":1,
      "projectId":"30000000-0000-4000-8000-000000000071","kind":"renamed",
      "name":"\(name)","createdAt":"2026-11-09T02:00:00Z"}],"hasMore":false}
      """)
}
