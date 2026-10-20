import Foundation
import XCTest

@testable import ChatDomain

final class ChatDraftDocumentTests: XCTestCase {
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
