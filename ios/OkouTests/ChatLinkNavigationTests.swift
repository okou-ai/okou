import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatLinkNavigationTests: XCTestCase {
  func testOnlyCanonicalChatAndWorkflowLinksUseNativeNavigation() throws {
    let web = URL(string: "https://app.example.invalid")!
    let chat = web.appending(path: "chats/\(ChatLinkFixture.sourceID)")
    XCTAssertEqual(
      ChatLinkDestination(url: chat, webURL: web),
      .thread(id: ChatLinkFixture.sourceID, runID: nil))
    XCTAssertEqual(
      ChatLinkDestination(
        url: URL(string: chat.absoluteString + "#run-\(ChatLinkFixture.runID(1))")!, webURL: web),
      .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(1)))
    // External origins, external source links, and settings routes retain system handling.
    for link in [
      "https://app.example.invalid.evil/chats/\(ChatLinkFixture.sourceID)",
      "https://app.example.invalid:8443/chats/\(ChatLinkFixture.sourceID)",
      "https://example.slack.com/archives/C1/p1",
      "https://app.example.invalid/agents/\(ChatLinkFixture.agentID)/chat",
      "https://app.example.invalid/workflows/\(ChatLinkFixture.workflowID)/automations",
    ] {
      XCTAssertNil(ChatLinkDestination(url: try XCTUnwrap(URL(string: link)), webURL: web))
    }
  }

  func testWorkflowAndCrossAgentRunLinksOpenNativeChatAndRestoreTheOriginalInput() async throws {
    let fixture = ChatLinkFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.selectChat(ChatLinkFixture.homeID)
    try XCTUnwrap(store.selectedConversation).draft = "Keep my unsent reply"

    let openedWorkflow = await store.openChatLink(.workflow(id: ChatLinkFixture.workflowID))
    XCTAssertTrue(openedWorkflow)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.sourceID)
    XCTAssertEqual(store.selectedAgentID, ChatLinkFixture.otherAgentID)
    let source = try XCTUnwrap(store.selectedConversation)
    await source.refresh()
    XCTAssertFalse(source.visibleMessages.contains { $0.id == ChatLinkFixture.eventID(1) })

    let openedRun = await store.openChatLink(
      .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(1)))
    XCTAssertTrue(openedRun)
    let firstRun = try XCTUnwrap(store.selectedConversation)
    XCTAssertEqual(firstRun.readingPosition?.messageID, ChatLinkFixture.eventID(1))
    XCTAssertTrue(firstRun.visibleMessages.contains { $0.id == ChatLinkFixture.eventID(1) })
    firstRun.draft = "Draft in the source chat"

    // A second link in the current chat changes the reading target without losing the draft.
    let openedAnotherRun = await store.openChatLink(
      .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(8)))
    XCTAssertTrue(openedAnotherRun)
    let nextRun = try XCTUnwrap(store.selectedConversation)
    XCTAssertEqual(nextRun.readingPosition?.messageID, ChatLinkFixture.eventID(22))
    XCTAssertTrue(nextRun.visibleMessages.contains { $0.id == ChatLinkFixture.eventID(22) })
    XCTAssertEqual(nextRun.draft, "Draft in the source chat")
    store.selectChat(ChatLinkFixture.homeID)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.homeID)
    XCTAssertEqual(store.selectedConversation?.draft, "Keep my unsent reply")
    XCTAssertTrue(fixture.requests.values.withLock { $0.allSatisfy { $0.hasPrefix("GET ") } })
  }

  func testUnavailableWorkflowStaysInTheCurrentChatWithANativeError() async throws {
    let fixture = ChatLinkFixture(workflow: { _ in
      ChatHTTPResponse(status: 404, body: #"{"error":{"message":"Workflow not found"}}"#)
    })
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    store.selectChat(ChatLinkFixture.homeID)
    let opened = await store.openChatLink(.workflow(id: ChatLinkFixture.workflowID))
    XCTAssertFalse(opened)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.homeID)
    XCTAssertEqual(store.chatLinkError, "Workflow not found")
    store.dismissChatLinkError()
    XCTAssertNil(store.chatLinkError)

    let missing = await store.openChatLink(.thread(id: UUID().uuidString.lowercased(), runID: nil))
    XCTAssertFalse(missing)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.homeID)
    XCTAssertEqual(store.chatLinkError, "This chat is no longer available in this workspace.")
  }

  func testSelectingAChatPublishesDurableHistoryBeforeNetworkCatchUpCompletes() async throws {
    let holdNetwork = Mutex(false)
    let started = expectation(description: "Conversation catch-up is held")
    let gate = ModelResponseGate()
    defer { gate.open() }
    let fixture = ChatLinkFixture(beforeEventRows: { _ in
      if holdNetwork.withLock({ $0 }) {
        started.fulfill()
        await gate.wait()
      }
    })
    let cacheDirectory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let previous = fixture.workspace(cache: cacheDirectory.cache(scope: scope))
    await previous.refresh()
    previous.selectChat(ChatLinkFixture.sourceID)
    await previous.selectedConversation?.refresh()
    previous.close()

    holdNetwork.withLock { $0 = true }
    let store = fixture.workspace(cache: cacheDirectory.cache(scope: scope))
    defer { store.close() }
    await store.list.restoreCached()
    store.selectChat(ChatLinkFixture.sourceID)
    let conversation = try XCTUnwrap(store.selectedConversation)
    let refreshing = Task { await conversation.refresh() }
    addTeardownBlock {
      refreshing.cancel()
      gate.open()
      await refreshing.value
    }
    await fulfillment(of: [started], timeout: 3)
    XCTAssertEqual(conversation.messages.first?.id, ChatLinkFixture.eventID(1))
    XCTAssertEqual(conversation.messages.last?.id, ChatLinkFixture.eventID(59))
    gate.open()
    await refreshing.value
    XCTAssertNil(conversation.error)
  }

  func testRunLinkShowsCachedChatWhileResolvingANewRunAndAllowsLeavingIt() async throws {
    let holdNetwork = Mutex(false)
    let eventCount = Mutex(60)
    let started = expectation(description: "New run catch-up is held")
    let gate = ModelResponseGate()
    defer { gate.open() }
    let fixture = ChatLinkFixture(
      beforeEventRows: { _ in
        if holdNetwork.withLock({ $0 }) {
          started.fulfill()
          await gate.wait()
        }
      }, eventCount: { eventCount.withLock { $0 } })
    let cacheDirectory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let previous = fixture.workspace(cache: cacheDirectory.cache(scope: scope))
    await previous.refresh()
    let seeded = await previous.openChatLink(
      .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(1)))
    XCTAssertTrue(seeded)
    previous.close()

    eventCount.withLock { $0 = 90 }
    holdNetwork.withLock { $0 = true }
    let store = fixture.workspace(cache: cacheDirectory.cache(scope: scope))
    defer { store.close() }
    await store.list.restoreCached()
    store.selectChat(ChatLinkFixture.homeID)
    let opening = Task {
      await store.openChatLink(
        .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(21)))
    }
    addTeardownBlock {
      opening.cancel()
      gate.open()
      _ = await opening.value
    }
    await fulfillment(of: [started], timeout: 3)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.sourceID)
    XCTAssertEqual(store.selectedConversation?.messages.first?.id, ChatLinkFixture.eventID(1))
    store.selectChat(ChatLinkFixture.homeID)
    gate.open()
    let opened = await opening.value
    XCTAssertFalse(opened)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.homeID)
  }

  func testLeavingOrClosingTheWorkspaceCancelsAPendingSourceNavigation() async throws {
    for close in [false, true] {
      let started = expectation(description: "Workflow source lookup started")
      let gate = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
      defer { gate.continuation.finish() }
      let fixture = ChatLinkFixture(workflow: { _ in
        started.fulfill()
        for await _ in gate.stream { break }
        return ChatHTTPResponse(
          body: "{\"automations\":[{\"chatThreadId\":\"\(ChatLinkFixture.sourceID)\"}]}")
      })
      let store = fixture.workspace()
      defer { store.close() }
      await store.refresh()
      store.selectChat(ChatLinkFixture.homeID)
      let opening = Task { await store.openChatLink(.workflow(id: ChatLinkFixture.workflowID)) }
      await fulfillment(of: [started], timeout: 2)
      if close { store.close() } else { store.startNewChat() }
      gate.continuation.yield(())
      gate.continuation.finish()
      let opened = await opening.value
      XCTAssertFalse(opened)
      XCTAssertEqual(store.selectedThreadID, close ? ChatLinkFixture.homeID : nil)
      XCTAssertNil(store.chatLinkError)
    }
  }
}

final class ChatLinkFixture: Sendable {
  static let homeID = "74000000-0000-4000-8000-000000000001"
  static let sourceID = "74000000-0000-4000-8000-000000000002"
  static let agentID = "74000000-0000-4000-8000-000000000003"
  static let otherAgentID = "74000000-0000-4000-8000-000000000004"
  static let workflowID = "74000000-0000-4000-8000-000000000005"
  let requests = HistoryRequests()
  let http: ChatHTTPFixture

  init(
    workflow: ChatHTTPFixture.Handler? = nil,
    beforeEventRows: (@Sendable (URLRequest) async throws -> Void)? = nil,
    eventCount: @escaping @Sendable () -> Int = { 60 }
  ) {
    let requests = requests
    http = ChatHTTPFixture { request in
      requests.values.withLock {
        $0.append("\(request.httpMethod ?? "GET") \(request.url?.path ?? "")")
      }
      let path = request.url?.path ?? ""
      switch path {
      case "/api/run-models", "/api/model-catalog", "/api/user-model-preference",
        "/api/feature-switches":
        return try XCTUnwrap(ModelHTTPFixtures.response(path))
      case "/api/workflows/\(Self.workflowID)":
        if let workflow { return try await workflow(request) }
        return ChatHTTPResponse(
          body: """
            {"automations":[{"chatThreadId":"\(Self.sourceID)"},{"chatThreadId":"\(Self.sourceID)"}]}
            """)
      case "/api/chat-threads/snapshot":
        let threads = [(Self.homeID, Self.agentID), (Self.sourceID, Self.otherAgentID)].map {
          id, agent in
          """
          {"id":"\(id)","agentId":"\(agent)","title":"Source chat","createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}
          """
        }.joined(separator: ",")
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      case "/api/chat-threads/\(Self.sourceID)/metadata":
        return ChatHTTPResponse(
          body:
            "{\"id\":\"\(Self.sourceID)\",\"agentId\":\"\(Self.otherAgentID)\",\"selectedModel\":null,\"modelSettings\":{},\"serviceTier\":null}"
        )
      case "/api/chat-threads/\(Self.sourceID)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: #"{"error":{"code":"CHAT_EVENT_SNAPSHOT_NOT_FOUND","message":"No snapshot"}}"#)
      case "/api/chat-threads/\(Self.sourceID)/event-rows":
        try await beforeEventRows?(request)
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        let count = eventCount()
        let end = min(count, after + 50)
        let rows = after < end ? ((after + 1)...end).map(Self.row).joined(separator: ",") : ""
        return ChatHTTPResponse(
          body: """
            {"rows":[\(rows)],"cursor":{"lastEventId":"\(Self.eventID(end))","lastSeqId":\(end)},"hasMore":\(end < count)}
            """)
      case "/api/chat-threads/\(Self.sourceID)":
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor
  func workspace(conversationLimit: Int = 8, cache: ChatCache? = nil) -> WorkspaceStore {
    WorkspaceStore(
      client: http.client, webURL: URL(string: "https://app.example.invalid")!,
      cache: cache, conversationLimit: conversationLimit)
  }

  static func eventID(_ sequence: Int) -> String {
    String(format: "75000000-0000-4000-8000-%012d", sequence)
  }

  static func runID(_ index: Int) -> String {
    String(format: "76000000-0000-4000-8000-%012d", index)
  }

  private static func row(_ sequence: Int) -> String {
    let index = (sequence - 1) / 3 + 1
    let type: String
    let payload: String
    switch sequence % 3 {
    case 1:
      type = sequence == 4 ? "input.automation" : "input.prompt"
      let source: String
      if sequence == 1 {
        source = """
          {"type":"source","kind":"agent","agentId":"\(otherAgentID)","threadId":"\(sourceID)","runId":"\(runID(8))","titleSnapshot":"Source round 8"},
          """
      } else if sequence == 4 {
        source = """
          {"type":"automation","workflowId":"\(workflowID)","workflowName":"Recurring source"},
          """
      } else {
        source = ""
      }
      payload =
        "{\"userMessage\":{\"version\":1,\"parts\":[\(source){\"type\":\"text\",\"text\":\"Question \(index)\"}]}}"
    case 2:
      type = "output.message"
      payload = "{\"content\":\"Answer \(index). Context from the earlier conversation.\"}"
    default:
      type = "run.completed"
      payload = "{}"
    }
    return """
      {"id":"\(eventID(sequence))","chatThreadId":"\(sourceID)","runId":"\(runID(index))","seqId":\(sequence),"createdAt":"2026-10-20T00:00:00Z","eventType":"\(type)","payload":\(payload)}
      """
  }
}
