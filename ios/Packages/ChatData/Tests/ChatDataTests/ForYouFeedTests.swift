import ChatDomain
import Foundation
import XCTest

@testable import ChatData

final class ForYouFeedTests: XCTestCase {
  func testFeedbackReasonsMatchTheFourWebActions() {
    XCTAssertEqual(
      ForYouFeedback.allCases.map(\.rawValue),
      ["already_done", "not_planned", "later", "less_like_this"])
  }

  func testCustomDirectionKeepsTheSignedSnapshotQuoteAndFile() throws {
    let json = #"""
      {
        "id":"10000000-0000-4000-8000-000000000001","type":"suggestion","consumeToken":"signed",
        "customContextVersion":"version-from-api","state":{"futureKey":42},
        "content":{"title":"Check the build","rationale":"A report is ready","options":[],
          "customOption":{"threadId":null,"draft":{"draftUserMessage":{"version":1,"parts":[
            {"type":"feedback","quote":"Original background","note":[]},
            {"type":"file","fileId":"file-1","filenameSnapshot":"report.txt","contentType":"text/plain"}
          ]},"draftAttachments":[{"id":"file-1","filename":"report.txt","contentType":"text/plain",
            "url":"https://example.com/report.txt","size":123}]}}}
      }
      """#
    let card = try JSONDecoder().decode(ForYouCard.self, from: Data(json.utf8))
    XCTAssertEqual(card.snapshot?["state"]?["futureKey"], .number(42))
    let reference = MessageJSON.object([
      "type": .string("chat_thread"), "threadId": .string("ref"),
      "titleSnapshot": .string("Budget")
    ])
    let extra = ChatAttachment(
      id: "file-2", filename: "notes.txt", contentType: "text/plain",
      size: 20, url: "https://example.com/notes.txt")
    let note = [
      MessageJSON.object(["type": .string("text"), "text": .string("Summarize ")]), reference
    ]
    let edited = ComposerDraft(
      document: ChatDraftDocument(parts: note),
      attachments: [.init(attachment: extra, url: "https://example.com/notes.txt")])
    let draft = try card.directionDraft(note: edited)
    XCTAssertEqual(
      try card.directionDraft(note: edited), draft, "An unchanged note must be retryable")
    let parts = try XCTUnwrap(draft.draftUserMessage?.parts)
    XCTAssertEqual(
      parts.map { $0["type"]?.string }, ["additional_info", "feedback", "file", "file"])
    let text = try XCTUnwrap(parts[0]["text"]?.string)
    let prefix = "Okou suggestion context v1:\n"
    XCTAssertTrue(text.hasPrefix(prefix))
    let context = try JSONDecoder().decode(
      MessageJSON.self, from: Data(text.dropFirst(prefix.count).utf8))
    XCTAssertEqual(context["contextVersion"], .string("version-from-api"))
    XCTAssertEqual(context["attachmentIds"], .array([.string("file-1")]))
    XCTAssertEqual(parts[1]["quote"], .string("Original background"))
    XCTAssertEqual(
      parts[1]["note"],
      .array(note))
    XCTAssertEqual(draft.draftAttachments?.map(\.id), ["file-1", "file-2"])
    let blank = ChatDraftDocument(parts: [
      .object(["type": .string("text"), "text": .string("   ")])
    ])
    XCTAssertThrowsError(
      try card.directionDraft(
        note: ComposerDraft(document: blank, attachments: edited.draftAttachments)))
  }

  func testPausedAutomationCarriesWhenItWasPaused() throws {
    func event(_ fields: String) throws -> ForYouAutomation {
      let json =
        #"{"id":"10000000-0000-4000-8000-000000000002","type":"event","content":{"#
        + #""eventType":"automation-disabled","automationId":"a1","#
        + #""automationName":"Daily check","consecutiveFailures":3,"#
        + #""recoveryScheduled":false"# + fields + "}}"
      let card = try JSONDecoder().decode(ForYouCard.self, from: Data(json.utf8))
      guard case .automation(let event) = card.content else {
        XCTFail("Expected a paused automation")
        throw APIClientError.incompatibleData
      }
      return event
    }
    let stamp = "2026-11-23T08:02:00.000Z"
    XCTAssertEqual(try event(#","disabledAt":""# + stamp + #"""#).disabledAt, stamp)
    // An event without the stamp still opens; the card only leaves the date out.
    XCTAssertNil(try event("").disabledAt)
  }

  func testNewFeedAndEventTypesCanBeSkipped() throws {
    for json in [
      #"{"id":"new","type":"news","content":{}}"#,
      #"{"id":"new","type":"event","content":{"eventType":"another-event"}}"#
    ] {
      let card = try JSONDecoder().decode(ForYouCard.self, from: Data(json.utf8))
      XCTAssertEqual(card.content, .unsupported)
    }
  }
}
