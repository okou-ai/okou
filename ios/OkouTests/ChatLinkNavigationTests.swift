import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
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
    let home = try XCTUnwrap(store.selectedConversation)
    home.draft = "Keep my unsent reply"

    let openedWorkflow = await store.openChatLink(.workflow(id: ChatLinkFixture.workflowID))
    XCTAssertTrue(openedWorkflow)
    XCTAssertEqual(store.selectedThreadID, ChatLinkFixture.sourceID)
    XCTAssertEqual(store.selectedAgentID, ChatLinkFixture.otherAgentID)
    let source = try XCTUnwrap(store.selectedConversation)
    await source.refresh()
    XCTAssertFalse(source.visibleMessages.contains { $0.id == ChatLinkFixture.eventID(1) })

    let host = UIHostingController(
      rootView: ChatDetailView(conversation: source, topContentInset: 60)
        .modifier(ChatLinkNavigation(store: store)))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let openedRun = await store.openChatLink(
      .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(1)))
    XCTAssertTrue(openedRun)
    try await eventually(
      message: readingDescription(ChatLinkFixture.eventID(1), conversation: source, view: host.view)
    ) {
      abs((offset(of: ChatLinkFixture.eventID(1), in: host.view) ?? .infinity)) < 1
    }
    XCTAssertEqual(source.readingPosition?.messageID, ChatLinkFixture.eventID(1))
    XCTAssertTrue(source.visibleMessages.contains { $0.id == ChatLinkFixture.eventID(1) })
    source.draft = "Draft in the source chat"

    // A second link in the current chat must move the native viewport again.
    let openedAnotherRun = await store.openChatLink(
      .thread(id: ChatLinkFixture.sourceID, runID: ChatLinkFixture.runID(8)))
    XCTAssertTrue(openedAnotherRun)
    try await eventually {
      abs((offset(of: ChatLinkFixture.eventID(22), in: host.view) ?? .infinity)) < 1
    }
    XCTAssertEqual(source.draft, "Draft in the source chat")
    store.selectChat(ChatLinkFixture.homeID)
    XCTAssertTrue(store.selectedConversation === home)
    XCTAssertEqual(store.selectedConversation?.draft, "Keep my unsent reply")
    XCTAssertTrue(fixture.requests.values.withLock { $0.allSatisfy { $0.hasPrefix("GET ") } })
  }

  func testActivatingTheSourceLinkUsesTheWorkspaceURLHandler() async throws {
    let fixture = ChatLinkFixture()
    let store = fixture.workspace(conversationLimit: 0)
    defer { store.close() }
    await store.refresh()
    store.selectChat(ChatLinkFixture.homeID)
    let conversation = try XCTUnwrap(store.conversation(for: ChatLinkFixture.sourceID))
    await conversation.refresh()
    let agentMessage = try XCTUnwrap(conversation.messages.first)
    let workflowMessage = try XCTUnwrap(
      conversation.messages.first { $0.id == ChatLinkFixture.eventID(4) })
    let host = UIHostingController(
      rootView: VStack {
        UserMessageView(
          message: workflowMessage, webURL: store.webURL,
          viewer: conversation.attachmentViewer, loadsAttachments: false
        )
        .buttonStyle(LinkActivationStyle(identifier: "activate-workflow-source"))
        UserMessageView(
          message: agentMessage, webURL: store.webURL,
          viewer: conversation.attachmentViewer, loadsAttachments: false
        )
        .buttonStyle(LinkActivationStyle(identifier: "activate-agent-source"))
      }
      .modifier(ChatLinkNavigation(store: store)))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    func button(_ id: String, in view: UIView) -> UIButton? {
      if let button = view as? UIButton, button.accessibilityIdentifier == id {
        return button
      }
      return view.subviews.lazy.compactMap { button(id, in: $0) }.first
    }
    try await eventually { button("activate-workflow-source", in: host.view) != nil }
    let workflow = try XCTUnwrap(button("activate-workflow-source", in: host.view))
    workflow.sendActions(for: .touchUpInside)
    try await eventually { store.selectedThreadID == ChatLinkFixture.sourceID }
    XCTAssertNil(store.selectedConversation?.readingPosition)
    store.selectChat(ChatLinkFixture.homeID)
    let link = try XCTUnwrap(button("activate-agent-source", in: host.view))
    link.sendActions(for: .touchUpInside)
    try await eventually {
      store.selectedThreadID == ChatLinkFixture.sourceID
        && store.selectedConversation?.readingPosition?.messageID == ChatLinkFixture.eventID(22)
    }
    XCTAssertNil(store.chatLinkError)
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

/// Activate SwiftUI's real Link through its public primitive-button contract.
private struct LinkActivationStyle: PrimitiveButtonStyle {
  let identifier: String
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.overlay {
      LinkActivationButton(identifier: identifier, activate: configuration.trigger)
    }
  }
}

private struct LinkActivationButton: UIViewRepresentable {
  let identifier: String
  let activate: () -> Void

  func makeUIView(context: Context) -> UIButton {
    let button = UIButton(type: .custom)
    button.accessibilityIdentifier = identifier
    return button
  }

  func updateUIView(_ button: UIButton, context: Context) {
    let id = UIAction.Identifier("activate-source-link")
    button.removeAction(identifiedBy: id, for: .touchUpInside)
    button.addAction(UIAction(identifier: id) { _ in activate() }, for: .touchUpInside)
  }
}

private final class ChatLinkFixture: Sendable {
  static let homeID = "74000000-0000-4000-8000-000000000001"
  static let sourceID = "74000000-0000-4000-8000-000000000002"
  static let agentID = "74000000-0000-4000-8000-000000000003"
  static let otherAgentID = "74000000-0000-4000-8000-000000000004"
  static let workflowID = "74000000-0000-4000-8000-000000000005"
  let requests = HistoryRequests()
  let http: ChatHTTPFixture

  init(workflow: ChatHTTPFixture.Handler? = nil) {
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
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
          .queryItems?.first { $0.name == "sinceSeqId" }?.value.flatMap(Int.init) ?? 0
        let end = min(60, after + 50)
        let rows = after < end ? ((after + 1)...end).map(Self.row).joined(separator: ",") : ""
        return ChatHTTPResponse(
          body: """
            {"rows":[\(rows)],"cursor":{"lastEventId":"\(Self.eventID(end))","lastSeqId":\(end)},"hasMore":\(end < 60)}
            """)
      case "/api/chat-threads/\(Self.sourceID)":
        return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  @MainActor
  func workspace(conversationLimit: Int = 8) -> WorkspaceStore {
    WorkspaceStore(
      client: http.client, webURL: URL(string: "https://app.example.invalid")!,
      conversationLimit: conversationLimit)
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
