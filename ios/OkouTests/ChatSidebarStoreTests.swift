import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatSidebarStoreTests: XCTestCase {
  func testFiltersKeepCrossAgentProjectsUnknownNamesAndNativeStatusMeaning() async throws {
    let fixture = SidebarProjectionFixture()
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    await workspace.projects.activate()

    let recent = try snapshot(workspace)
    XCTAssertEqual(recent.filter, .recent)
    XCTAssertTrue(recent.isInbox)
    // Pins lead the chats outside Projects; the others follow by activity.
    XCTAssertEqual(recent.chats.rows.map(\.id), [1, 5, 3].map(SidebarProjectionFixture.id))
    let pinned = try XCTUnwrap(recent.chats.rows.first)
    XCTAssertTrue(pinned.isPinned)
    XCTAssertEqual(pinned.title, "Active pinned")
    XCTAssertEqual(pinned.emoji, "✅")
    XCTAssertTrue(pinned.isWorking)
    XCTAssertTrue(recent.chats.showsStatusColumn)
    XCTAssertFalse(recent.chats.rows.dropFirst().contains(where: \.isPinned))
    XCTAssertEqual(
      recent.pinNeighbors(of: SidebarProjectionFixture.id(1)), .init(above: nil, below: nil))
    XCTAssertNil(recent.pinNeighbors(of: SidebarProjectionFixture.id(5)))
    // Projects keep their creation order, whatever order the API lists them in.
    XCTAssertEqual(recent.projects.map(\.project.name), ["Shared", "Empty"])
    // A pinned chat leads its Project ahead of more recent activity, and reorders among the
    // Project's own pins.
    XCTAssertEqual(
      recent.projects.first?.section.rows.map(\.id), [2, 8].map(SidebarProjectionFixture.id))
    XCTAssertTrue(recent.projects.first?.section.hasUnread == true)
    XCTAssertEqual(
      recent.pinNeighbors(of: SidebarProjectionFixture.id(2)),
      .init(above: nil, below: nil, projectID: SidebarProjectionFixture.project))
    // The inbox leaves archived chats out; only the Project holding some offers them.
    XCTAssertEqual(recent.projects.map(\.hasHiddenArchivedChats), [true, false])
    XCTAssertFalse(recent.hasHiddenArchivedChats)

    workspace.sidebar.select(.unread)
    let unread = try snapshot(workspace)
    XCTAssertEqual(unread.filter, .unread)
    XCTAssertFalse(unread.isInbox)
    XCTAssertNil(unread.pinNeighbors(of: SidebarProjectionFixture.id(2)))
    XCTAssertEqual(unread.projects.map(\.hasHiddenArchivedChats), [false])
    XCTAssertEqual(unread.chats.rows.map(\.id), [SidebarProjectionFixture.id(3)])
    XCTAssertEqual(unread.projects.count, 1)
    XCTAssertEqual(
      unread.projects.first?.section.rows.map(\.id), [2, 4].map(SidebarProjectionFixture.id))

    workspace.sidebar.select(.archived)
    let archived = try snapshot(workspace)
    XCTAssertEqual(archived.filter, .archived)
    XCTAssertTrue(archived.chats.isEmpty)
    XCTAssertEqual(
      archived.projects.first?.section.rows.map(\.id), [7, 4].map(SidebarProjectionFixture.id))

    workspace.sidebar.select(.muted)
    let muted = try snapshot(workspace)
    XCTAssertEqual(muted.filter, .muted)
    XCTAssertEqual(muted.chats.rows.map(\.id), [SidebarProjectionFixture.id(5)])
    XCTAssertEqual(muted.projects.first?.section.rows.map(\.id), [SidebarProjectionFixture.id(7)])
    XCTAssertFalse(muted.chats.hasUnread)

    workspace.sidebar.select(.recent)
    workspace.selectChat(SidebarProjectionFixture.id(6))
    let otherAgent = try snapshot(workspace)
    XCTAssertEqual(otherAgent.chats.rows.map(\.id), [SidebarProjectionFixture.id(6)])
    XCTAssertEqual(
      otherAgent.projects.first?.section.rows.map(\.id), [2, 8].map(SidebarProjectionFixture.id))
    workspace.startNewChat()
    workspace.newChatDraft = "Keep this unrelated input"
    XCTAssertEqual(
      try snapshot(workspace).chats.rows.map(\.id), [1, 5, 3].map(SidebarProjectionFixture.id))
    XCTAssertEqual(workspace.newChatDraft, "Keep this unrelated input")
  }

  func testConfirmedUpdatesRefreshTheProjectionWithoutHidingTheOriginalReadError() async throws {
    let fixture = SidebarProjectionFixture()
    let workspace = fixture.workspace()
    defer { workspace.close() }
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    await workspace.projects.activate()
    workspace.sidebar.select(.unread)
    XCTAssertFalse(try snapshot(workspace).isEmpty)

    fixture.state.value.withLock { $0.unread = false }
    await workspace.list.refreshIndicators()
    XCTAssertTrue(try snapshot(workspace).isEmpty)
    XCTAssertEqual(try snapshot(workspace).filter, .unread)

    workspace.sidebar.select(.recent)
    let renamed = await workspace.projects.rename(
      SidebarProjectionFixture.project, name: "Confirmed group")
    XCTAssertTrue(renamed)
    XCTAssertEqual(try snapshot(workspace).projects.first?.project.name, "Confirmed group")
    fixture.state.value.withLock { $0.failProjects = true }
    await workspace.projects.refresh()
    XCTAssertEqual(try snapshot(workspace).projects.first?.project.name, "Confirmed group")
    let original = try workspace.projects.stateStore.get(workspace.projects.listValue)
    guard case .failure(let error) = await original.result else {
      return XCTFail("The current Project Task must retain its read failure")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 503)
  }

  func testRetiredSidebarCannotChangeAReplacementWorkspacesFilter() async throws {
    let fixture = SidebarProjectionFixture()
    let old = fixture.workspace()
    let replacement = fixture.workspace()
    defer {
      old.close()
      replacement.close()
    }
    await old.refreshNavigation()
    await old.list.refresh()
    old.sidebar.select(.archived)
    XCTAssertEqual(try snapshot(old).filter, .archived)
    old.close()
    XCTAssertThrowsError(try snapshot(old))

    await replacement.refreshNavigation()
    await replacement.list.refresh()
    old.sidebar.select(.muted)
    XCTAssertEqual(try snapshot(replacement).filter, .recent)
    XCTAssertEqual(
      try snapshot(replacement).chats.rows.filter(\.isPinned).map(\.id),
      [SidebarProjectionFixture.id(1)])
  }

  private func snapshot(_ workspace: WorkspaceStore) throws -> ChatSidebarPresentation {
    try workspace.sidebar.stateStore.get(workspace.sidebar.presentation)
  }
}

private final class SidebarProjectionFixture: Sendable {
  struct Server: Sendable {
    var unread = true
    var name = "Shared"
    var failProjects = false
  }

  static let agent = "63000000-0000-4000-8000-000000000100"
  static let otherAgent = "63000000-0000-4000-8000-000000000101"
  static let project = "63000000-0000-4000-8000-000000000200"
  static let timestamp = "2026-11-11T00:00:00Z"
  final class LockedServer: Sendable { let value = Mutex(Server()) }
  let state: LockedServer
  let http: ChatHTTPFixture

  init() {
    let state = LockedServer()
    self.state = state
    http = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(Self.agent)","displayName":"Okou","isDefaultAgent":true},
            {"agentId":"\(Self.otherAgent)","displayName":"Research","isDefaultAgent":false}]
            """)
      case "/api/projects":
        let server = state.value.withLock { $0 }
        if server.failProjects {
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#)
        }
        // The newer Project comes first here; the sidebar still lists the older one first.
        return ChatHTTPResponse(
          body: """
            {"projects":[\(Self.projectRecord(Self.id(201), name: "Empty", createdAt: Self.timestamp)),
            \(Self.projectRecord(Self.project, name: server.name))]}
            """)
      case "/api/projects/\(Self.project)":
        let name = try JSONDecoder().decode([String: String].self, from: chatRequestBody(request))[
          "name"]!
        state.value.withLock { $0.name = name }
        return ChatHTTPResponse(body: Self.projectRecord(Self.project, name: name))
      case "/api/chat-threads/snapshot":
        let rows = (1...8).map { index in
          let agent = [2, 6].contains(index) ? Self.otherAgent : Self.agent
          let project =
            [2, 4, 7, 8].contains(index) ? Self.project : index == 3 ? Self.id(999) : nil
          let title = index == 1 ? "✅ Active pinned" : "Chat \(index)"
          let pinOrder = [1: "\"a0\"", 2: "\"a1\""][index]
          return """
            {"id":"\(Self.id(index))","agentId":"\(agent)","title":"\(title)",
            "createdAt":"\(Self.timestamp)","updatedAt":"\(Self.timestamp)",
            "sortAt":"2026-11-11T00:0\(index):00Z","archived":\([4, 7].contains(index)),
            "muted":\([5, 7].contains(index)),"projectId":\(project.map { "\"\($0)\"" } ?? "null"),
            "pinnedAt":\(pinOrder == nil ? "null" : "\"\(Self.timestamp)\""),"pinOrder":\(pinOrder ?? "null")}
            """
        }
        return ChatHTTPResponse(
          body:
            "{\"chatThreads\":[\(rows.joined(separator: ","))],\"latestEventId\":null,\"latestSeqId\":null}"
        )
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        let unread = state.value.withLock { $0.unread } ? [2, 3, 4, 5] : []
        let marks = unread.map { "\"\(Self.id($0))\":\"unread\"" }
        return ChatHTTPResponse(
          body: """
            {"agents":{},"threads":{\((["\"\(Self.id(1))\":\"active\""] + marks).joined(separator: ","))},
            "unreadAt":{\(unread.map { "\"\(Self.id($0))\":\"\(Self.timestamp)\"" }.joined(separator: ","))}}
            """)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor func workspace() -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL, readRetrySleep: { _ in })
  }

  static func id(_ value: Int) -> String {
    "63000000-0000-4000-8000-\(String(format: "%012d", value))"
  }

  private static func projectRecord(
    _ id: String, name: String, createdAt: String = "2026-11-10T00:00:00Z"
  ) -> String {
    "{\"id\":\"\(id)\",\"name\":\"\(name)\",\"createdAt\":\"\(createdAt)\",\"updatedAt\":\"\(timestamp)\"}"
  }
}
