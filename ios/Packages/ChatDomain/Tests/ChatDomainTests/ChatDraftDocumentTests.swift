import Foundation
import XCTest

@testable import ChatDomain

final class ChatDraftDocumentTests: XCTestCase {
  func testSendTrimmingKeepsInternalWhitespaceAcrossTextParts() {
    let document = ChatDraftDocument(parts: [
      .object(["type": .string("text"), "text": .string("\r\n\t\u{00a0}")]),
      .object(["type": .string("text"), "text": .string("  你好 🌷\n\n    code ")]),
      .object(["type": .string("text"), "text": .string(" continuation\t \n")]),
    ])

    XCTAssertEqual(
      document.trimmingWhitespace(),
      ChatDraftDocument(parts: [
        .object(["type": .string("text"), "text": .string("你好 🌷\n\n    code ")]),
        .object(["type": .string("text"), "text": .string(" continuation")]),
      ]))
    XCTAssertEqual(document.text, "\r\n\t\u{00a0}  你好 🌷\n\n    code  continuation\t \n")
  }

  func testSendTrimmingStopsAtReferencesAndKeepsQuotedNotesAndContext() throws {
    let data = Data(
      #"{"version":1,"parts":[{"type":"source","kind":"mcp","clientId":"client","clientName":"Research"},{"type":"text","text":"\n "},{"type":"agent","agentId":"agent","nameSnapshot":"Agent"},{"type":"text","text":" \n  Keep this spacing. \n "},{"type":"feedback","quote":"  Original passage.\n","note":[{"type":"text","text":"\n  Keep the note.\n"}]},{"type":"text","text":" \n"},{"type":"file","fileId":"file","filenameSnapshot":"notes.txt","contentType":"text/plain"},{"type":"additional_info","text":"  Context.\n"}]}"#
        .utf8)
    let document = try JSONDecoder().decode(ChatDraftDocument.self, from: data)
    var expected = document
    expected.parts.remove(at: 6)
    expected.parts.remove(at: 1)

    XCTAssertEqual(document.trimmingWhitespace(), expected)

    let fileOnly = ChatDraftDocument(parts: [
      document.parts[0], document.parts[1], document.parts[7], document.parts[6], document.parts[8],
    ])
    XCTAssertEqual(
      fileOnly.trimmingWhitespace().parts,
      [document.parts[0], document.parts[7], document.parts[8]])
  }

  func testTextEditsPreserveRichPartsAndUnicodePositions() throws {
    let data = Data(
      #"{"version":1,"parts":[{"type":"text","text":"Hello "},{"type":"agent","agentId":"agent","nameSnapshot":"Agent"},{"type":"text","text":"🌷 world"},{"type":"file","fileId":"file","filenameSnapshot":"notes.txt","contentType":"text/plain","annotations":{"version":1,"marks":[]}}]}"#
        .utf8)
    var document = try JSONDecoder().decode(ChatDraftDocument.self, from: data)
    let rich = document.parts.filter { $0["type"]?.string != "text" }
    document.replaceText("Hello 🌷 friend")
    XCTAssertEqual(document.text, "Hello 🌷 friend")
    XCTAssertEqual(document.parts.filter { $0["type"]?.string != "text" }, rich)
    XCTAssertEqual(document.parts[1]["type"]?.string, "agent")
    document.replaceText("")
    XCTAssertEqual(document.parts, rich)
    document.replaceText("New text")
    XCTAssertEqual(document.text, "New text")
    XCTAssertEqual(
      try JSONDecoder().decode(ChatDraftDocument.self, from: JSONEncoder().encode(document)),
      document)
  }

  func testUnsupportedPartsStayLosslessAndAreExplicitlyUnsupported() throws {
    let data = Data(
      #"{"version":2,"parts":[{"type":"future","nested":{"flag":true,"value":12.125,"null":null,"array":[1,"two"]}}]}"#
        .utf8)
    let document = try JSONDecoder().decode(ChatDraftDocument.self, from: data)
    XCTAssertFalse(document.isSupported)
    XCTAssertEqual(
      try JSONDecoder().decode(ChatDraftDocument.self, from: JSONEncoder().encode(document)),
      document)
  }

  func testTextFieldInsertionsAndDeletionsHaveExactText() {
    for before in ["", "abc", "🌷a界", "aaaa"] {
      for after in ["", "abc", "xabc", "ab", "a🐈界", "aaaaa"] {
        var document = ChatDraftDocument()
        document.replaceText(before)
        document.replaceText(after)
        XCTAssertEqual(document.text, after)
      }
    }
  }
}
