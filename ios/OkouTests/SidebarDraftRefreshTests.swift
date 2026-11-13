import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class SidebarDraftRefreshTests: XCTestCase {
  func testSidebarSharesDraftMembershipAcrossMetadataAndRecoveryReads() async throws {
    let fixture = SidebarDraftFixture(draft: "Saved on another device")
    let workspace = makeWorkspace(fixture)
    await workspace.refresh()
    XCTAssertEqual(fixture.draftReads, 0)

    await workspace.activateDrafts()
    XCTAssertTrue(workspace.hasDraft(fixture.threadID))
    fixture.state.values.withLock { $0.title = "Renamed remotely" }
    await workspace.refresh([.threadList])
    XCTAssertEqual(workspace.list.threads.first?.title, "Renamed remotely")

    workspace.setPhase(.background)
    workspace.setPhase(.active)
    await workspace.resumePendingRefresh()?.value
    await workspace.refresh([.realtimeGap])
    await workspace.activateDrafts()
    XCTAssertTrue(workspace.hasDraft(fixture.threadID))
    XCTAssertEqual(fixture.draftReads, 1)
  }

  func testConfirmedLocalSavesRefreshMembershipOnlyWhenADraftAppearsOrDisappears() async throws {
    let fixture = SidebarDraftFixture()
    let workspace = makeWorkspace(fixture)
    workspace.setPhase(.active)
    await workspace.refresh()
    await workspace.activateDrafts()
    workspace.selectChat(fixture.threadID)
    let composer = try XCTUnwrap(workspace.selectedConversation?.composer)
    await composer.synchronize()

    composer.text = "First draft"
    await composer.synchronize()
    let repository = ChatDraftRepository(client: fixture.http.client)
    let first = try await repository.load(.thread(fixture.threadID))
    XCTAssertEqual(first.draftUserMessage?.text, "First draft")
    XCTAssertTrue(workspace.hasDraft(fixture.threadID))
    XCTAssertEqual(fixture.draftReads, 2)

    composer.text = "Edited draft"
    await composer.synchronize()
    let edited = try await repository.load(.thread(fixture.threadID))
    XCTAssertEqual(edited.draftUserMessage?.text, "Edited draft")
    XCTAssertEqual(fixture.draftReads, 2)

    composer.clear()
    await composer.synchronize()
    let cleared = try await repository.load(.thread(fixture.threadID))
    XCTAssertNil(cleared.draftUserMessage)
    workspace.startNewChat()
    await workspace.reduceMemory()
    XCTAssertFalse(workspace.hasDraft(fixture.threadID))
    XCTAssertEqual(fixture.draftReads, 3)
  }

  func testPendingDraftMembershipDoesNotHoldTheListAndClosesWithItsWorkspace() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "The draft list response is held")
    let fixture = SidebarDraftFixture(
      draft: "Remote draft",
      beforeDraftRead: {
        started.fulfill()
        await gate.wait()
      })
    let workspace = makeWorkspace(fixture)
    let read = Task { await workspace.activateDrafts() }
    addTeardownBlock {
      gate.open()
      read.cancel()
      await workspace.close().value
      await read.value
    }
    await fulfillment(of: [started], timeout: 3)
    await workspace.refresh([.threadList])
    XCTAssertEqual(workspace.list.threads.first?.title, "Draft fixture")
    let closing = workspace.close()
    gate.open()
    await closing.value
    await read.value
    XCTAssertFalse(workspace.hasDraft(fixture.threadID))
  }

  func testDraftMembershipUpgradeResponseClosesWorkspaceReads() async throws {
    let fixture = SidebarDraftFixture(draftStatus: 426)
    let workspace = makeWorkspace(fixture)
    await workspace.activateDrafts()
    XCTAssertTrue(workspace.needsUpgrade)
    await workspace.activateDrafts()
    await workspace.refresh()
    XCTAssertEqual(fixture.draftReads, 1)
  }

  private func makeWorkspace(_ fixture: SidebarDraftFixture) -> WorkspaceStore {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "sidebar-user", workspaceID: "sidebar-workspace"),
      directory: directory)
    let workspace = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, draftStorage: storage)
    addTeardownBlock {
      await workspace.close().value
      try? FileManager.default.removeItem(at: directory)
    }
    return workspace
  }
}

private final class SidebarDraftFixture: Sendable {
  struct Values: Sendable {
    var draft = ComposerDraft()
    var title = "Draft fixture"
    var draftReads = 0
  }
  final class State: Sendable {
    let values = Mutex(Values())
  }
  let state = State()
  let threadID = UUID().uuidString.lowercased()
  let agentID = UUID().uuidString.lowercased()
  let http: ChatHTTPFixture

  var draftReads: Int { state.values.withLock { $0.draftReads } }

  init(
    draft: String? = nil, draftStatus: Int = 200,
    beforeDraftRead: @escaping @Sendable () async -> Void = {}
  ) {
    let state = state
    let threadID = threadID
    let agentID = agentID
    if let draft {
      state.values.withLock {
        var document = ChatDraftDocument()
        document.replaceText(draft)
        $0.draft = ComposerDraft(document: document)
      }
    }
    http = ChatHTTPFixture { request in
      switch request.url!.path {
      case "/api/chat-threads/snapshot":
        let title = state.values.withLock { $0.title }
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(threadID)","agentId":"\(agentID)",\
            "title":"\(title)","createdAt":"2026-11-13T00:00:00Z",\
            "updatedAt":"2026-11-13T00:00:00Z","sortAt":"2026-11-13T00:00:00Z"}],\
            "latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      case "/api/chat-thread-drafts":
        let present = state.values.withLock {
          $0.draftReads += 1
          return $0.draft.draftUserMessage != nil
        }
        await beforeDraftRead()
        if draftStatus != 200 {
          return ChatHTTPResponse(
            status: draftStatus, body: #"{"error":{"message":"Upgrade required"}}"#)
        }
        return ChatHTTPResponse(
          body: "{\"draftThreadIds\":\(present ? "[\"\(threadID)\"]" : "[]")}")
      case "/api/chat-threads/\(threadID)/draft":
        let draft = state.values.withLock { $0.draft }
        return ChatHTTPResponse(
          body: String(decoding: try JSONEncoder().encode(draft), as: UTF8.self))
      case "/api/chat-threads/\(threadID)":
        if request.httpMethod == "PATCH" {
          let draft = try JSONDecoder().decode(ComposerDraft.self, from: chatRequestBody(request))
          state.values.withLock { $0.draft = draft }
          return ChatHTTPResponse(status: 204, body: "")
        }
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      case "/api/chat-threads/\(threadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      case "/api/chat-threads/\(threadID)/event-rows":
        return ChatHTTPResponse(
          body: #"{"rows":[],"cursor":{"lastEventId":null,"lastSeqId":0},"hasMore":false}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }
}
