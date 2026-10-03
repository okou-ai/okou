import Foundation
import XCTest

@testable import Okou

final class ChatEventProjectionTests: XCTestCase {
  func testQueuedAutomationWithoutMessageCanBeStopped() throws {
    let rows = try decodeRows([
      row(1, type: "input.automation", at: "2026-09-09T00:00:01.000Z")
    ])

    let history = try ChatEventProjection.history(rows: rows, recovering: false)
    XCTAssertEqual(history.executionState, .queued)
    XCTAssertTrue(history.canStop)
    XCTAssertEqual(history.queuedEventIDs, [eventID(1)])
    XCTAssertTrue(history.activeRunIDs.isEmpty)
    XCTAssertTrue(history.messages.isEmpty)
  }

  func testQueuePrioritizesPromptsThenSubmissionTimeThenIdentity() throws {
    let rows = try decodeRows([
      row(5, type: "input.automation", at: "2026-09-09T00:00:01.000Z", seq: 1),
      row(4, type: "input.prompt", at: "2026-09-09T00:00:03.000Z", text: "Later prompt", seq: 2),
      row(
        3, type: "input.prompt", at: "2026-09-09T00:00:02.000Z", text: "Same time, later ID",
        seq: 3),
      row(
        2, type: "input.prompt", at: "2026-09-09T00:00:02.000Z", text: "Same time, earlier ID",
        seq: 4),
      row(6, type: "input.automation", at: "2026-09-09T00:00:00.000Z", seq: 5),
    ])

    let history = try ChatEventProjection.history(rows: rows, recovering: false)
    XCTAssertEqual(history.queuedEventIDs, [2, 3, 4, 6, 5].map(eventID))
    XCTAssertEqual(history.executionState, .queued)
    XCTAssertTrue(history.canStop)
    XCTAssertEqual(history.messages.count, 3)
    XCTAssertTrue(history.messages.allSatisfy(\.isQueued))
  }

  func testQueueExcludesDeliveredRevokedAndNonRunnableInputs() throws {
    let rows = try decodeRows([
      row(1, type: "input.prompt", at: "2026-09-09T00:00:01.000Z", text: "Delivered prompt"),
      row(2, type: "input.automation", at: "2026-09-09T00:00:02.000Z"),
      row(
        3, type: "input.prompt", at: "2026-09-09T00:00:03.000Z", text: "Delivered prompt",
        runID: "10000000-0000-4000-8000-000000000100", revokes: eventID(1)),
      row(4, type: "control.revoke", at: "2026-09-09T00:00:04.000Z", revokes: eventID(2)),
      row(5, type: "input.budget", at: "2026-09-09T00:00:05.000Z", text: "Budget context"),
      row(6, type: "input.rejected", at: "2026-09-09T00:00:06.000Z", text: "Rejected prompt"),
      row(
        7, type: "run.completed", at: "2026-09-09T00:00:07.000Z",
        runID: "10000000-0000-4000-8000-000000000100"),
    ])

    let history = try ChatEventProjection.history(rows: rows, recovering: false)
    XCTAssertTrue(history.queuedEventIDs.isEmpty)
    XCTAssertTrue(history.activeRunIDs.isEmpty)
    XCTAssertFalse(history.canStop)
    XCTAssertEqual(history.executionState, .completed)
    XCTAssertFalse(history.messages.contains(where: { $0.id == eventID(1) }))
    XCTAssertTrue(history.messages.allSatisfy { !$0.isQueued })
  }

  private func decodeRows(_ json: [String]) throws -> [ChatEventRow] {
    try json.map { try APIClient.decoder().decode(ChatEventRow.self, from: Data($0.utf8)) }
  }

  private func eventID(_ id: Int) -> String {
    String(format: "10000000-0000-4000-8000-%012d", id)
  }

  private func row(
    _ id: Int, type: String, at: String, text: String? = nil,
    runID: String? = nil, revokes: String? = nil, seq: Int? = nil
  ) -> String {
    let error = type == "input.rejected" ? #", "error":"Rejected""# : ""
    let document =
      text.map {
        #"{"userMessage":{"version":1,"parts":[{"type":"text","text":"\#($0)"}]}\#(error)}"#
      } ?? "null"
    let contextType = type.hasPrefix("input.") ? #""web""# : "null"
    return """
      {"id":"\(eventID(id))","chatThreadId":"10000000-0000-4000-8000-000000000200",\
      "runId":\(runID.map { "\"\($0)\"" } ?? "null"),\
      "revokesEventId":\(revokes.map { "\"\($0)\"" } ?? "null"),\
      "contextType":\(contextType),"contextId":null,\
      "runEventSequenceNumber":null,"runEventId":null,\
      "seqId":\(seq ?? id),"createdAt":"\(at)","eventType":"\(type)","payload":\(document)}
      """
  }
}
