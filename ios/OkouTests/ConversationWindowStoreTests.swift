import ChatData
import XCTest

@testable import Okou

@MainActor
final class ConversationWindowStoreTests: XCTestCase {
  func testLongHistoryRetainsFullProjectionAndPublishesLatestMessagesInOrder() async {
    let count = 1_000
    let fixture = ConversationHistoryFixture(count: count)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertNil(conversation.error)
    let expected = (1...count).map(ConversationHistoryFixture.id)
    XCTAssertEqual(conversation.messages.map(\.id), expected)
    let visible = conversation.visibleMessages.map(\.id)
    XCTAssertEqual(visible.last, expected.last)
    XCTAssertEqual(visible, Array(expected.suffix(visible.count)))
  }
  func testRecreatedStoreHydratesFullHistoryWithAnInitialWindow() async throws {
    let fixture = ConversationHistoryFixture()
    let cacheDirectory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let original = fixture.conversation(cache: cacheDirectory.cache(scope: scope))
    defer { original.close() }
    await original.refresh()
    await original.loadEarlierMessages()
    let history = original.messages
    let readingID = try XCTUnwrap(original.visibleMessages.first?.id)
    original.rememberReadingPosition(
      ConversationReadingPosition(messageID: readingID, offset: -42))
    original.close()

    let restored = fixture.conversation(cache: cacheDirectory.cache(scope: scope))
    defer { restored.close() }
    await restored.refresh()
    XCTAssertEqual(restored.messages, history)
    XCTAssertEqual(restored.messages.count, 100)
    let visible = restored.visibleMessages.map(\.id)
    XCTAssertEqual(visible.last, history.last?.id)
    XCTAssertEqual(visible, Array(history.map(\.id).suffix(visible.count)))
    XCTAssertNil(restored.readingPosition)
  }

  func testExpansionAndRemoteUpdatesRetainReadingWindowAndFullHistory() async throws {
    let fixture = ConversationHistoryFixture()
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let expected = (1...100).map(ConversationHistoryFixture.id)
    XCTAssertEqual(conversation.messages.map(\.id), expected)
    let initial = conversation.visibleMessages.map(\.id)
    let readingID = try XCTUnwrap(initial.first)
    let readingSequence = try XCTUnwrap(
      (1...100).first { ConversationHistoryFixture.id($0) == readingID })
    let position = ConversationReadingPosition(
      messageID: readingID, offset: -42)
    conversation.rememberReadingPosition(position)
    async let first: Void = conversation.loadEarlierMessages()
    async let overlapping: Void = conversation.loadEarlierMessages()
    _ = await (first, overlapping)
    let expanded = conversation.visibleMessages.map(\.id)
    XCTAssertGreaterThan(expanded.count, initial.count)
    XCTAssertEqual(expanded, Array(expected.suffix(expanded.count)))
    XCTAssertEqual(Array(expanded.suffix(initial.count)), initial)
    fixture.appendMessage()
    await conversation.refresh()
    let latestID = ConversationHistoryFixture.id(101)
    XCTAssertEqual(conversation.messages.map(\.id), expected + [latestID])
    XCTAssertEqual(conversation.visibleMessages.map(\.id), expanded + [latestID])
    XCTAssertEqual(conversation.readingPosition, position)
    fixture.revoke(readingSequence)
    await conversation.refresh()
    let remaining = expected.filter { $0 != readingID } + [latestID]
    XCTAssertEqual(conversation.messages.map(\.id), remaining)
    XCTAssertEqual(
      conversation.readingPosition?.messageID, ConversationHistoryFixture.id(readingSequence + 1))
    let rebased = conversation.readingPosition
    conversation.rememberReadingPosition(position)
    XCTAssertEqual(conversation.readingPosition, rebased)
    conversation.resetRenderWindowToLatest()
    let latest = conversation.visibleMessages.map(\.id)
    XCTAssertEqual(latest.last, latestID)
    XCTAssertEqual(latest, Array(remaining.suffix(latest.count)))
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
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertTrue(conversation.hasEarlierMessages)
    let expansion = Task.immediate { await conversation.loadEarlierMessages() }
    addTeardownBlock {
      expansion.cancel()
      await expansion.value
    }
    let visibleAtClose = conversation.visibleMessages.map(\.id)
    conversation.close()
    await expansion.value
    XCTAssertEqual(conversation.visibleMessages.map(\.id), visibleAtClose)
  }
}
