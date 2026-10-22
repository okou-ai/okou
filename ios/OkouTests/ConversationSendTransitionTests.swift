import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationSendTransitionTests: XCTestCase {
  func testFocusedSendHoldsHistoryUntilInsertionAndFinishesWithTheKeyboardDismissed() async throws {
    let fixture = SendTransitionFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    let input = try XCTUnwrap(fixture.inputs.first)
    input.becomeFirstResponder()
    input.insertText("A multiline message\nwith a second line")
    try await eventually { input.isFirstResponder && !fixture.conversation.draft.isEmpty }
    input.setMarkedText("待确认", selectedRange: NSRange(location: 3, length: 0))
    try await eventually { input.markedTextRange != nil }
    await stableHostingGeometry(fixture.host.view)
    let before = collection.contentOffset.y

    let send = Task { await fixture.scrolling.send() }
    try await eventually { !fixture.conversation.pending.isEmpty }
    let pending = try XCTUnwrap(fixture.conversation.pending.first)
    var heldFrames = 0
    try await eventually {
      if fixture.contains(pending.id, in: collection) { return true }
      heldFrames += 1
      XCTAssertEqual(collection.contentOffset.y, before, accuracy: 1)
      return false
    }
    XCTAssertGreaterThan(heldFrames, 0, "A new row requires native measurement before insertion")
    await send.value
    try await fixture.assertFinished(pending.id, in: collection)
    XCTAssertFalse(fixture.inputs.contains(where: \.isFirstResponder))
    XCTAssertTrue(fixture.inputs.allSatisfy { $0.text.isEmpty })
    XCTAssertTrue(pending.text.contains("待确认"))
    XCTAssertTrue(fixture.conversation.pending.first?.needsRetry == true)
  }

  func testSendUsesOneContinuousNativeMotionAfterTheMeasuredRowArrives() async throws {
    let fixture = SendTransitionFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    fixture.conversation.draft = "New message"
    let before = presentedOffset(collection)
    let send = Task { await fixture.scrolling.send() }
    try await eventually { !fixture.conversation.pending.isEmpty }
    let pending = try XCTUnwrap(fixture.conversation.pending.first)
    var samples = [before]
    try await eventually {
      samples.append(presentedOffset(collection))
      return fixture.contains(pending.id, in: collection)
        && collection.contentOffset.y > before + 20
        && collection.contentSize.height + collection.adjustedContentInset.bottom
          - collection.bounds.maxY <= 1
    }
    await send.value
    try await fixture.assertFinished(pending.id, in: collection)
    let after = presentedOffset(collection)
    XCTAssertGreaterThan(after, before + 20)
    XCTAssertTrue(
      samples.contains { $0 > before + 1 && $0 < after - 1 },
      "Insertion must move through an intermediate presented position")
    for (previous, next) in zip(samples, samples.dropFirst()) {
      XCTAssertGreaterThanOrEqual(
        next, previous - 1, "A send must not reverse toward the old footer")
    }
  }

  func testUserPagingInterruptsAPreparingSendAndKeepsItsReadingPosition() async throws {
    let fixture = SendTransitionFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    fixture.conversation.draft = "Send while reading"
    let send = Task { await fixture.scrolling.send() }
    try await eventually { !fixture.conversation.pending.isEmpty }
    XCTAssertTrue(collection.accessibilityScroll(.up))
    await send.value
    try await eventually { fixture.conversation.readingPosition != nil }
    try await savedReadingPositionMatchesViewport(fixture.conversation, in: fixture.host.view)
    let position = try XCTUnwrap(fixture.conversation.readingPosition)
    await stableHostingGeometry(fixture.host.view)
    XCTAssertEqual(fixture.conversation.readingPosition, position)
    XCTAssertGreaterThan(
      collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY, 20)
  }

  func testViewportResizeRetargetsASendFromItsPresentedPosition() async throws {
    let fixture = SendTransitionFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    fixture.conversation.draft = "Send through a viewport change"
    let origin = collection.contentOffset.y
    let send = Task { await fixture.scrolling.send() }
    try await eventually { !fixture.conversation.pending.isEmpty }
    let pending = try XCTUnwrap(fixture.conversation.pending.first)
    try await eventually {
      fixture.contains(pending.id, in: collection)
        && collection.contentOffset.y > origin + 5
        && collection.contentSize.height + collection.adjustedContentInset.bottom
          - collection.bounds.maxY > 5
    }
    let before = presentedOffset(collection)
    let window = try XCTUnwrap(fixture.window)
    window.frame.size.height = 620
    fixture.host.view.setNeedsLayout()
    fixture.host.view.layoutIfNeeded()
    XCTAssertEqual(presentedOffset(collection), before, accuracy: 1)
    await send.value
    try await fixture.assertFinished(pending.id, in: collection)
  }

  func testReduceMotionStillInsertsTheMessageAndReachesTheNewBottom() async throws {
    let fixture = SendTransitionFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    fixture.scrolling.setReduceMotion(true)
    fixture.conversation.draft = "Send without motion"
    await fixture.scrolling.send()
    let pending = try XCTUnwrap(fixture.conversation.pending.first)
    try await eventually { offset(of: pending.id, in: fixture.host.view) != nil }
    XCTAssertEqual(
      collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY,
      0, accuracy: 1)
    try await fixture.assertFinished(pending.id, in: collection)
  }

  func testLongSentMessagesKeepNativeCellsInThePresentedViewportThroughoutScrolling() async throws {
    let fixture = SendTransitionFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    fixture.conversation.draft = String(
      repeating: "A long message with several visible lines. ", count: 100)
    let send = Task { await fixture.scrolling.send() }
    try await eventually { !fixture.conversation.pending.isEmpty }
    let pending = try XCTUnwrap(fixture.conversation.pending.first)
    try await eventually {
      var viewport = collection.layer.presentation()?.bounds ?? collection.bounds
      viewport.origin.y += collection.adjustedContentInset.top
      viewport.size.height -=
        collection.adjustedContentInset.top + collection.adjustedContentInset.bottom
      XCTAssertTrue(
        collection.visibleCells.contains { $0.frame.intersects(viewport) },
        "Virtualization must keep rows mounted where the user currently sees them")
      return fixture.contains(pending.id, in: collection)
        && collection.contentSize.height + collection.adjustedContentInset.bottom
          - collection.bounds.maxY <= 1
    }
    await send.value
    try await fixture.assertFinished(pending.id, in: collection)
  }
}

@MainActor
private func presentedOffset(_ collection: UICollectionView) -> CGFloat {
  collection.layer.presentation()?.bounds.minY ?? collection.bounds.minY
}

@MainActor
private final class SendTransitionFixture {
  let remote = ConversationHistoryFixture(count: 30)
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator
  let host: UIHostingController<SendTransitionProbe>
  private(set) var window: UIWindow?

  init() {
    let conversation = remote.conversation()
    self.conversation = conversation
    let scrolling = ConversationScrollCoordinator(conversation: conversation)
    self.scrolling = scrolling
    host = UIHostingController(
      rootView: SendTransitionProbe(conversation: conversation, scrolling: scrolling))
  }

  var inputs: [ComposerTextView] { textInputs(in: host.view) }

  func mount() async throws -> UICollectionView {
    await conversation.refresh()
    window = try await mountConversationHost(host)
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    try await eventually {
      collection.contentSize.height + collection.adjustedContentInset.bottom
        - collection.bounds.maxY <= 1
    }
    return collection
  }

  func contains(_ id: String, in collection: UICollectionView) -> Bool {
    (collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>)?
      .indexPath(for: id) != nil
  }

  func assertFinished(_ id: String, in collection: UICollectionView) async throws {
    try await eventually {
      self.contains(id, in: collection)
        && abs(
          collection.contentSize.height + collection.adjustedContentInset.bottom
            - collection.bounds.maxY) <= 1
        && abs(presentedOffset(collection) - collection.contentOffset.y) < 1
    }
    try await eventually {
      guard let row = markers(in: self.host.view).first(where: { $0.messageID == id }) else {
        return false
      }
      let rect = row.convert(row.bounds, to: collection)
      return rect.maxY > collection.bounds.minY + collection.adjustedContentInset.top
        && rect.minY < collection.bounds.maxY - collection.adjustedContentInset.bottom
    }
  }

  func close() {
    if let window { unmount(window) }
    conversation.close()
  }

  private func textInputs(in view: UIView) -> [ComposerTextView] {
    if let input = view as? ComposerTextView { return [input] }
    return view.subviews.flatMap { textInputs(in: $0) }
  }
}

private struct SendTransitionProbe: View {
  let conversation: ConversationStore
  let scrolling: ConversationScrollCoordinator
  @State private var composerHeight: CGFloat = 0

  var body: some View {
    let rows =
      conversation.visibleMessages.map {
        ConversationCollectionRow.message(
          $0, showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
      } + [.footer(.idle)]
    ConversationCollectionView(
      rows: rows, markdown: conversation.messageMarkdown,
      contentInsets: EdgeInsets(top: 0, leading: 0, bottom: composerHeight, trailing: 0),
      anchor: scrolling.anchor, scroll: scrolling.scroll, followsBottom: scrolling.followsBottom,
      sendTransition: scrolling.sendTransition,
      phaseChanged: scrolling.phaseChanged, metricsChanged: scrolling.metricsChanged,
      refresh: { await conversation.refresh() }
    ) { row, anchor in
      if let message = row.message {
        Text(message.text)
          .frame(maxWidth: .infinity, minHeight: 120)
          .background {
            if let anchor { ConversationRowAnchor(messageID: message.id, anchor: anchor) }
          }
      } else {
        Color.clear.frame(height: 20)
      }
    }
    .ignoresSafeArea(.container, edges: .vertical)
    .safeAreaBar(edge: .bottom, spacing: 0) {
      ChatComposerView(
        draft: Binding(get: { conversation.draft }, set: { conversation.draft = $0 }),
        isBusy: conversation.isSending, showsProgress: false, canStop: false, needsUpgrade: false,
        error: conversation.error, attachmentURL: conversation.webURL,
        attachments: conversation.attachmentDraft, draftState: conversation.composer,
        submit: { await scrolling.send() }, refresh: nil, sendTransition: scrolling.sendTransition
      )
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        composerHeight = $0
      }
    }
    .onAppear { scrolling.activate(reduceMotion: false) }
    .task(id: conversation.visibleMessages.last) { await scrolling.latestMessageChanged() }
    .onChange(of: conversation.visibleMessages) { _, _ in scrolling.messagesChanged() }
    .onDisappear { scrolling.deactivate() }
  }
}
