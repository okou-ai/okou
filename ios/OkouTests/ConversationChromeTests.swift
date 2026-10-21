import ChatDataTestSupport
import ChatDomain
import SwiftUI
import XCTest

@testable import Okou

@MainActor
final class ConversationChromeTests: XCTestCase {
  func testHistoryExtendsBehindBarsAndKeepsEndMessagesAboveControls() async throws {
    let fixture = ConversationHistoryFixture(count: 30)
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    conversation.rememberReadingPosition(
      ConversationReadingPosition(messageID: ConversationHistoryFixture.id(1), offset: 0))
    let host = UIHostingController(
      rootView: ConversationHeaderTestView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    await stableHostingGeometry(host.view)
    let viewport = collection.convert(collection.bounds, to: window)
    XCTAssertEqual(viewport.minY, 0, accuracy: 1)
    XCTAssertEqual(viewport.maxY, window.bounds.maxY, accuracy: 1)
    XCTAssertEqual(collection.adjustedContentInset.top, window.safeAreaInsets.top + 60, accuracy: 1)
    XCTAssertEqual(
      collection.adjustedContentInset.bottom, window.safeAreaInsets.bottom + 70, accuracy: 1)

    try await eventually {
      markers(in: host.view).contains { $0.messageID == ConversationHistoryFixture.id(1) }
    }
    let first = try XCTUnwrap(
      markers(in: host.view).first { $0.messageID == ConversationHistoryFixture.id(1) })
    XCTAssertGreaterThanOrEqual(
      first.convert(first.bounds, to: collection).minY - collection.bounds.minY,
      collection.adjustedContentInset.top - 1)

    for _ in 0..<30 {
      let before = collection.contentOffset.y
      guard collection.accessibilityScroll(.down) else { break }
      try await eventually { abs(collection.contentOffset.y - before) > 1 }
      await stableHostingGeometry(host.view)
    }
    try await eventually {
      markers(in: host.view).contains { $0.messageID == ConversationHistoryFixture.id(30) }
    }
    let last = try XCTUnwrap(
      markers(in: host.view).first { $0.messageID == ConversationHistoryFixture.id(30) })
    XCTAssertLessThanOrEqual(
      last.convert(last.bounds, to: collection).maxY,
      collection.bounds.maxY - collection.adjustedContentInset.bottom + 1)
  }

  func testSidebarScrollsBehindWorkspaceAndFooterBars() async throws {
    let threads = (1...40).map { index in
      """
      {"id":"60000000-0000-4000-8000-\(String(format: "%012d", index))","agentId":"60000000-0000-4000-8000-999999999999","title":"Chat \(index)","createdAt":"2026-10-19T12:00:00Z","updatedAt":"2026-10-19T12:00:00Z","sortAt":"2026-10-19T12:00:00Z"}
      """
    }.joined(separator: ",")
    let fixture = ChatHTTPFixture { request in
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
    let store = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { store.close() }
    await store.refresh()
    XCTAssertNil(store.list.error)
    let host = UIHostingController(
      rootView: ChatSidebarView(
        store: store, authentication: AuthenticationService(publishableKey: ""),
        workspaceID: "workspace",
        accountError: .constant(nil), close: {}, newChat: { _ in }))
    let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { unmount(window) }
    try await eventually { sidebarScrollView(in: host.view) != nil }
    let scroll = try XCTUnwrap(sidebarScrollView(in: host.view))
    let viewport = scroll.convert(scroll.bounds, to: window)
    XCTAssertEqual(viewport.minY, 0, accuracy: 1)
    XCTAssertEqual(viewport.maxY, window.bounds.maxY, accuracy: 1)
    XCTAssertGreaterThanOrEqual(scroll.adjustedContentInset.top, window.safeAreaInsets.top + 58)
    XCTAssertGreaterThanOrEqual(
      scroll.adjustedContentInset.bottom, window.safeAreaInsets.bottom + 66)
  }
}

private struct ConversationHeaderTestView: View {
  let conversation: ConversationStore

  var body: some View {
    ChatDetailView(conversation: conversation, topContentInset: 60)
      .safeAreaBar(edge: .top, spacing: 0) {
        headerContent
      }
      .compositingGroup()
  }

  private var headerContent: some View {
    ZStack {
      Text("✅ #41703 Morning Brief 按…")
        .font(.system(size: 17, weight: .semibold)).lineLimit(1)
        .padding(.horizontal, 66)
      HStack {
        Button {
        } label: {
          Image(systemName: "line.3.horizontal").frame(width: 32, height: 32)
        }
        .buttonStyle(.glass).buttonBorderShape(.circle)
        .accessibilityLabel("Open sidebar")
        Spacer()
        Button {
        } label: {
          Image(systemName: "pin.fill").frame(width: 32, height: 32)
        }
        .buttonStyle(.glass).buttonBorderShape(.circle)
        .accessibilityLabel("Unpin chat")
      }
    }
    .buttonStyle(.plain).padding(.horizontal, 16).frame(height: 60)
  }
}

@MainActor
private func sidebarScrollView(in view: UIView) -> UIScrollView? {
  if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height {
    return scroll
  }
  return view.subviews.lazy.compactMap { sidebarScrollView(in: $0) }.first
}
