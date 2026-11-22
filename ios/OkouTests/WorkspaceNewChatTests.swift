import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceNewChatTests: XCTestCase {
  func testStartingANewChatClearsTheSelectedThread() async {
    let otherAgentID = "40000000-0000-4000-8000-000000000006"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(storeThreadID)","title":"Existing chat","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","sortAt":"\(storeDate)"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()

    store.startNewChat()
    XCTAssertNil(store.selectedThreadID)

    store.selectChat(storeThreadID)
    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    store.startNewChat()
    XCTAssertNil(store.selectedThreadID)
  }

  func testNewChatDoesNotCreateUntilSendAndKeepsDraftIfCreationFails() async {
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request.url?.path ?? "") }
      return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Unavailable\"}}")
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    store.selectedThreadID = storeThreadID
    store.newChatDraft = "Old draft"

    store.startNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "Old draft")
    XCTAssertTrue(requests.withLock { $0.isEmpty })
    store.newComposer.clear()
    XCTAssertEqual(store.newChatDraft, "")

    store.newChatDraft = "First message"
    await store.sendNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.newChatDraft, "First message")
    XCTAssertFalse(requests.withLock { $0.isEmpty })
    XCTAssertNotNil(store.error)
  }

  func testDelayedCreateResponsePreservesOneLatestThreadFromList() async throws {
    let createStarted = expectation(description: "Create has committed but its response is delayed")
    let releaseCreateResponse = HTTPResponseGate()
    defer { releaseCreateResponse.open() }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/user-model-preference":
        return ChatHTTPResponse(
          body: """
            {"selectedModel":null,"serviceTier":null,"modelSettings":{},"selectedImageModel":null,"updatedAt":null}
            """)
      case "/api/run-models": return runModelsResponse()
      case "/api/model-catalog": return modelCatalogResponse()
      case "/api/chat-threads":
        guard request.httpMethod == "POST" else { throw URLError(.unsupportedURL) }
        createStarted.fulfill()
        await releaseCreateResponse.wait()
        return ChatHTTPResponse(
          status: 201,
          body: """
            {"id":"\(storeThreadID)","title":null,"createdAt":"\(storeDate)","selectedModel":null,"serviceTier":null}
            """)
      case "/api/chat-threads/snapshot": return threadSnapshot(title: "Latest title")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    let creation = Task { await store.createChat() }
    await fulfillment(of: [createStarted], timeout: 2)

    await store.refresh()
    XCTAssertEqual(store.list.threads.map(\.title), ["Latest title"])
    releaseCreateResponse.open()
    _ = await creation.value

    XCTAssertEqual(store.list.threads.map(\.id), [storeThreadID])
    XCTAssertEqual(store.list.threads.map(\.title), ["Latest title"])
    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    XCTAssertNil(store.error)
  }
}
