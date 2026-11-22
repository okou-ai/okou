import XCTest

@testable import Okou

@MainActor
final class OkouChatStatesTests: XCTestCase {
  func testTrailingDrawsTheFirstStateInTheWebsOrder() {
    XCTAssertEqual(OkouChatStates().trailing, .none)
    XCTAssertEqual(OkouChatStates([.working, .muted, .draft, .pinned]).trailing, .working)
    XCTAssertEqual(OkouChatStates([.muted, .draft, .pinned]).trailing, .muted)
    XCTAssertEqual(OkouChatStates([.unread, .draft, .pinned]).trailing, .unread)
    XCTAssertEqual(OkouChatStates([.draft, .pinned]).trailing, .draft)
    XCTAssertEqual(OkouChatStates.pinned.trailing, .pinned)
  }

  func testVoiceOverReadsEveryStateInOrder() throws {
    let label = OkouChatStates([.pinned, .draft, .muted, .working]).accessibilityLabel
    let words = ["Working", "Muted", "Draft", "Pinned"].map {
      String(localized: String.LocalizationValue($0))
    }
    let positions = try words.map { word in
      try XCTUnwrap(label.range(of: word)?.lowerBound, "\(word) is missing from \(label)")
    }
    XCTAssertEqual(positions, positions.sorted())
    XCTAssertFalse(label.contains(String(localized: "Unread", bundle: .main)))
    XCTAssertEqual(OkouChatStates().accessibilityLabel, "")
  }
}
