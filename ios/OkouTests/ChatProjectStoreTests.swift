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
  }

  private func thread(_ id: String, agent: String) -> ChatThread {
    ChatThread(id: id, agentID: agent, title: id, createdAt: .now, updatedAt: .now, sortAt: .now)
  }

  private struct RenameBody: Decodable {
    let eventId: String
    let name: String
  }
}
