import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceNewChatTests: XCTestCase {
  func testNewChatUsesDefaultAgentWhileExistingChatRetainsItsAgent() async {
    let otherAgentID = "40000000-0000-4000-8000-000000000006"
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"displayName":"Okou"},{"agentId":"\(otherAgentID)","isDefaultAgent":false,"displayName":"Second"}]
            """)
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(storeThreadID)","agentId":"\(otherAgentID)","title":"Existing chat","createdAt":"\(storeDate)","updatedAt":"\(storeDate)","sortAt":"\(storeDate)"}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    XCTAssertEqual(store.currentAgentName, "Okou")

    store.startNewChat()
    XCTAssertEqual(store.currentAgentName, "Okou")
    XCTAssertNil(store.selectedThreadID)

    store.selectChat(storeThreadID)
    XCTAssertEqual(store.selectedAgentID, otherAgentID)
    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    store.startNewChat()
    XCTAssertEqual(store.selectedAgentID, storeAgentID)
    XCTAssertNil(store.selectedThreadID)
  }

  func testSelectedChatReassignmentUpdatesAgentContextAndNewChat() async throws {
    let otherAgentID = "40000000-0000-4000-8000-000000000006"
    let reassigned = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(storeAgentID)\",\"isDefaultAgent\":true,\"displayName\":\"Okou\"}]")
      case "/api/agents/\(storeAgentID)/draft", "/api/agents/\(otherAgentID)/draft",
        "/api/chat-threads/\(storeThreadID)/draft":
        return ChatHTTPResponse(body: #"{"draftUserMessage":null,"draftAttachments":null}"#)
      case "/api/chat-threads/snapshot":
        let url = URL(string: "/thread-snapshot", relativeTo: request.url!)!.absoluteURL
        return ChatHTTPResponse(
          body: """
            {"url":"\(url.absoluteString)","latestEventId":null,"latestSeqId":null}
            """)
      case "/thread-snapshot": return threadSnapshot(title: "Reassigned chat")
      case "/api/chat-threads/events":
        guard reassigned.withLock({ $0 }) else {
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        }
        return ChatHTTPResponse(
          body: """
            {"events":[{"id":"40000000-0000-4000-8000-000000000007","seqId":1,\
            "kind":"sort_touched","chatThreadId":"\(storeThreadID)",\
            "agentId":"\(storeAgentID)","reassignedAgentId":"\(otherAgentID)",\
            "createdAt":"\(storeDate)"}],"hasMore":false}
            """)
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
      case "/api/chat-thread-drafts":
        return ChatHTTPResponse(body: #"{"draftThreadIds":[]}"#)
      case "/api/chat-threads/\(storeThreadID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: """
            {"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}
            """)
      case "/api/chat-threads/\(storeThreadID)/event-rows":
        return ChatHTTPResponse(
          body: "{\"rows\":[],\"cursor\":{\"lastEventId\":null,\"lastSeqId\":0},\"hasMore\":false}")
      case "/api/chat-threads/\(storeThreadID)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.baseURL,
        userID: "user", workspaceID: "workspace"), directory: directory)
    let store = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, draftStorage: storage)
    defer { store.close() }
    await store.refreshNavigation()
    await store.refresh()
    store.selectChat(storeThreadID)
    XCTAssertEqual(store.selectedAgentID, storeAgentID)
    store.selectedConversation?.draft = "Draft survives Agent reassignment"

    reassigned.withLock { $0 = true }
    await store.refresh()

    XCTAssertEqual(store.selectedThreadID, storeThreadID)
    XCTAssertEqual(store.list.threads.first?.agentID, otherAgentID)
    XCTAssertEqual(store.selectedAgentID, otherAgentID)
    XCTAssertNil(store.error)
    XCTAssertNil(store.conversation(for: storeThreadID)?.error)
    store.startNewChat()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertEqual(store.selectedAgentID, storeAgentID)

    // Refreshing an existing thread does not change the new-chat executor.
    store.startNewChat()
    await store.refresh()
    XCTAssertEqual(store.selectedAgentID, storeAgentID)
    store.close()
    let reopened = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, draftStorage: storage)
    defer { reopened.close() }
    await reopened.refresh()
    reopened.selectChat(storeThreadID)
    XCTAssertEqual(reopened.selectedConversation?.thread.agentID, otherAgentID)
    XCTAssertEqual(reopened.selectedConversation?.draft, "Draft survives Agent reassignment")
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
      case "/api/agents":
        return ChatHTTPResponse(
          body: """
            [{"agentId":"\(storeAgentID)","isDefaultAgent":true,"ownerId":"test-user","description":null,"displayName":"Okou","sound":null,"avatarUrl":null,"visibility":"private"}]
            """)
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
        return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
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
