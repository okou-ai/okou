import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationOpeningTests: XCTestCase {
  func testLocalMessageHidesInitialLoadingBeforeServerHistoryArrives() async throws {
    let gate = OpeningHistoryGate()
    addTeardownBlock { await gate.release() }
    let fixture = ConversationHistoryFixture(
      rows: [],
      snapshot: { _ in
        await gate.wait()
        return ChatHTTPResponse(
          status: 404,
          body: "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      },
      send: { _ in
        ChatHTTPResponse(body: "{\"threadId\":\"\(ConversationHistoryFixture.threadID)\"}")
      })
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let (host, window) = try mountDetail(conversation)
    defer { unmount(window) }
    try await eventually { self.loadingIndicators(in: host.view).filter(\.isAnimating).count == 1 }

    let input = try XCTUnwrap(composerInput(in: host.view))
    input.becomeFirstResponder()
    try await eventually { input.isFirstResponder }
    input.insertText("My first message")
    try await eventually { conversation.composer.hasContent }
    await conversation.send()
    try await eventually { !markers(in: host.view).isEmpty }
    XCTAssertEqual(conversation.visibleMessages.first?.text, "My first message")
    XCTAssertNil(conversation.history, "The server response is still held at the HTTP boundary")
    XCTAssertTrue(self.loadingIndicators(in: host.view).allSatisfy { $0.isHidden })

    await gate.release()
    try await eventually { !conversation.isLoading }
    XCTAssertTrue(self.loadingIndicators(in: host.view).allSatisfy { $0.isHidden })
  }

  func testInitialHistoryFailureStopsTheIndicator() async throws {
    let gate = OpeningHistoryGate()
    addTeardownBlock { await gate.release() }
    let fixture = ConversationHistoryFixture(
      rows: [],
      snapshot: { _ in
        await gate.wait()
        return ChatHTTPResponse(
          status: 503, body: "{\"error\":{\"message\":\"History unavailable\"}}")
      })
    let conversation = fixture.conversation()
    defer { conversation.close() }
    let (host, window) = try mountDetail(conversation)
    defer { unmount(window) }
    try await eventually { self.loadingIndicators(in: host.view).filter(\.isAnimating).count == 1 }

    await gate.release()
    try await eventually { !conversation.isLoading && conversation.error != nil }
    XCTAssertTrue(self.loadingIndicators(in: host.view).allSatisfy { $0.isHidden })
  }

  func testInitialHistoryAndFirstMessageLayoutShareOneIndicator() async throws {
    let delay = LoadingDelay()
    let list = try mount(
      [], cache: ConversationMeasurementCache(),
      markdown: MessageMarkdownCache(baseURL: URL(string: "https://app.example.invalid")!),
      isLoadingHistory: true, showsFooter: true, sleep: { _ in await delay.sleep() })
    defer {
      delay.resume()
      list.close()
    }
    try await eventually { delay.isWaiting && list.itemCount == 1 }
    delay.resume()
    try await eventually { list.loading.isAnimating }

    let message = ChatMessage(
      id: "first-answer", role: .assistant, text: "Ready to read.", createdAt: .distantPast,
      isQueued: false, isError: false)
    list.update([message], false)
    XCTAssertTrue(list.loading.isAnimating, "The indicator stays through first-message layout")
    try await eventually { list.displaysMessage(message.id) }
    XCTAssertTrue(list.loading.isHidden)
  }

  func testSettledEmptyHistoryStopsTheIndicatorWithoutChangingRows() async throws {
    let delay = LoadingDelay()
    let list = try mount(
      [], cache: ConversationMeasurementCache(),
      markdown: MessageMarkdownCache(baseURL: URL(string: "https://app.example.invalid")!),
      isLoadingHistory: true, showsFooter: true, sleep: { _ in await delay.sleep() })
    defer {
      delay.resume()
      list.close()
    }
    try await eventually { delay.isWaiting && list.itemCount == 1 }
    delay.resume()
    try await eventually { list.loading.isAnimating }

    list.update([], false)
    XCTAssertEqual(list.itemCount, 1)
    XCTAssertTrue(list.loading.isHidden)
  }

  func testCompletedRowsStayVisibleWhenCancelledLoadingDelayResumes() async throws {
    let delay = LoadingDelay()
    let message = ChatMessage(
      id: "loaded-answer", role: .assistant, text: "The conversation is ready.",
      createdAt: .distantPast, isQueued: false, isError: false)
    let list = try mount(
      [message], cache: ConversationMeasurementCache(),
      markdown: MessageMarkdownCache(baseURL: URL(string: "https://app.example.invalid")!),
      isLoadingHistory: true,
      sleep: { _ in await delay.sleep() })
    defer {
      delay.resume()
      list.close()
    }
    try await eventually {
      delay.isWaiting && delay.isCancelled && list.itemCount == 1
        && !list.collection.visibleCells.isEmpty
    }
    XCTAssertFalse(list.loading.isAnimating)

    // A deadline can finish before cancellation while its main-actor continuation is still queued.
    delay.resume()
    try await eventually { delay.didResume }
    XCTAssertEqual(list.itemCount, 1)
    XCTAssertGreaterThan(list.collection.contentSize.height, 0)
    XCTAssertFalse(
      list.loading.isAnimating, "A stale delayed wake must not cover rendered messages")
    XCTAssertTrue(list.loading.isHidden)
  }

  func testReopeningShowsPreparedRowsImmediatelyAndRemeasuresChangedGeometry() async throws {
    let cache = ConversationMeasurementCache()
    let markdown = MessageMarkdownCache(baseURL: URL(string: "https://app.example.invalid")!)
    let messages = (0..<3).map { index in
      ChatMessage(
        id: "opening-\(index)", role: .assistant,
        text: String(repeating: "A response that wraps at the available width. ", count: 25),
        createdAt: .distantPast, isQueued: false, isError: false)
    }
    let first = try mount(messages, cache: cache, markdown: markdown)
    defer { first.close() }
    XCTAssertFalse(first.loading.isAnimating, "A short layout preparation must not flash a spinner")
    try await eventually {
      first.itemCount == messages.count && first.collection.contentSize.height > 0
    }
    let height = first.collection.contentSize.height
    first.close()

    let reopened = try mount(messages, cache: cache, markdown: markdown)
    defer { reopened.close() }
    XCTAssertEqual(
      reopened.itemCount, messages.count, "A resident chat is ready before another display frame")
    XCTAssertEqual(reopened.collection.contentSize.height, height, accuracy: 1)
    XCTAssertFalse(reopened.loading.isAnimating)
    reopened.close()

    let narrower = try mount(messages, cache: cache, markdown: markdown, width: 270)
    defer { narrower.close() }
    XCTAssertEqual(narrower.itemCount, 0, "A different width must not reuse stale row sizes")
    try await eventually { narrower.collection.contentSize.height > height }
    narrower.close()

    let larger = try mount(
      messages, cache: cache, markdown: markdown, category: .accessibilityExtraExtraExtraLarge)
    defer { larger.close() }
    try await eventually { larger.collection.contentSize.height > height }
  }

  func testReopeningChangedMessageContentUsesItsNewHeight() async throws {
    let cache = ConversationMeasurementCache()
    let markdown = MessageMarkdownCache(baseURL: URL(string: "https://app.example.invalid")!)
    func message(_ text: String) -> ChatMessage {
      ChatMessage(
        id: "updated-answer", role: .assistant, text: text, createdAt: .distantPast,
        isQueued: false, isError: false)
    }
    let first = try mount([message("Short answer")], cache: cache, markdown: markdown)
    defer { first.close() }
    try await eventually { first.itemCount == 1 && first.collection.contentSize.height > 0 }
    let height = first.collection.contentSize.height
    first.close()
    let reopened = try mount(
      [message(String(repeating: "A newly updated answer. ", count: 120))], cache: cache,
      markdown: markdown)
    defer { reopened.close() }
    XCTAssertEqual(reopened.itemCount, 0)
    try await eventually { reopened.collection.contentSize.height > height }
  }

  private func mount(
    _ messages: [ChatMessage], cache: ConversationMeasurementCache, markdown: MessageMarkdownCache,
    width: CGFloat = 390, category: UIContentSizeCategory = .large,
    isLoadingHistory: Bool = false, showsFooter: Bool = false,
    sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
  ) throws -> MountedOpeningList {
    let anchor = ConversationScrollAnchor()
    let scroll = ConversationCollectionScroll()
    let source = { (messages: [ChatMessage], isLoadingHistory: Bool) in
      var rows = messages.map {
        ConversationCollectionRow.message(
          $0, showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
      }
      if showsFooter { rows.append(.footer(ChatHistory.empty.executionState)) }
      return ConversationCollectionView(
        rows: rows, markdown: markdown, measurements: cache, anchor: anchor,
        scroll: scroll, followsBottom: false, isLoadingHistory: isLoadingHistory,
        phaseChanged: { _ in }, metricsChanged: { _ in }, refresh: {},
        content: { row, _ in
          Text(row.message?.text ?? "").padding(12).frame(maxWidth: .infinity, alignment: .leading)
        })
    }
    let controller = ConversationCollectionController(
      source: source(messages, isLoadingHistory), sleep: sleep)
    controller.traitOverrides.preferredContentSizeCategory = category
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: width, height: 844)
    window.rootViewController = controller
    window.makeKeyAndVisible()
    controller.view.layoutIfNeeded()
    let collection = try XCTUnwrap(
      controller.view.subviews.compactMap { $0 as? UICollectionView }.first)
    collection.layoutIfNeeded()
    let loading = try XCTUnwrap(
      controller.view.subviews.compactMap { $0 as? UIActivityIndicatorView }.first)
    return MountedOpeningList(
      window: window, collection: collection, loading: loading,
      update: { controller.update(source($0, $1)) }, stop: { controller.stop() })
  }

  private func loadingIndicators(in view: UIView) -> [UIActivityIndicatorView] {
    if let indicator = view as? UIActivityIndicatorView { return [indicator] }
    return view.subviews.flatMap { loadingIndicators(in: $0) }
  }

  private func mountDetail(_ conversation: ConversationStore) throws
    -> (UIHostingController<ChatDetailView>, UIWindow)
  {
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    return (host, window)
  }

  private func composerInput(in view: UIView) -> ComposerTextView? {
    if let input = view as? ComposerTextView { return input }
    return view.subviews.lazy.compactMap { composerInput(in: $0) }.first
  }
}

private actor OpeningHistoryGate {
  private var waiting: [CheckedContinuation<Void, Never>] = []
  private var released = false

  func wait() async {
    guard !released else { return }
    await withCheckedContinuation { waiting.append($0) }
  }

  func release() {
    released = true
    for continuation in waiting { continuation.resume() }
    waiting.removeAll()
  }
}

@MainActor
private final class LoadingDelay {
  private var continuation: CheckedContinuation<Void, Never>?
  private nonisolated let cancelled = Mutex(false)
  private(set) var didResume = false
  var isWaiting: Bool { continuation != nil }
  var isCancelled: Bool { cancelled.withLock { $0 } }

  func sleep() async {
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation = $0 }
      didResume = true
    } onCancel: {
      self.cancelled.withLock { $0 = true }
    }
  }

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}

@MainActor
private struct MountedOpeningList {
  let window: UIWindow
  let collection: UICollectionView
  let loading: UIActivityIndicatorView
  let update: ([ChatMessage], Bool) -> Void
  let stop: () -> Void

  var itemCount: Int {
    collection.numberOfSections == 0 ? 0 : collection.numberOfItems(inSection: 0)
  }

  func displaysMessage(_ id: String) -> Bool {
    guard let source = collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>
    else { return false }
    return collection.indexPathsForVisibleItems.contains { source.itemIdentifier(for: $0) == id }
  }

  func close() {
    stop()
    unmount(window)
  }
}
