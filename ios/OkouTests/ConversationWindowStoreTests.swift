import ChatData
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
    let cacheDirectory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let original = fixture.conversation(cache: cacheDirectory.cache(scope: scope))
    await original.refresh()
    await original.loadEarlierMessages()
    original.rememberReadingPosition(
      ConversationReadingPosition(messageID: ConversationHistoryFixture.id(95), offset: -42))
    XCTAssertEqual(original.visibleMessages.count, 20)
    original.close()

    let restored = fixture.conversation(cache: cacheDirectory.cache(scope: scope))
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
    let rebased = conversation.readingPosition
    conversation.rememberReadingPosition(position)
    XCTAssertEqual(conversation.readingPosition, rebased)
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
    for iteration in 1...5 {
      let fixture = ConversationHistoryFixture()
      let origin = fixture.http.baseURL.absoluteString
      print("A02_PROBE_START:\(iteration):\(origin)")
      let conversation = fixture.conversation()
      defer { conversation.close() }
      await conversation.refresh()
      XCTAssertTrue(conversation.hasEarlierMessages, "A02_PROBE_HAS_EARLIER:\(iteration)")
      let expansion = Task.immediate { await conversation.loadEarlierMessages() }
      addTeardownBlock {
        expansion.cancel()
        await expansion.value
      }
      let visibleAtClose = conversation.visibleMessages.map(\.id)
      print("A02_PROBE_CLOSE:\(iteration):\(origin)")
      conversation.close()
      await expansion.value
      print("A02_PROBE_JOINED:\(iteration):\(origin)")
      XCTAssertEqual(
        conversation.visibleMessages.map(\.id), visibleAtClose,
        "A02_PROBE_VISIBLE_HISTORY:\(iteration)")
    }
  }
}
