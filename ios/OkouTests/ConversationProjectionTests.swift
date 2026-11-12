import ChatData
import ChatDomain
import XCTest

@testable import Okou

@MainActor
final class ConversationProjectionTests: XCTestCase {
  private static let runID = "60000000-0000-4000-8000-000000000003"

  func testDurableConfirmationReplacesPendingInputOnceWithoutLosingReadingPositionOrDraft()
    async throws
  {
    let fixture = ConversationHistoryFixture(count: 40)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    await conversation.loadEarlierMessages()
    let anchor = try XCTUnwrap(conversation.visibleMessages.first?.id)
    let position = ConversationReadingPosition(messageID: anchor, offset: -24)
    conversation.rememberReadingPosition(position)
    conversation.draft = "An uncertain local input"
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    conversation.draft = "Keep this next draft"
    fixture.append(try row(41, type: "input.prompt", text: pending.text, eventID: pending.id))

    await conversation.refresh()

    XCTAssertNil(conversation.historySyncError)
    XCTAssertTrue(conversation.pending.isEmpty)
    XCTAssertEqual(conversation.messages.filter { $0.id == pending.id }.map(\.text), [pending.text])
    XCTAssertEqual(conversation.visibleMessages.last?.id, pending.id)
    XCTAssertEqual(conversation.readingPosition, position)
    XCTAssertEqual(conversation.draft, "Keep this next draft")
  }

  func testCollapsingWorkRebasesItsHiddenReadingAnchorAndKeepsExpansionAcrossRefresh()
    async throws
  {
    let fixture = ConversationHistoryFixture(rows: [
      try row(1, type: "input.prompt", text: "Start"),
      try row(2, text: "Earlier reasoning"), try row(3, text: "Final answer"),
      try row(4, type: "run.completed"),
    ])
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let section = try XCTUnwrap(conversation.history?.workSections.first)
    XCTAssertTrue(section.isCollapsible)
    conversation.toggleWorkHistory(section.id)
    XCTAssertTrue(
      conversation.visibleMessages.contains { $0.id == ConversationHistoryFixture.id(2) })
    await conversation.refresh()
    XCTAssertTrue(
      conversation.visibleMessages.contains { $0.id == ConversationHistoryFixture.id(2) })
    let position = ConversationReadingPosition(
      messageID: ConversationHistoryFixture.id(2), offset: -18)
    conversation.rememberReadingPosition(position)
    conversation.draft = "Keep the native draft"

    conversation.toggleWorkHistory(section.id)

    XCTAssertEqual(conversation.readingPosition?.messageID, ConversationHistoryFixture.id(3))
    XCTAssertEqual(conversation.readingPosition?.offset, position.offset)
    XCTAssertEqual(
      conversation.visibleMessages.filter { $0.role != .system }.map(\.text),
      ["Start", "Final answer"])
    conversation.toggleWorkHistory(section.id)
    XCTAssertTrue(
      conversation.visibleMessages.contains { $0.id == ConversationHistoryFixture.id(2) })
    XCTAssertEqual(conversation.draft, "Keep the native draft")
  }

  func testDurableOutputReplacesObservedLiveTextWithTheSameIdentity() async throws {
    let fixture = ConversationHistoryFixture(rows: [try row(1, type: "input.prompt", text: "Start")]
    )
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let realtime = ProjectionRealtimeFixture()
    conversation.runOutput = realtime.subscribe
    conversation.setDetailVisible(true, owner: UUID())
    await conversation.refresh()
    let receive = try XCTUnwrap(realtime.receive)
    let eventID = ConversationHistoryFixture.id(2)
    receive(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: Self.runID,
        eventID: eventID, chunkIndex: 0, delta: "Live answer"))
    try await waitForBusinessResult { conversation.streamedOutputs.first?.text == "Live answer" }
    conversation.draft = "An unsent draft"
    fixture.append(try row(2, text: "Durable answer", eventID: eventID))

    await conversation.refresh()

    XCTAssertTrue(conversation.streamedOutputs.isEmpty)
    XCTAssertEqual(
      conversation.visibleMessages.filter { $0.id == eventID }.map(\.text), ["Durable answer"])
    receive(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: Self.runID,
        eventID: eventID, chunkIndex: 1, delta: " late chunk"))
    XCTAssertTrue(conversation.streamedOutputs.isEmpty)
    XCTAssertEqual(conversation.draft, "An unsent draft")
  }

  func testReplacingRunRetiresOldLiveTextWhileKeepingConfirmedHistory() async throws {
    let fixture = ConversationHistoryFixture(rows: [try row(1, type: "input.prompt", text: "Start")]
    )
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let realtime = ProjectionRealtimeFixture()
    conversation.runOutput = realtime.subscribe
    conversation.setDetailVisible(true, owner: UUID())
    await conversation.refresh()
    let old = try XCTUnwrap(realtime.receive)
    old(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: Self.runID,
        eventID: ConversationHistoryFixture.id(10), chunkIndex: 0, delta: "Old run"))
    try await waitForBusinessResult { conversation.streamedOutputs.first?.text == "Old run" }
    let newer = "60000000-0000-4000-8000-000000000004"
    fixture.append(try row(2, type: "input.prompt", text: "New request", runID: newer))

    await conversation.refresh()

    XCTAssertTrue(conversation.streamedOutputs.isEmpty)
    XCTAssertEqual(conversation.messages.map(\.text), ["Start", "New request"])
    old(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: Self.runID,
        eventID: ConversationHistoryFixture.id(10), chunkIndex: 1, delta: " late"))
    let current = try XCTUnwrap(realtime.receive)
    current(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: newer,
        eventID: ConversationHistoryFixture.id(11), chunkIndex: 0, delta: "New run"))
    try await waitForBusinessResult { conversation.streamedOutputs.first?.text == "New run" }
    XCTAssertEqual(conversation.streamedOutputs.map(\.text), ["New run"])
  }

  func testClosingRetiresLivePublicationWithoutChangingTheNativeWindow() async throws {
    let fixture = ConversationHistoryFixture(rows: [try row(1, type: "input.prompt", text: "Start")]
    )
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let realtime = ProjectionRealtimeFixture()
    conversation.runOutput = realtime.subscribe
    conversation.setDetailVisible(true, owner: UUID())
    await conversation.refresh()
    let receive = try XCTUnwrap(realtime.receive)
    receive(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: Self.runID,
        eventID: ConversationHistoryFixture.id(2), chunkIndex: 0, delta: "Visible before close"))
    try await waitForBusinessResult {
      conversation.streamedOutputs.first?.text == "Visible before close"
    }
    let visible = conversation.visibleItems
    let stream = conversation.streamedOutputs

    conversation.close()
    receive(
      .init(
        threadID: ConversationHistoryFixture.threadID, runID: Self.runID,
        eventID: ConversationHistoryFixture.id(2), chunkIndex: 1, delta: " retired"))
    conversation.toggleWorkHistory("retired")
    await conversation.refresh()

    XCTAssertEqual(conversation.visibleItems, visible)
    XCTAssertEqual(conversation.streamedOutputs, stream)
  }

  private func row(
    _ index: Int, type: String = "output.message", text: String = "",
    eventID: String? = nil, runID: String = ConversationProjectionTests.runID
  ) throws -> String {
    let payload: [String: Any] =
      type == "input.prompt"
      ? ["userMessage": ["version": 1, "parts": [["type": "text", "text": text]]]]
      : ["content": text]
    let row: [String: Any] = [
      "id": eventID ?? ConversationHistoryFixture.id(index),
      "chatThreadId": ConversationHistoryFixture.threadID, "seqId": index,
      "eventType": type, "runId": runID, "createdAt": "2026-10-20T00:00:00Z",
      "payload": payload,
    ]
    return String(decoding: try JSONSerialization.data(withJSONObject: row), as: UTF8.self)
  }
}

@MainActor
private final class ProjectionRealtimeFixture {
  var receive: (@MainActor @Sendable (RealtimeService.RunOutputDelta) -> Void)?

  func subscribe(
    _ runID: String,
    receive: @escaping @MainActor @Sendable (RealtimeService.RunOutputDelta) -> Void
  ) -> (@MainActor () -> Void)? {
    self.receive = receive
    return { [weak self] in self?.receive = nil }
  }
}
