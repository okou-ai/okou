import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationOpeningTests: XCTestCase {
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
    width: CGFloat = 390, category: UIContentSizeCategory = .large
  ) throws -> MountedOpeningList {
    let rows = messages.map {
      ConversationCollectionRow.message(
        $0, showsAvatar: false, topSpacing: 0, pendingRetry: nil, isSending: false)
    }
    let source = ConversationCollectionView(
      rows: rows, markdown: markdown, measurements: cache, anchor: ConversationScrollAnchor(),
      scroll: ConversationCollectionScroll(), followsBottom: false,
      phaseChanged: { _ in }, metricsChanged: { _ in }, refresh: {},
      content: { row, _ in
        Text(row.message?.text ?? "").padding(12).frame(maxWidth: .infinity, alignment: .leading)
      })
    let controller = ConversationCollectionController(source: source)
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
      window: window, collection: collection, loading: loading, stop: { controller.stop() })
  }
}

@MainActor
private struct MountedOpeningList {
  let window: UIWindow
  let collection: UICollectionView
  let loading: UIActivityIndicatorView
  let stop: () -> Void

  var itemCount: Int {
    collection.numberOfSections == 0 ? 0 : collection.numberOfItems(inSection: 0)
  }

  func close() {
    stop()
    unmount(window)
  }
}
