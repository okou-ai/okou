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

  func testSendTrimmingStopsAtReferencesAndKeepsQuotedNotesAndContext() {
    let source: MessageJSON = .object([
      "type": .string("source"), "kind": .string("mcp"),
      "clientId": .string("client"), "clientName": .string("Research"),
    ])
    let reference: MessageJSON = .object([
      "type": .string("agent"), "agentId": .string("agent"), "nameSnapshot": .string("Agent"),
    ])
    let spacing: MessageJSON = .object([
      "type": .string("text"), "text": .string(" \n  Keep this spacing. \n "),
    ])
    let feedback: MessageJSON = .object([
      "type": .string("feedback"), "quote": .string("  Original passage.\n"),
      "note": .array([.object(["type": .string("text"), "text": .string("\n  Keep the note.\n")])]),
    ])
    let file: MessageJSON = .object([
      "type": .string("file"), "fileId": .string("file"),
      "filenameSnapshot": .string("notes.txt"), "contentType": .string("text/plain"),
    ])
    let context: MessageJSON = .object([
      "type": .string("additional_info"), "text": .string("  Context.\n"),
    ])
    let padding: MessageJSON = .object(["type": .string("text"), "text": .string(" \n")])
    let document = ChatDraftDocument(parts: [
      source, padding, reference, spacing, feedback, padding, file, context,
    ])
    XCTAssertEqual(
      document.trimmingWhitespace(),
      ChatDraftDocument(parts: [source, reference, spacing, feedback, file, context]))

    let fileOnly = ChatDraftDocument(parts: [source, padding, file, padding, context])
    XCTAssertEqual(
      fileOnly.trimmingWhitespace().parts,
      [source, file, context])
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
