import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

@testable import Okou

@MainActor
final class ChatThreadPreviewTests: XCTestCase {
  func testPreviewReadsLatestExchangeWithoutOpeningOrMarkingTheChatRead() async throws {
    let fixture = ConversationHistoryFixture(
      count: 4,
      indicators: { _ in
        ChatHTTPResponse(
          body: """
            {"agents":{},"threads":{"\(ConversationHistoryFixture.threadID)":"unread"},"unreadAt":{"\(ConversationHistoryFixture.threadID)":"2026-10-20T00:00:00Z"}}
            """)
      })
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.list.refresh()
    workspace.newChatDraft = "Keep this draft"

    workspace.previewChat(ConversationHistoryFixture.threadID)
    let preview = try XCTUnwrap(workspace.threadPreview)
    let content = try await preview.store.get(preview.content).value

    XCTAssertEqual(content.messages.map(\.id), [3, 4].map(ConversationHistoryFixture.id))
    XCTAssertNil(workspace.selectedThreadID)
    XCTAssertNil(workspace.selectedConversation)
    XCTAssertEqual(workspace.newChatDraft, "Keep this draft")
    XCTAssertEqual(workspace.list.threads.first?.indicator, .unread)
    XCTAssertFalse(fixture.requests.values.withLock { $0 }.contains { $0.contains("mark-read") })

    workspace.dismissChatPreview(ConversationHistoryFixture.threadID)
    XCTAssertNil(workspace.threadPreview)
    workspace.selectChat(ConversationHistoryFixture.threadID)
    XCTAssertEqual(workspace.selectedThreadID, ConversationHistoryFixture.threadID)
  }

  func testPreviewKeepsAnUnansweredPromptInsteadOfPairingItWithAnOlderReply() async throws {
    let fixture = ConversationHistoryFixture(count: 3)
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.list.refresh()
    workspace.previewChat(ConversationHistoryFixture.threadID)
    let preview = try XCTUnwrap(workspace.threadPreview)
    let content = try await preview.store.get(preview.content).value
    XCTAssertEqual(content.messages.map(\.id), [ConversationHistoryFixture.id(3)])
  }

  func testDismissingPreviewCancelsItsPendingRead() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Preview history read reached HTTP")
    let fixture = ConversationHistoryFixture(
      count: 2,
      beforeEventRows: { _ in
        started.fulfill()
        await gate.wait()
      })
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    await workspace.list.refresh()
    workspace.previewChat(ConversationHistoryFixture.threadID)
    let preview = try XCTUnwrap(workspace.threadPreview)
    let request = try preview.store.get(preview.content)
    addTeardownBlock { @MainActor in
      workspace.close()
      gate.open()
      _ = await request.result
    }
    await fulfillment(of: [started], timeout: 3)
    workspace.dismissChatPreview(ConversationHistoryFixture.threadID)
    gate.open()
    guard case .failure(let error) = await request.result else {
      return XCTFail("A dismissed preview must not publish a late response")
    }
    XCTAssertTrue(error is CancellationError)
    XCTAssertNil(workspace.threadPreview)
  }
}
