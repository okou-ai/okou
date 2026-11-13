import ChatDomain
import Foundation
import XCTest

final class ChatShareGroupTests: XCTestCase {
  func testSelectionCountsConsecutivePromptsTogetherAndOnlyIncludesTheVisibleAnswer() throws {
    let history = try ChatEventProjection.history(
      rows: [
        input("question", runID: "run"), input("context", runID: "run"),
        output("work", runID: "run"), output("answer", runID: "run"),
        ChatEvent(id: "done", runId: "run", createdAt: .now, eventType: .runCompleted),
        input("queued", runID: nil),
      ], recovering: false)
    let groups = ChatShareGroup.groups(in: history)
    XCTAssertEqual(groups.map(\.eventIDs), [["question", "context"], ["answer"]])
    XCTAssertEqual(
      ChatShareGroup.answerEventIDs("answer", in: history), ["question", "context", "answer"])
    XCTAssertTrue(ChatShareGroup.answerEventIDs("work", in: history).isEmpty)
  }

  func testRevokedInputsAndAttachmentOnlyPromptsFollowTheWebSelectionRules() throws {
    let attachment = ChatEvent(
      id: "attachment", runId: "run", createdAt: .now, eventType: .inputPrompt,
      payload: .init(
        userMessage: .init(parts: [
          .init(
            type: "file", fileId: "file", contentType: "text/plain", filenameSnapshot: "notes.txt")
        ])))
    let history = try ChatEventProjection.history(
      rows: [
        input("revoked", runID: "run"),
        ChatEvent(
          id: "revoke", revokesEventId: "revoked", createdAt: .now, eventType: .controlRevoke),
        attachment, output("answer", runID: "run"),
      ], recovering: false)
    XCTAssertEqual(
      ChatShareGroup.groups(in: history).map(\.eventIDs), [["attachment"], ["answer"]])
    XCTAssertEqual(ChatShareGroup.answerEventIDs("answer", in: history), ["attachment", "answer"])
  }

  private func input(_ id: String, runID: String?) -> ChatEvent {
    ChatEvent(
      id: id, runId: runID, createdAt: .now, eventType: .inputPrompt,
      payload: .init(userMessage: .init(parts: [.init(type: "text", text: id)])))
  }

  private func output(_ id: String, runID: String) -> ChatEvent {
    ChatEvent(
      id: id, runId: runID, createdAt: .now, eventType: .outputMessage, payload: .init(content: id))
  }
}
