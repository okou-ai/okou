import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationScrollCoordinatorTests: XCTestCase {
  func testCoordinatorUserScrollTakesOwnershipBeforeInitialPositioning() async throws {
    let fixture = CoordinatedConversationFixture(automaticallyPositionsHistory: false)
    let collection = try await fixture.mount()
    defer { fixture.close() }
    let before = collection.contentOffset.y
    XCTAssertTrue(collection.accessibilityScroll(.up))
    try await eventually { abs(collection.contentOffset.y - before) > 1 }
    await stableHostingGeometry(fixture.host.view)
    try await savedReadingPositionMatchesViewport(fixture.conversation, in: fixture.host.view)
    let position = try XCTUnwrap(fixture.conversation.readingPosition)

    // The delayed initial request must yield to the user's established viewport.
    await fixture.coordinator.latestMessageChanged()
    await stableHostingGeometry(fixture.host.view)
    XCTAssertTrue(fixture.coordinator.showsBottomButton)
    XCTAssertFalse(fixture.coordinator.followsBottom)
    XCTAssertEqual(fixture.conversation.readingPosition, position)
    XCTAssertEqual(
      offset(of: position.messageID, in: fixture.host.view) ?? .infinity,
      position.offset, accuracy: 1)
  }

  func testCoordinatorPreservesReadingAcrossRemoteUpdatesAndViewportChanges() async throws {
    let fixture = CoordinatedConversationFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    let position = try XCTUnwrap(fixture.conversation.readingPosition)
    XCTAssertTrue(fixture.coordinator.showsBottomButton)

    fixture.remote.appendMessage()
    await fixture.conversation.refresh()
    try await eventually {
      abs((offset(of: position.messageID, in: fixture.host.view) ?? .infinity) - position.offset)
        < 1
    }
    XCTAssertEqual(fixture.conversation.readingPosition, position)
    XCTAssertFalse(fixture.coordinator.followsBottom)

    let originalWidth = collection.bounds.width
    fixture.window?.frame.size.width = 520
    fixture.host.view.setNeedsLayout()
    fixture.host.view.layoutIfNeeded()
    try await eventually {
      collection.bounds.width != originalWidth
        && abs(
          (offset(of: position.messageID, in: fixture.host.view) ?? .infinity) - position.offset)
          < 1
    }
    XCTAssertEqual(fixture.conversation.readingPosition, position)
  }

  func testCoordinatorBottomRequestInterruptsPagingAndResumesFollowing() async throws {
    // Both native animation and Reduce Motion must complete the pending window reset.
    for reduceMotion in [false, true] {
      let fixture = CoordinatedConversationFixture()
      let collection = try await fixture.mount()
      defer { fixture.close() }
      fixture.coordinator.setReduceMotion(reduceMotion)
      let before = collection.contentOffset.y
      XCTAssertTrue(collection.accessibilityScroll(.up))
      try await eventually { abs(collection.contentOffset.y - before) > 1 }
      fixture.coordinator.jumpToLatest()
      try await eventually {
        fixture.conversation.visibleMessages.count == 10 && isAtBottom(collection)
      }
      XCTAssertNil(fixture.conversation.readingPosition)
      XCTAssertTrue(fixture.coordinator.followsBottom)
      XCTAssertFalse(fixture.coordinator.showsBottomButton)

      fixture.remote.appendMessage()
      await fixture.conversation.refresh()
      try await eventually {
        guard let y = offset(of: ConversationHistoryFixture.id(101), in: fixture.host.view) else {
          return false
        }
        return isAtBottom(collection) && y >= 0 && y < collection.bounds.height
      }
      XCTAssertNil(fixture.conversation.readingPosition)
    }
  }

  func testCoordinatorNewUserScrollCancelsBottomRequestWithoutShrinkingHistory() async throws {
    let fixture = CoordinatedConversationFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    let previousIDs = fixture.conversation.visibleMessages.map(\.id)
    fixture.coordinator.jumpToLatest()
    XCTAssertTrue(collection.accessibilityScroll(.up))
    try await eventually { fixture.coordinator.showsBottomButton }
    await stableHostingGeometry(fixture.host.view)
    try await savedReadingPositionMatchesViewport(fixture.conversation, in: fixture.host.view)
    XCTAssertFalse(fixture.coordinator.followsBottom)
    XCTAssertFalse(isAtBottom(collection))
    XCTAssertEqual(fixture.conversation.visibleMessages.map(\.id), previousIDs)

    let position = try XCTUnwrap(fixture.conversation.readingPosition)
    fixture.remote.appendMessage()
    await fixture.conversation.refresh()
    try await eventually {
      abs((offset(of: position.messageID, in: fixture.host.view) ?? .infinity) - position.offset)
        < 1
    }
    XCTAssertEqual(fixture.conversation.readingPosition, position)
  }

}

@MainActor
private func isAtBottom(_ scroll: UIScrollView) -> Bool {
  scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.maxY <= 20
}

@MainActor
private final class CoordinatedConversationFixture {
  let remote = ConversationHistoryFixture()
  let conversation: ConversationStore
  let coordinator: ConversationScrollCoordinator
  let host: UIHostingController<CoordinatedConversationProbe>
  private let automaticallyPositionsHistory: Bool
  private(set) var window: UIWindow?

  init(automaticallyPositionsHistory: Bool = true) {
    self.automaticallyPositionsHistory = automaticallyPositionsHistory
    let conversation = remote.conversation()
    self.conversation = conversation
    let coordinator = ConversationScrollCoordinator(conversation: conversation)
    self.coordinator = coordinator
    host = UIHostingController(
      rootView: CoordinatedConversationProbe(
        conversation: conversation, coordinator: coordinator,
        automaticallyPositionsHistory: automaticallyPositionsHistory))
  }

  func mount() async throws -> UICollectionView {
    await conversation.refresh()
    await conversation.loadEarlierMessages()
    let position = ConversationReadingPosition(
      messageID: ConversationHistoryFixture.id(94), offset: -42)
    conversation.rememberReadingPosition(position)
    window = try await mountConversationHost(host)
    if automaticallyPositionsHistory {
      try await eventually {
        abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
      }
    }
    return try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
  }

  func close() {
    if let window { unmount(window) }
    conversation.close()
  }
}

/// Real native motion/geometry exercises the coordinator independently of message styling.
private struct CoordinatedConversationProbe: View {
  let conversation: ConversationStore
  let coordinator: ConversationScrollCoordinator
  let automaticallyPositionsHistory: Bool

  var body: some View {
    let rows =
      conversation.visibleMessages.map {
        ConversationCollectionRow.message(
          $0, showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
      } + [.footer(.idle, hasMessages: true)]
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown, anchor: coordinator.anchor,
      scroll: coordinator.scroll, followsBottom: coordinator.followsBottom,
      phaseChanged: coordinator.phaseChanged, metricsChanged: coordinator.metricsChanged,
      refresh: { await conversation.refresh() }
    ) { row, anchor in
      if let message = row.message {
        Text(message.text)
          .frame(maxWidth: .infinity, minHeight: 120, maxHeight: 120)
          .background {
            if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
          }
      } else {
        Color.clear.frame(height: 20)
      }
    }
    .onAppear { coordinator.activate(reduceMotion: false) }
    .task(id: conversation.visibleMessages.last) {
      if automaticallyPositionsHistory { await coordinator.latestMessageChanged() }
    }
    .onChange(of: conversation.visibleMessages) { _, _ in coordinator.messagesChanged() }
    .onChange(of: conversation.readingPosition?.messageID) { previous, current in
      coordinator.readingPositionChanged(previousID: previous, currentID: current)
    }
    .onDisappear { coordinator.deactivate() }
  }
}
