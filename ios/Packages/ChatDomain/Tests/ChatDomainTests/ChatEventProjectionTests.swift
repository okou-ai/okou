import ChatDomain
import Foundation
import XCTest

final class ChatEventProjectionTests: XCTestCase {
  func testQueuedAutomationWithoutMessageCanBeStopped() throws {
    let history = try ChatEventProjection.history(
      rows: [event(1, type: .inputAutomation, at: 1)], recovering: false)

    XCTAssertEqual(history.executionState, .queued)
    XCTAssertTrue(history.canStop)
    XCTAssertEqual(history.queuedEventIDs, [eventID(1)])
    XCTAssertTrue(history.activeRunIDs.isEmpty)
    XCTAssertTrue(history.messages.isEmpty)
  }

  func testQueuePrioritizesPromptsThenSubmissionTimeThenIdentity() throws {
    let rows = [
      event(5, type: .inputAutomation, at: 1),
      event(4, type: .inputPrompt, at: 3, text: "Later prompt"),
      event(3, type: .inputPrompt, at: 2, text: "Same time, later ID"),
      event(2, type: .inputPrompt, at: 2, text: "Same time, earlier ID"),
      event(6, type: .inputAutomation, at: 0),
    ]
    let history = try ChatEventProjection.history(rows: rows, recovering: false)

    XCTAssertEqual(history.queuedEventIDs, [2, 3, 4, 6, 5].map(eventID))
    XCTAssertEqual(history.executionState, .queued)
    XCTAssertTrue(history.canStop)
    XCTAssertTrue(history.activeRunIDs.isEmpty)
    XCTAssertEqual(history.messages.count, 3)
    XCTAssertTrue(history.messages.allSatisfy(\.isQueued))
  }

  func testQueueExcludesDeliveredRevokedAndNonRunnableInputs() throws {
    let runID = "10000000-0000-4000-8000-000000000100"
    let rows = [
      event(1, type: .inputPrompt, at: 1, text: "Delivered prompt"),
      event(2, type: .inputAutomation, at: 2),
      event(
        3, type: .inputPrompt, at: 3, text: "Delivered prompt", runID: runID, revokes: eventID(1)),
      event(4, type: .controlRevoke, at: 4, revokes: eventID(2)),
      event(5, type: .inputBudget, at: 5, text: "Budget context"),
      event(6, type: .inputRejected, at: 6, text: "Rejected prompt"),
      event(7, type: .runCompleted, at: 7, runID: runID),
    ]
    let history = try ChatEventProjection.history(rows: rows, recovering: false)

    XCTAssertTrue(history.queuedEventIDs.isEmpty)
    XCTAssertTrue(history.activeRunIDs.isEmpty)
    XCTAssertFalse(history.canStop)
    XCTAssertEqual(history.executionState, .completed)
    XCTAssertFalse(history.messages.contains(where: { $0.id == eventID(1) }))
    XCTAssertTrue(history.messages.allSatisfy { !$0.isQueued })
  }

  func testActivityRunUsesFirstOccurrenceOrderRatherThanUUIDOrLatestEvent() throws {
    let older = "f0000000-0000-4000-8000-000000000001"
    let newer = "10000000-0000-4000-8000-000000000001"
    let ignored = "f0000000-0000-4000-8000-000000000002"
    let rows = [
      event(1, type: .inputPrompt, at: 9, text: "Older", runID: older),
      event(2, type: .inputPrompt, at: 1, text: "Newer", runID: newer),
      event(3, type: .inputBudget, at: 10, runID: older),
      event(4, type: .usageRecorded, at: 11, runID: ignored),
      event(5, type: .inputBudget, at: 12, runID: ignored),
      event(6, type: .controlRevoke, at: 13, revokes: eventID(5)),
    ]
    let history = try ChatEventProjection.history(rows: rows, recovering: false)
    XCTAssertEqual(history.activeRunIDs, [newer, older])
    XCTAssertEqual(history.activityRunID, newer)

    let completed = rows + [event(7, type: .runCompleted, at: 14, runID: newer)]
    XCTAssertEqual(
      try ChatEventProjection.history(rows: completed, recovering: false).activityRunID, older)
    XCTAssertNil(try ChatEventProjection.history(rows: rows, recovering: true).activityRunID)
    let stopping = rows + [event(7, type: .controlInterrupt, at: 14, runID: newer)]
    XCTAssertNil(try ChatEventProjection.history(rows: stopping, recovering: false).activityRunID)
    let finished = completed + [event(8, type: .runCancelled, at: 15, runID: older)]
    XCTAssertNil(try ChatEventProjection.history(rows: finished, recovering: false).activityRunID)
  }

  func testFileOnlyMixedAndRejectedMessagesKeepCanonicalAttachments() throws {
    let files = [
      ChatEvent.UserMessage.Part(
        type: "file", fileId: "image-id", contentType: "image/png", filenameSnapshot: "image.png"),
      ChatEvent.UserMessage.Part(
        type: "file", fileId: "pdf-id", contentType: "application/pdf",
        filenameSnapshot: "report.pdf"),
    ]
    let rows = [
      ChatEvent(
        id: eventID(1), createdAt: .now, eventType: .inputPrompt,
        payload: .init(userMessage: .init(version: 1, parts: files))),
      ChatEvent(
        id: eventID(2), createdAt: .now, eventType: .inputRejected,
        payload: .init(
          error: "Please try again",
          userMessage: .init(version: 1, parts: [.init(type: "text", text: "Review")] + files))),
    ]
    let history = try ChatEventProjection.history(rows: rows, recovering: false)
    XCTAssertEqual(history.messages.count, 2)
    XCTAssertEqual(history.messages[0].text, "")
    XCTAssertEqual(history.messages[0].attachments.map(\.id), ["image-id", "pdf-id"])
    XCTAssertEqual(history.messages[0].attachments.map(\.filename), ["image.png", "report.pdf"])
    XCTAssertEqual(history.messages[1].text, "Review\n\nPlease try again")
    XCTAssertEqual(history.messages[1].attachments, history.messages[0].attachments)
    XCTAssertTrue(history.messages[1].isError)
  }

  func testMissingFileIdentityFailsClosedInsteadOfDroppingTheAttachment() {
    XCTAssertThrowsError(
      try ChatEventProjection.history(
        rows: [
          ChatEvent(
            id: eventID(1), createdAt: .now, eventType: .inputPrompt,
            payload: .init(
              userMessage: .init(
                version: 1,
                parts: [
                  .init(type: "file", contentType: "text/plain", filenameSnapshot: "notes.txt")
                ])))
        ], recovering: false))
  }

  private func eventID(_ id: Int) -> String {
    String(format: "10000000-0000-4000-8000-%012d", id)
  }

  private func event(
    _ id: Int, type: ChatEventType, at seconds: TimeInterval, text: String? = nil,
    runID: String? = nil, revokes: String? = nil
  ) -> ChatEvent {
    let payload = text.map {
      ChatEvent.Payload(
        error: type == .inputRejected ? "Rejected" : nil,
        userMessage: ChatEvent.UserMessage(
          version: 1, parts: [.init(type: "text", text: $0)]))
    }
    return ChatEvent(
      id: eventID(id), runId: runID, revokesEventId: revokes,
      createdAt: Date(timeIntervalSince1970: seconds), eventType: type, payload: payload)
  }
}
