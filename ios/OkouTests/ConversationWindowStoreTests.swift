import XCTest

@testable import Okou

@MainActor
final class ConversationWindowStoreTests: XCTestCase {
  func testLongHistoriesRetainFullProjectionAndPublishOnlyLatestGroups() async {
    for count in [100, 1_000, 5_000] {
      let fixture = ConversationHistoryFixture(count: count)
      let conversation = fixture.conversation()
      await conversation.refresh()
      XCTAssertNil(conversation.error)
      XCTAssertEqual(conversation.messages.count, count)
      XCTAssertEqual(
        conversation.visibleMessages.map(\.id),
        ((count - 9)...count).map(ConversationHistoryFixture.id))
      conversation.close()
    }
  }
  func testRecreatedStoreHydratesFullHistoryWithAnInitialWindow() async throws {
    let fixture = ConversationHistoryFixture()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let original = fixture.conversation(cache: ChatCache(scope: scope, directory: directory))
    await original.refresh()
    await original.loadEarlierMessages()
    original.rememberReadingPosition(
      ConversationReadingPosition(messageID: ConversationHistoryFixture.id(95), offset: -42))
    XCTAssertEqual(original.visibleMessages.count, 20)
    original.close()

    let restored = fixture.conversation(cache: ChatCache(scope: scope, directory: directory))
    defer { restored.close() }
    await restored.refresh()
    XCTAssertEqual(restored.messages, original.messages)
    XCTAssertEqual(restored.messages.count, 100)
    XCTAssertEqual(
      restored.visibleMessages.map(\.id), (91...100).map(ConversationHistoryFixture.id))
    XCTAssertNil(restored.readingPosition)
  }

  func testExpansionAndRemoteUpdatesRetainReadingWindowAndFullHistory() async {
    let fixture = ConversationHistoryFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.count, 100)
    XCTAssertEqual(
      conversation.visibleMessages.map(\.id), (91...100).map(ConversationHistoryFixture.id))
    let position = ConversationReadingPosition(
      messageID: ConversationHistoryFixture.id(95), offset: -42)
    conversation.rememberReadingPosition(position)
    async let first: Void = conversation.loadEarlierMessages()
    async let overlapping: Void = conversation.loadEarlierMessages()
    _ = await (first, overlapping)
    XCTAssertEqual(conversation.visibleMessages.first?.id, ConversationHistoryFixture.id(81))
    fixture.appendMessage()
    await conversation.refresh()
    XCTAssertEqual(conversation.messages.count, 101)
    XCTAssertEqual(conversation.visibleMessages.count, 21)
    XCTAssertEqual(conversation.readingPosition, position)
    fixture.revoke(95)
    await conversation.refresh()
    XCTAssertFalse(conversation.messages.contains { $0.id == position.messageID })
    XCTAssertEqual(conversation.readingPosition?.messageID, ConversationHistoryFixture.id(96))
    conversation.resetRenderWindowToLatest()
    XCTAssertEqual(
      conversation.visibleMessages.map(\.id),
      (90...101).filter { $0 != 95 }.map(ConversationHistoryFixture.id))
    XCTAssertNil(conversation.readingPosition)
    XCTAssertEqual(conversation.messages.count, 100)
  }

  func testFailedSendAndRetryRemainVisibleWhileReadingOlderHistory() async throws {
    let fixture = ConversationHistoryFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    await conversation.loadEarlierMessages()
    conversation.draft = "Keep this input"
    await conversation.send()
    let pending = try XCTUnwrap(conversation.pending.first)
    XCTAssertTrue(pending.needsRetry)
    XCTAssertEqual(conversation.visibleMessages.last?.id, pending.id)
    await conversation.retry(pending)
    XCTAssertEqual(conversation.pending.map(\.id), [pending.id])
    XCTAssertEqual(conversation.visibleMessages.filter { $0.id == pending.id }.count, 1)
    conversation.resetRenderWindowToLatest()
    XCTAssertEqual(conversation.visibleMessages.last?.id, pending.id)
  }

  func testClosingDuringExpansionPreventsPublishingPreparedHistory() async {
    let fixture = ConversationHistoryFixture()
    let conversation = fixture.conversation()
    await conversation.refresh()
    let expansion = Task { await conversation.loadEarlierMessages() }
    let deadline = ContinuousClock.now + .seconds(2)
    while !conversation.isLoadingEarlier && ContinuousClock.now < deadline { await Task.yield() }
    XCTAssertTrue(conversation.isLoadingEarlier)
    conversation.close()
    await expansion.value
    XCTAssertEqual(conversation.visibleMessages.count, 10)
    XCTAssertFalse(conversation.isLoadingEarlier)
  }
}
