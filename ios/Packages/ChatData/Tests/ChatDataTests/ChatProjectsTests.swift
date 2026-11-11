import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatProjectsTests: XCTestCase {
  private static let project = "30000000-0000-4000-8000-000000000071"
  private static let thread = "30000000-0000-4000-8000-000000000001"
  private static let agent = "30000000-0000-4000-8000-000000000002"
  private static let record = """
    {"id":"30000000-0000-4000-8000-000000000071","name":"Launch","createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z"}
    """

  func testWritesUseTheCanonicalProjectContractAndEncodeRemovalAsNull() async throws {
    struct Write: Sendable {
      let method: String
      let path: String
      let body: Data
    }
    let writes = Mutex<[Write]>([])
    let record = Self.record
    let fixture = ChatHTTPFixture { request in
      writes.withLock {
        $0.append(
          Write(
            method: request.httpMethod ?? "", path: request.url?.path ?? "",
            body: chatRequestBody(request)))
      }
      if request.httpMethod == "PUT" || request.httpMethod == "DELETE" {
        return ChatHTTPResponse(status: 204, body: "")
      }
      return ChatHTTPResponse(status: request.httpMethod == "POST" ? 201 : 200, body: record)
    }
    let service = ChatProjects(client: fixture.client)
    let operation = ChatProjects.operationID()
    _ = try await service.create(name: "Launch", eventID: operation, fromThreadID: Self.thread)
    _ = try await service.rename(Self.project, name: "Launch plan", eventID: operation)
    try await service.move(threadID: Self.thread, projectID: Self.project, eventID: operation)
    try await service.move(threadID: Self.thread, projectID: nil, eventID: operation)
    try await service.delete(Self.project, eventID: operation)

    let observed = writes.withLock { $0 }
    XCTAssertEqual(observed.map(\.method), ["POST", "PATCH", "PUT", "PUT", "DELETE"])
    XCTAssertEqual(
      observed.map(\.path),
      [
        "/api/projects", "/api/projects/\(Self.project)",
        "/api/chat-threads/\(Self.thread)/project", "/api/chat-threads/\(Self.thread)/project",
        "/api/projects/\(Self.project)",
      ])
    let bodies = try observed.map {
      try XCTUnwrap(JSONSerialization.jsonObject(with: $0.body) as? [String: Any])
    }
    XCTAssertEqual(
      bodies.compactMap { $0["eventId"] as? String }, Array(repeating: operation, count: 5))
    XCTAssertEqual(bodies[0]["id"] as? String, operation)
    XCTAssertEqual(bodies[0]["fromThreadId"] as? String, Self.thread)
    XCTAssertEqual(bodies[2]["projectId"] as? String, Self.project)
    XCTAssertTrue(bodies[3]["projectId"] is NSNull)
    let uuid = try XCTUnwrap(UUID(uuidString: operation))
    XCTAssertEqual(uuid.uuidString.split(separator: "-")[2].first, "7")
  }

  func testProjectNamesSurviveReopeningTheWorkspaceCache() async throws {
    let record = Self.record
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/projects" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(body: "{\"projects\":[\(record)]}")
    }
    let projects = try await ChatProjects(client: fixture.client).list()
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "project-reader", workspaceID: "scope")
    let cache = directory.cache(scope: scope)
    try await cache.saveProjects(projects)
    await cache.close()
    let reopened = directory.cache(scope: scope)
    let restored = try await reopened.loadProjects()
    XCTAssertEqual(restored?.first?.name, "Launch")
    XCTAssertEqual(restored?.first?.id, Self.project)
    let other = directory.cache(
      scope: ChatCacheScope(
        apiBaseURL: fixture.baseURL, userID: "another-user", workspaceID: "scope"))
    let otherProjects = try await other.loadProjects()
    XCTAssertNil(otherProjects)
  }

  func testTheFirstChatRequestCarriesProjectMembership() async throws {
    let bodies = Mutex<[Data]>([])
    let agent = Self.agent
    let thread = Self.thread
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: "[{\"agentId\":\"\(agent)\",\"displayName\":\"Okou\",\"isDefaultAgent\":true}]")
      case "/api/chat-threads":
        bodies.withLock { $0.append(chatRequestBody(request)) }
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(thread)\",\"title\":null,\"createdAt\":\"2026-11-09T01:00:00Z\",\"selectedModel\":null}"
        )
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let created = try await service.createThread(
      modelSelection: ChatModelSelection(), projectID: Self.project)
    XCTAssertEqual(created.projectId, Self.project)
    let data = try XCTUnwrap(bodies.withLock { $0.first })
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(body["projectId"] as? String, Self.project)
    XCTAssertEqual(body["agentId"] as? String, Self.agent)
  }
}
