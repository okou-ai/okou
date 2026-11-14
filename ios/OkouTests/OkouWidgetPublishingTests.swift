import ChatData
import ChatDomain
import Foundation
import XCTest

@testable import Okou

final class OkouWidgetPublishingTests: XCTestCase {
  private let base = Date(timeIntervalSince1970: 1_800_000_000)

  private func thread(
    _ id: Int, title: String, minutesAgo: Double, indicator: ChatIndicator? = nil,
    pinned: Bool = false, muted: Bool = false, archived: Bool = false
  ) -> ChatThread {
    let sortAt = base.addingTimeInterval(-minutesAgo * 60)
    return ChatThread(
      id: String(format: "00000000-0000-0000-0000-%012d", id), agentID: "okou", title: title,
      createdAt: sortAt, updatedAt: sortAt, sortAt: sortAt,
      pinnedAt: pinned ? sortAt : nil, isArchived: archived, indicator: indicator,
      unreadAt: indicator == .unread ? sortAt : nil, isMuted: muted)
  }

  func testUnreadAndWorkingChatsLeadThenPinsThenRecentWithSidebarStates() {
    let threads = [
      thread(1, title: "Recent idle", minutesAgo: 1),
      thread(2, title: "✅ Pinned done", minutesAgo: 30, pinned: true),
      thread(3, title: "⏳ Working", minutesAgo: 10, indicator: .active),
      thread(4, title: "Finished", minutesAgo: 5, indicator: .unread),
      thread(5, title: "Muted finished", minutesAgo: 2, indicator: .unread, muted: true),
      thread(6, title: "Archived", minutesAgo: 0, indicator: .unread, archived: true),
      thread(7, title: "Has a draft", minutesAgo: 40),
    ]
    let snapshot = OkouWidgetPublishing.snapshot(
      userID: "user", workspaceID: "workspace", threads: threads, name: "Tong",
      hasDraft: { $0 == threads[6].id })

    XCTAssertEqual(
      snapshot.chats.map(\.title),
      ["Finished", "Working", "Pinned done", "Recent idle", "Muted finished", "Has a draft"])
    XCTAssertEqual(
      snapshot.chats.map(\.state), [.finished, .working, .idle, .idle, .idle, .draft])
    // The status emoji leaves the title for its own column, as in the sidebar.
    XCTAssertEqual(snapshot.chats[1].emoji, "⏳")
    XCTAssertEqual(snapshot.chats[2].emoji, "✅")
    XCTAssertTrue(snapshot.chats[2].isPinned)
    // Archived chats never reach the widget, and nothing reports a pending approval yet.
    XCTAssertFalse(snapshot.chats.contains { $0.title == "Archived" })
    XCTAssertFalse(snapshot.chats.contains { $0.state == .needsYou })
    XCTAssertEqual(snapshot.greetings.night, "Saved your seat, Tong.")
  }

  func testSnapshotKeepsTwelveChats() {
    let threads = (1...20).map { thread($0, title: "Chat \($0)", minutesAgo: Double($0)) }
    let snapshot = OkouWidgetPublishing.snapshot(
      userID: "user", workspaceID: "workspace", threads: threads, name: nil,
      hasDraft: { _ in false })
    XCTAssertEqual(snapshot.chats.count, 12)
    XCTAssertEqual(snapshot.chats.first?.title, "Chat 1")
  }
}
