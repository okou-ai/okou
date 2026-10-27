import Foundation
import XCTest

@testable import ChatDomain

final class ChatFeedbackSelectionTests: XCTestCase {
  func testRenderedSelectionKeepsTheSelectedOccurrenceAndOriginalSourceSnapshot() throws {
    let source = message("**Selected 🌷 é passage** and [Selected 🌷 é passage](https://example.com)")
    let visible = "Selected 🌷 é passage and Selected 🌷 é passage"
    let range = (visible as NSString).range(of: "Selected 🌷 é passage", options: .backwards)
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(message: source, range: range, visibleText: visible))
    XCTAssertEqual(selection.quote, "Selected 🌷 é passage")
    XCTAssertEqual(selection.range, range)
    XCTAssertEqual(selection.text, source.text)
    let read = try JSONDecoder().decode(
      ChatUserMessage.self, from: JSONEncoder().encode(ChatDraftDocument(parts: [selection.part])))
    try read.validate()
    XCTAssertEqual(read.parts.first?.eventId, source.id)
    XCTAssertEqual(read.parts.first?.range?.start, range.location)
    XCTAssertEqual(read.parts.first?.quote, "Selected 🌷 é passage")
  }

  func testTrimmedNativeSelectionKeepsTheRealEventAndUTF16Range() throws {
    let text = "👋 Prefix **literal**\n\n  第二段 🌷 é  \nLast"
    let selected = (text as NSString).range(of: "  第二段 🌷 é  ")
    let selection = try XCTUnwrap(ChatFeedbackSelection(message: message(text), range: selected))
    XCTAssertEqual(selection.eventID, "output-event")
    XCTAssertEqual(selection.quote, "第二段 🌷 é")
    XCTAssertEqual(selection.range, (text as NSString).range(of: selection.quote))
    let document = ChatDraftDocument(parts: [selection.part])
    let read = try JSONDecoder().decode(ChatUserMessage.self, from: JSONEncoder().encode(document))
    try read.validate()
    XCTAssertEqual(read.parts.first?.eventId, "output-event")
    XCTAssertEqual(read.parts.first?.range?.start, selection.range.location)
    XCTAssertEqual(read.parts.first?.range?.end, selection.range.location + selection.range.length)
    XCTAssertEqual(read.parts.first?.note, [])
    XCTAssertNil(read.parts.first?.source)
  }

  func testWhitespaceTrimmingMatchesThePWASelectionRules() throws {
    let text = "🌷 Prefix\u{FEFF}\u{00A0}Passage\u{2029}\u{FEFF}"
    let selection = try XCTUnwrap(
      ChatFeedbackSelection(
        message: message(text),
        range: (text as NSString).range(of: "\u{FEFF}\u{00A0}Passage\u{2029}\u{FEFF}")))
    XCTAssertEqual(selection.quote, "Passage")
    XCTAssertEqual(selection.range, (text as NSString).range(of: "Passage"))
    let nonWhitespace = "\u{0085}Passage\u{0085}"
    XCTAssertEqual(
      ChatFeedbackSelection(
        message: message(nonWhitespace),
        range: NSRange(location: 0, length: nonWhitespace.utf16.count))?.quote, nonWhitespace)
  }

  func testOnlyNonemptyAssistantSelectionsWithValidUnicodeBoundariesCanBeQuoted() {
    let text = "🌷  Text"
    for range in [
      NSRange(location: NSNotFound, length: 1), NSRange(location: 0, length: 0),
      NSRange(location: 1, length: 1), NSRange(location: 50, length: 1),
      NSRange(location: 2, length: 2), NSRange(location: 0, length: Int.max),
    ] { XCTAssertNil(ChatFeedbackSelection(message: message(text), range: range)) }
    for role in [ChatMessage.Role.user, .system] {
      XCTAssertNil(
        ChatFeedbackSelection(
          message: message(text, role: role), range: NSRange(location: 0, length: 2)))
    }
    XCTAssertNil(
      ChatFeedbackSelection(
        message: message(text, error: true), range: NSRange(location: 0, length: 2)))
  }

  func testUnsupportedQuotedDraftsStayLosslessAndCannotBecomeEditableEmptyNotes() throws {
    for part in [
      #"{"type":"feedback","quote":"Passage"}"#,
      #"{"type":"feedback","quote":"Passage","note":[{"type":"future","value":"preserve"}]}"#,
    ] {
      let data = Data("{\"version\":1,\"parts\":[\(part)]}".utf8)
      let document = try JSONDecoder().decode(ChatDraftDocument.self, from: data)
      XCTAssertFalse(document.isSupported)
      XCTAssertEqual(
        try JSONDecoder().decode(ChatDraftDocument.self, from: JSONEncoder().encode(document)),
        document)
    }
  }

  private func message(_ text: String, role: ChatMessage.Role = .assistant, error: Bool = false)
    -> ChatMessage
  {
    ChatMessage(
      id: "output-event", role: role, text: text, createdAt: Date(), isQueued: false, isError: error
    )
  }
}
