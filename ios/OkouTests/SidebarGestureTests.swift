import ChatDataTestSupport
import CoreGraphics
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class SidebarGestureTests: XCTestCase {
  func testSidebarLeavesVerticalScrollingCodeTablesAndArchiveGesturesAvailable() {
    XCTAssertTrue(
      SidebarGesturePolicy.canBegin(
        isOpen: false, sidebarWidth: 300, startX: 12, velocity: CGPoint(x: 300, y: 20)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: false, sidebarWidth: 300, startX: 12, velocity: CGPoint(x: 20, y: 300)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: false, sidebarWidth: 300, startX: 200, velocity: CGPoint(x: 300, y: 0)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: true, sidebarWidth: 300, startX: 150, velocity: CGPoint(x: -300, y: 0)))
    XCTAssertTrue(
      SidebarGesturePolicy.canBegin(
        isOpen: true, sidebarWidth: 300, startX: 350, velocity: CGPoint(x: -300, y: 0)))
    XCTAssertFalse(
      SidebarGesturePolicy.canBegin(
        isOpen: true, sidebarWidth: 300, startX: 350, velocity: CGPoint(x: -20, y: 300)))
  }

  func testReleaseUsesDistanceOrFlickDirectionAndCancellationRestoresStartingState() {
    XCTAssertFalse(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 50, velocity: 100, cancelled: false))
    XCTAssertTrue(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 200, velocity: 100, cancelled: false))
    XCTAssertTrue(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 50, velocity: 600, cancelled: false))
    XCTAssertFalse(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: true, sidebarWidth: 300, translation: -50, velocity: -600, cancelled: false))
    XCTAssertFalse(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: false, sidebarWidth: 300, translation: 250, velocity: 600, cancelled: true))
    XCTAssertTrue(
      SidebarGesturePolicy.settlesOpen(
        wasOpen: true, sidebarWidth: 300, translation: -250, velocity: -600, cancelled: true))
  }

  func testSidebarTakeoverStopsNativeMotionAndCancellationRestoresScrolling() async throws {
    let fixture = SidebarConversationFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }

    let initial = collection.contentOffset.y
    XCTAssertTrue(collection.accessibilityScroll(.up))
    try await eventually { abs(collection.contentOffset.y - initial) > 1 }
    fixture.sidebar.dragChanged(35)
    let held = collection.contentOffset
    XCTAssertFalse(collection.isUserInteractionEnabled)
    XCTAssertFalse(collection.accessibilityScroll(.up))
    // Observe presented native frames while the interrupted animation would still be moving.
    for _ in 0..<12 {
      await hostingPresentationFrame()
      XCTAssertEqual(collection.contentOffset.y, held.y, accuracy: 0.5)
    }
    try await savedReadingPositionMatchesViewport(fixture.conversation, in: fixture.host.view)

    fixture.sidebar.endDrag(translation: 200, velocity: 600, cancelled: true, sidebarWidth: 300)
    XCTAssertTrue(collection.isUserInteractionEnabled)
    XCTAssertEqual(collection.contentOffset.y, held.y, accuracy: 0.5)
    XCTAssertTrue(collection.accessibilityScroll(.up))
    try await eventually { abs(collection.contentOffset.y - held.y) > 1 }
  }

  func testSidebarReboundOpenAndCloseRetainTheNativeReadingPosition() async throws {
    let fixture = SidebarConversationFixture()
    let collection = try await fixture.mount()
    defer { fixture.close() }
    let held = collection.contentOffset

    fixture.sidebar.dragChanged(80)
    fixture.sidebar.dragChanged(25)
    fixture.sidebar.endDrag(translation: 25, velocity: 0, cancelled: false, sidebarWidth: 300)
    XCTAssertTrue(collection.isUserInteractionEnabled)
    XCTAssertEqual(collection.contentOffset.y, held.y, accuracy: 0.5)

    fixture.sidebar.dragChanged(200)
    fixture.sidebar.endDrag(translation: 200, velocity: 0, cancelled: false, sidebarWidth: 300)
    XCTAssertFalse(collection.isUserInteractionEnabled)
    XCTAssertFalse(collection.accessibilityScroll(.down))
    fixture.sidebar.dragChanged(-150)
    fixture.sidebar.endDrag(translation: -150, velocity: -600, cancelled: true, sidebarWidth: 300)
    XCTAssertFalse(
      collection.isUserInteractionEnabled,
      "Cancelling a close keeps the open sidebar in control")
    fixture.sidebar.setOpen(false)
    XCTAssertTrue(collection.isUserInteractionEnabled)
    XCTAssertEqual(collection.contentOffset.y, held.y, accuracy: 0.5)
    XCTAssertTrue(collection.accessibilityScroll(.down))
    try await eventually { collection.contentOffset.y > held.y + 1 }
  }

  func testCodeAndTableOverflowRemainNativeScrollableAfterSidebarCloses() async throws {
    let fixture = SidebarConversationFixture()
    let wide = String(repeating: "wide_column_", count: 40)
    let markdown = "```swift\nlet \(wide) = 1\n```\n\n| A | B |\n|---|---|\n| \(wide) | \(wide) |"
    for sequence in 31...45 {
      let payload = try JSONEncoder().encode([
        "content": sequence == 31 ? markdown : "Following message \(sequence)"
      ])
      fixture.remote.append(
        """
        {"id":"\(ConversationHistoryFixture.id(sequence))","chatThreadId":"\(ConversationHistoryFixture.threadID)","runId":null,"revokesEventId":null,"seqId":\(sequence),"createdAt":"2026-10-20T00:00:00Z","eventType":"output.message","payload":\(String(decoding: payload, as: UTF8.self))}
        """)
    }
    let collection = try await fixture.mount(sequence: 31)
    defer { fixture.close() }
    try await eventually {
      nativeScrollViews(in: collection).filter { $0.contentSize.width > $0.bounds.width + 20 }.count
        >= 2
    }
    let overflow = nativeScrollViews(in: collection).filter {
      $0.contentSize.width > $0.bounds.width + 20
    }
    fixture.sidebar.dragChanged(50)
    fixture.sidebar.endDrag(translation: 50, velocity: 0, cancelled: false, sidebarWidth: 300)
    for scroll in overflow {
      XCTAssertTrue(scroll.isUserInteractionEnabled)
      XCTAssertTrue(scroll.isScrollEnabled)
      XCTAssertTrue(scroll.panGestureRecognizer.isEnabled)
      scroll.setContentOffset(CGPoint(x: 40, y: scroll.contentOffset.y), animated: true)
    }
    try await eventually { overflow.allSatisfy { $0.contentOffset.x > 20 } }
  }

  func testSidebarListRetainsNativeScrollingWhileTranscriptIsSuspended() async throws {
    let fixture = SidebarConversationFixture()
    let transcript = try await fixture.mount()
    defer { fixture.close() }
    let threads = (1...40).map { index in
      """
      {"id":"70000000-0000-4000-8000-\(String(format: "%012d", index))","agentId":"\(ConversationHistoryFixture.agentID)","title":"Chat \(index)","createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"}
      """
    }.joined(separator: ",")
    let http = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(threads)],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = WorkspaceStore(client: http.client, webURL: http.baseURL)
    defer { store.close() }
    await store.refresh()
    let host = UIHostingController(
      rootView: ChatSidebarView(
        store: store, authentication: AuthenticationService(publishableKey: ""),
        workspaceID: "workspace", accountError: .constant(nil), close: {}, newChat: { _ in }))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 300, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    fixture.sidebar.setOpen(true)
    try await eventually {
      nativeScrollViews(in: host.view).contains { $0.contentSize.height > $0.bounds.height }
    }
    let list = try XCTUnwrap(
      nativeScrollViews(in: host.view).first { $0.contentSize.height > $0.bounds.height })
    XCTAssertFalse(transcript.isUserInteractionEnabled)
    XCTAssertTrue(list.isUserInteractionEnabled)
    XCTAssertTrue(list.panGestureRecognizer.isEnabled)
    let before = list.contentOffset.y
    XCTAssertNotNil(list.hitTest(CGPoint(x: list.bounds.midX, y: list.bounds.midY), with: nil))
    list.setContentOffset(CGPoint(x: list.contentOffset.x, y: before + 120), animated: true)
    try await eventually { list.contentOffset.y > before + 1 }
  }

  func testGestureRemovalAndDetailReplacementReleaseOnlyTheirOwnNativeScroll() async throws {
    let sidebar = SidebarInteraction()
    let first = SidebarConversationFixture(sidebar: sidebar)
    let firstCollection = try await first.mount()
    defer { first.close() }
    sidebar.dragChanged(50)
    XCTAssertFalse(firstCollection.isUserInteractionEnabled)
    let gesture = SidebarPanGesture(
      interaction: sidebar, sidebarWidth: 300, changed: { _ in }, ended: { _, _, _ in })
    SidebarPanGesture.dismantleUIGestureRecognizer(
      UIPanGestureRecognizer(), coordinator: SidebarPanGesture.Coordinator(parent: gesture))
    XCTAssertTrue(firstCollection.isUserInteractionEnabled)

    sidebar.setOpen(true)
    let second = SidebarConversationFixture(sidebar: sidebar)
    let secondCollection = try await second.mount()
    defer { second.close() }
    XCTAssertTrue(firstCollection.isUserInteractionEnabled)
    XCTAssertFalse(secondCollection.isUserInteractionEnabled)
    first.close()
    XCTAssertFalse(
      secondCollection.isUserInteractionEnabled,
      "An old detail cannot release its replacement")
    let held = secondCollection.contentOffset
    sidebar.setOpen(false)
    XCTAssertTrue(secondCollection.isUserInteractionEnabled)
    XCTAssertEqual(secondCollection.contentOffset.y, held.y, accuracy: 0.5)
    XCTAssertTrue(secondCollection.accessibilityScroll(.up))
    try await eventually { secondCollection.contentOffset.y < held.y - 1 }
  }

}

/// Enter through the production detail and HTTP fixture; observe its real UICollectionView.
@MainActor
private final class SidebarConversationFixture {
  let sidebar: SidebarInteraction
  let remote = ConversationHistoryFixture(count: 30)
  let conversation: ConversationStore
  let host: UIHostingController<ChatDetailView>
  private var window: UIWindow?

  init(sidebar: SidebarInteraction = SidebarInteraction()) {
    self.sidebar = sidebar
    let conversation = remote.conversation()
    self.conversation = conversation
    host = UIHostingController(
      rootView: ChatDetailView(conversation: conversation, sidebar: sidebar))
  }

  func mount(sequence: Int = 15) async throws -> UICollectionView {
    await conversation.refresh()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    let position = ConversationReadingPosition(
      messageID: ConversationHistoryFixture.id(sequence), offset: -25)
    conversation.rememberReadingPosition(position)
    window = try await mountConversationHost(host)
    try await eventually(
      message: readingDescription(position.messageID, conversation: conversation, view: host.view)
    ) {
      abs((offset(of: position.messageID, in: host.view) ?? .infinity) - position.offset) < 1
    }
    return try XCTUnwrap(markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
  }

  func close() {
    if let window {
      unmount(window)
      self.window = nil
    }
    conversation.close()
  }
}

@MainActor
private func nativeScrollViews(in view: UIView) -> [UIScrollView] {
  ((view as? UIScrollView).map { [$0] } ?? [])
    + view.subviews.flatMap { nativeScrollViews(in: $0) }
}
