import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class NotificationRefreshTests: XCTestCase {
  func testMetadataAndEquivalentProjectionsDoNotInvalidateNotificationReadState() async throws {
    let metadata = Mutex((title: "Original", muted: false, pinned: false, project: false))
    let threadID = "74000000-0000-4000-8000-000000000001"
    let agentID = "74000000-0000-4000-8000-000000000002"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        let state = metadata.withLock { $0 }
        let project = state.project ? #""74000000-0000-4000-8000-000000000003""# : "null"
        let pin = state.pinned ? #""a0""# : "null"
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(threadID)","agentId":"\(agentID)",\
            "title":"\(state.title)","muted":\(state.muted),"pinOrder":\(pin),\
            "projectId":\(project),"createdAt":"2026-10-20T00:00:00Z",\
            "updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}],\
            "latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      case "/api/agents": return ChatHTTPResponse(body: "[]")
      default: throw URLError(.unsupportedURL)
      }
    }
    var changes = 0
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, didRefreshReadState: { changes += 1 })
    defer { store.close() }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.count, 1)
    XCTAssertEqual(changes, 0)

    metadata.withLock {
      $0.title = "Renamed"
      $0.pinned = true
      $0.project = true
    }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.first?.title, "Renamed")
    XCTAssertEqual(store.list.threads.first?.pinOrder, "a0")
    XCTAssertNotNil(store.list.threads.first?.projectId)
    await store.list.refresh()
    XCTAssertEqual(changes, 0)

    metadata.withLock { $0.muted = true }
    await store.list.refresh()
    XCTAssertEqual(store.list.threads.first?.isMuted, true)
    XCTAssertEqual(changes, 1)

    // The sidebar can already look read while a notification still needs a newer watermark.
    store.list.markRead(threadID, through: Date())
    XCTAssertEqual(changes, 2)
    await store.refresh([.indicators])
    XCTAssertEqual(changes, 3)
    await store.refresh([.readCursor])
    XCTAssertEqual(changes, 4)
  }
}
