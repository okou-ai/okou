import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatIndicatorRefreshTests: XCTestCase {
  func testListChangesKeepIndicatorsUntilTheirOwnInvalidationArrives() async throws {
    let fixture = IndicatorListFixture()
    let workspace = fixture.workspace()
    addTeardownBlock { await workspace.close().value }
    await workspace.refresh()
    XCTAssertEqual(workspace.list.threads.first?.indicator, .active)
    let initialIndicatorReads = fixture.reads("/api/indicators")

    fixture.values.withLock { $0.title = "Renamed remotely" }
    await workspace.refresh([.threadList])
    XCTAssertEqual(workspace.list.threads.first?.title, "Renamed remotely")
    XCTAssertEqual(workspace.list.threads.first?.indicator, .active)
    XCTAssertEqual(fixture.reads("/api/indicators"), initialIndicatorReads)
    let listReads = fixture.reads("/api/chat-threads/events")

    fixture.values.withLock { $0.indicator = "unread" }
    await workspace.refresh([.indicators])
    XCTAssertTrue(workspace.list.threads.first?.isUnread == true)
    XCTAssertEqual(workspace.list.unreadAgentIDs, [fixture.agentID])
    XCTAssertEqual(fixture.reads("/api/indicators"), initialIndicatorReads + 1)
    XCTAssertEqual(fixture.reads("/api/chat-threads/events"), listReads)
  }

  func testSlowIndicatorsDoNotHoldTheFreshChatList() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The indicator response is held")
    let fixture = IndicatorListFixture { path in
      if path == "/api/indicators" {
        began.fulfill()
        await gate.wait()
      }
    }
    let workspace = fixture.workspace()
    let refresh = Task { await workspace.refresh() }
    addTeardownBlock {
      gate.open()
      refresh.cancel()
      await workspace.close().value
      await refresh.value
    }
    await fulfillment(of: [began], timeout: 3)
    try await waitForBusinessResult { workspace.list.threads.first?.title == "Indicator fixture" }
    gate.open()
    await refresh.value
    XCTAssertEqual(workspace.list.threads.first?.indicator, .active)
  }

  func testIndicatorsArrivingBeforeMetadataStillMarkTheNewChatAsRunning() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "The list response is held")
    let fixture = IndicatorListFixture { path in
      if path == "/api/chat-threads/snapshot" {
        began.fulfill()
        await gate.wait()
      }
    }
    let workspace = fixture.workspace()
    let refresh = Task { await workspace.refresh() }
    addTeardownBlock {
      gate.open()
      refresh.cancel()
      await workspace.close().value
      await refresh.value
    }
    await fulfillment(of: [began], timeout: 3)
    try await waitForBusinessResult { workspace.list.unreadAgentIDs.contains(fixture.agentID) }
    gate.open()
    await refresh.value
    XCTAssertEqual(workspace.list.threads.first?.id, fixture.threadID)
    XCTAssertEqual(workspace.list.threads.first?.indicator, .active)
  }
}

private final class IndicatorListFixture: Sendable {
  struct Values: Sendable {
    var title = "Indicator fixture"
    var indicator = "active"
    var requests: [String: Int] = [:]
  }
  let values = Mutex(Values())
  let threadID = UUID().uuidString.lowercased()
  let agentID = UUID().uuidString.lowercased()
  let http: ChatHTTPFixture

  init(beforeRead: @escaping @Sendable (String) async -> Void = { _ in }) {
    let values = values
    let threadID = threadID
    let agentID = agentID
    http = ChatHTTPFixture { request in
      let path = request.url!.path
      let current = values.withLock { value in
        value.requests[path, default: 0] += 1
        return (value.title, value.indicator)
      }
      await beforeRead(path)
      switch path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(threadID)","agentId":"\(agentID)",\
            "title":"\(current.0)","createdAt":"2026-11-13T00:00:00Z",\
            "sortAt":"2026-11-13T00:00:00Z"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(
          body: """
            {"agents":{"\(agentID)":"unread"},"threads":{"\(threadID)":"\(current.1)"},\
            "unreadAt":{"\(threadID)":"2026-11-13T00:00:00Z"}}
            """)
      case "/api/chat/events/catch-up":
        return ChatHTTPResponse(body: #"{"events":{},"notFoundThreads":[],"archivedThreadIds":[]}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  func reads(_ path: String) -> Int { values.withLock { $0.requests[path, default: 0] } }

  @MainActor
  func workspace() -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL)
  }
}
