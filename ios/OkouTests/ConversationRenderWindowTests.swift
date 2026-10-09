import XCTest

@testable import Okou

final class ConversationRenderWindowTests: XCTestCase {
  func testLatestAndExpansionKeepWholeRoleGroups() {
    let messages = (0..<60).map { index in
      windowMessage(index, role: (index / 3).isMultiple(of: 2) ? .user : .assistant)
    }
    var window = ConversationRenderWindow()
    window.update(messages)
    XCTAssertEqual(Array(messages[window.range]).map(\.id), (30..<60).map(String.init))
    XCTAssertTrue(window.hasEarlierMessages)
    window.expand()
    XCTAssertEqual(window.range, 0..<60)
    XCTAssertFalse(window.hasEarlierMessages)
    window.resetToLatest()
    XCTAssertEqual(window.range, 30..<60)
  }

  func testReadingBoundarySurvivesAppendAndRevocation() {
    var messages = (0..<35).map { windowMessage($0) }
    var window = ConversationRenderWindow()
    window.update(messages)
    window.pauseFollowing()
    window.expand()
    messages.append(windowMessage(35))
    window.update(messages)
    XCTAssertEqual(messages[window.range.lowerBound].id, "15")
    messages.removeAll { ["15", "16"].contains($0.id) }
    window.update(messages)
    XCTAssertEqual(messages[window.range.lowerBound].id, "17")
    window.resetToLatest()
    XCTAssertEqual(messages[window.range.lowerBound].id, "26")
  }

  func testEmptyShortAndSingleRoleHistories() {
    var window = ConversationRenderWindow()
    window.update([])
    window.expand()
    XCTAssertEqual(window.range, 0..<0)
    XCTAssertFalse(window.hasEarlierMessages)
    window.update((0..<4).map { windowMessage($0) })
    XCTAssertEqual(window.range, 0..<4)
    window.update((0..<100).map { windowMessage($0, role: .assistant) })
    XCTAssertEqual(window.range, 0..<100)
    XCTAssertFalse(window.hasEarlierMessages)
  }
}

private func windowMessage(_ index: Int, role: ChatMessage.Role? = nil) -> ChatMessage {
  ChatMessage(
    id: String(index), role: role ?? (index.isMultiple(of: 2) ? .user : .assistant),
    text: "Message \(index)", createdAt: Date(timeIntervalSince1970: Double(index)), runID: nil,
    isQueued: false, isError: false)
}
