import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatForkTests: XCTestCase {
  func testForkPreservesBothDraftsAndSendsQuoteAndSourceWithoutNavigating() async throws {
    let fixture = ForkFixture()
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    let source = try XCTUnwrap(workspace.selectedConversation)
    source.draft = "Keep the current chat draft"
    workspace.newChatDraft = "Keep the next chat draft"
    let message = try XCTUnwrap(source.messages.first)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: (message.text as NSString).range(of: "selected 🌷 passage")))
    workspace.startFork(selection, from: source)
    let fork = try XCTUnwrap(workspace.fork)
    let note = try XCTUnwrap(fork.composer.editorBlocks.first(where: \.isFeedback))
    fork.composer.editBlock(note.id, text: "Explain the risks")
    let accepted = await fork.send()
    XCTAssertTrue(accepted)
    XCTAssertNil(workspace.fork)
    XCTAssertEqual(workspace.selectedThreadID, source.thread.id)
    XCTAssertEqual(source.draft, "Keep the current chat draft")
    XCTAssertEqual(workspace.newChatDraft, "Keep the next chat draft")
    let request = try XCTUnwrap(fixture.writes.value.withLock { $0.messages.first })
    let sent = try JSONDecoder().decode(ForkSend.self, from: request)
    XCTAssertEqual(sent.sourceRunId, ForkFixture.runID)
    XCTAssertNotEqual(sent.threadId, source.thread.id)
    let feedback = try XCTUnwrap(sent.userMessage.parts.first { $0["type"]?.string == "feedback" })
    XCTAssertEqual(feedback["quote"]?.string, selection.quote)
    XCTAssertEqual(feedback["eventId"]?.string, message.id)
    XCTAssertEqual(feedback["range"], selection.part["range"])
    XCTAssertEqual(
      feedback["note"],
      .array([.object(["type": .string("text"), "text": .string("Explain the risks")])]))
    let success = try XCTUnwrap(workspace.threadFeedback)
    XCTAssertEqual(success.actionTitle, "Open")
    await success.action()
    XCTAssertEqual(workspace.selectedThreadID, sent.threadId)
  }

  func testFailedSendRetainsSheetAndRetriesTheSameMessageAndThread() async throws {
    let fixture = ForkFixture(firstSendStatus: 503)
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    let source = try XCTUnwrap(workspace.selectedConversation)
    let selection = try fixture.selection(in: source)
    workspace.startFork(selection, from: source)
    let fork = try XCTUnwrap(workspace.fork)
    let firstAccepted = await fork.send()
    XCTAssertFalse(firstAccepted)
    XCTAssertNotNil(workspace.fork)
    XCTAssertNotNil(fork.error)
    XCTAssertTrue(fork.composer.document.hasFeedback)
    let accepted = await fork.send()
    XCTAssertTrue(accepted)
    let writes = fixture.writes.value.withLock { $0 }
    let sends = try writes.messages.map { try JSONDecoder().decode(ForkSend.self, from: $0) }
    XCTAssertEqual(writes.creations.count, 1)
    XCTAssertEqual(sends.count, 2)
    XCTAssertEqual(sends.first?.threadId, sends.last?.threadId)
    XCTAssertEqual(sends.first?.clientEventId, sends.last?.clientEventId)
    XCTAssertEqual(sends.first?.userMessage, sends.last?.userMessage)
    XCTAssertEqual(sends.last?.sourceRunId, ForkFixture.runID)
    XCTAssertEqual(workspace.selectedThreadID, source.thread.id)
  }

  func testCancelCreatesNothingAndRemovingRejectedQuoteKeepsItsNote() async throws {
    let fixture = ForkFixture(firstSendStatus: 400)
    let workspace = try await fixture.workspace()
    defer { workspace.close() }
    let source = try XCTUnwrap(workspace.selectedConversation)
    let selection = try fixture.selection(in: source)
    workspace.startFork(selection, from: source)
    workspace.dismissFork()
    XCTAssertTrue(fixture.writes.value.withLock { $0.creations.isEmpty && $0.messages.isEmpty })
    workspace.startFork(selection, from: source)
    let fork = try XCTUnwrap(workspace.fork)
    let block = try XCTUnwrap(fork.composer.editorBlocks.first(where: \.isFeedback))
    fork.composer.editBlock(block.id, text: "An independent question")
    let rejected = await fork.send()
    XCTAssertFalse(rejected)
    fork.composer.removeFeedback(block.id)
    XCTAssertEqual(fork.composer.text, "An independent question")
    let accepted = await fork.send()
    XCTAssertTrue(accepted)
    let data = try XCTUnwrap(fixture.writes.value.withLock { $0.messages.last })
    let sent = try JSONDecoder().decode(ForkSend.self, from: data)
    XCTAssertNil(sent.sourceRunId)
    XCTAssertEqual(sent.userMessage.text, "An independent question")
  }

  private struct ForkSend: Decodable {
    let threadId: String
    let clientEventId: String
    let sourceRunId: String?
    let userMessage: ChatDraftDocument
  }
}

private final class ForkFixture: Sendable {
  static let runID = "91000000-0000-4000-8000-000000000001"
  struct Writes: Sendable {
    var creations: [Data] = []
    var messages: [Data] = []
    var threadID = ""
  }
  let writes = ForkWrites()
  let history: ConversationHistoryFixture

  init(firstSendStatus: Int? = nil) {
    let writes = writes
    history = ConversationHistoryFixture(
      rows: [
        """
        {"id":"\(ConversationHistoryFixture.id(1))","chatThreadId":"\(ConversationHistoryFixture.threadID)","runId":"\(Self.runID)","seqId":1,"eventType":"output.message","createdAt":"2026-10-20T10:00:00Z","payload":{"content":"Prefix selected 🌷 passage. Suffix."}}
        """
      ],
      send: { request in
        let count = writes.value.withLock { state in
          state.messages.append(chatRequestBody(request))
          return state.messages.count
        }
        if let firstSendStatus, count == 1 {
          return ChatHTTPResponse(
            status: firstSendStatus, body: #"{"error":{"message":"Delivery unavailable"}}"#)
        }
        return ChatHTTPResponse(
          status: 201, body: "{\"threadId\":\"\(writes.value.withLock { $0.threadID })\"}")
      },
      additional: { request in
        let path = request.url?.path ?? ""
        switch path {
        case "/api/agents":
          return ChatHTTPResponse(
            body:
              "[{\"agentId\":\"\(ConversationHistoryFixture.agentID)\",\"displayName\":\"Okou\",\"isDefaultAgent\":true}]"
          )
        case "/api/feature-switches":
          return ChatHTTPResponse(body: #"{"effectiveSwitches":{}}"#)
        case "/api/user-model-preference":
          return ChatHTTPResponse(body: "{}")
        case "/api/run-models", "/api/model-catalog":
          return ChatHTTPResponse(body: #"{"models":[],"routes":[]}"#)
        case "/api/chat-threads":
          let data = chatRequestBody(request)
          let input = try JSONDecoder().decode(Create.self, from: data)
          writes.value.withLock {
            $0.creations.append(data)
            $0.threadID = input.clientThreadId
          }
          return ChatHTTPResponse(
            status: 201,
            body: "{\"id\":\"\(input.clientThreadId)\",\"createdAt\":\"2026-10-20T10:00:00Z\"}")
        case let path where path.hasSuffix("/metadata"):
          return ChatHTTPResponse(
            body:
              "{\"id\":\"\(writes.value.withLock { $0.threadID })\",\"agentId\":\"\(ConversationHistoryFixture.agentID)\",\"computerUseHostId\":null,\"cloudBrowserEnabled\":false}"
          )
        default: throw URLError(.unsupportedURL)
        }
      })
  }

  @MainActor
  func workspace() async throws -> WorkspaceStore {
    let workspace = WorkspaceStore(client: history.http.client, webURL: history.http.baseURL)
    await workspace.refreshNavigation()
    await workspace.list.refresh()
    workspace.selectChat(ConversationHistoryFixture.threadID)
    let conversation = try XCTUnwrap(workspace.selectedConversation)
    await conversation.refresh()
    return workspace
  }

  @MainActor
  func selection(in source: ConversationStore) throws -> ChatFeedbackSelection {
    let message = try XCTUnwrap(source.messages.first)
    return try XCTUnwrap(
      ChatFeedbackSelection(
        message: message, range: NSRange(location: 0, length: message.text.utf16.count)))
  }

  private struct Create: Decodable { let clientThreadId: String }
}

private final class ForkWrites: Sendable {
  let value = Mutex(ForkFixture.Writes())
}
