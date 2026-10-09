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
