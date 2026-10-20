import ChatDomain
import Foundation
import XCTest

final class ChatWorkProjectionTests: XCTestCase {
  func testUsageOnlyFollowsEligibleServerOutputAndDoesNotMoveToAnEmptySteerPhase() throws {
    for terminal in [ChatEventType.runFailed, .runCancelled] {
      let placeholder = try project([
        input("ask", at: 0), event("finish", terminal, at: 1),
        event("usage", .usageRecorded, at: 2),
      ])
      XCTAssertTrue(placeholder.runUsageAnchors.isEmpty)
      XCTAssertEqual(placeholder.usageEventIDs, ["run": "usage"])
      let error = try project([
        input("ask", at: 0), event("finish", terminal, at: 1, error: "Server outcome"),
        event("usage", .usageRecorded, at: 2),
      ])
      XCTAssertEqual(error.runUsageAnchors, ["run": "finish"])
      let steer = try project([
        input("ask", at: 0), output("answer", at: 1), input("steer", at: 2),
        event("finish", terminal, at: 3), event("usage", .usageRecorded, at: 4),
      ])
      XCTAssertEqual(steer.runUsageAnchors, ["run": "answer"])
    }
  }

  func testUserInputsSplitOneRunIntoIndependentWorkPhases() throws {
    let history = try project([
      input("ask", at: 0), output("work", at: 10), output("answer", at: 30),
      input("followup", at: 60), output("more-work", at: 70), output("final", at: 90),
      event("done", .runCompleted, at: 120),
    ])
    XCTAssertEqual(
      history.messages.map(\.id), ["ask", "work", "answer", "followup", "more-work", "final"])
    XCTAssertEqual(history.workSections.map(\.anchorMessageID), ["answer", "final"])
    XCTAssertEqual(history.workSections.map(\.hiddenMessageIDs), [["work"], ["more-work"]])
    XCTAssertEqual(history.workSections.map(\.stepCount), [1, 1])
    XCTAssertEqual(history.workSections.map(\.endTime), [date(60), date(120)])
  }

  func testActiveWorkKeepsItsIdentityAsTheLatestOutputChanges() throws {
    let rows = [input("ask", at: 0), output("first", at: 10)]
    let first = try project(rows)
    XCTAssertFalse(try XCTUnwrap(first.workSections.first).isCollapsible)
    XCTAssertNil(first.workSections.first?.endTime)
    let next = try project(rows + [output("second", at: 20), output("third", at: 30)])
    XCTAssertEqual(first.workSections.first?.id, next.workSections.first?.id)
    XCTAssertEqual(next.workSections.first?.anchorMessageID, "third")
    XCTAssertEqual(next.workSections.first?.hiddenMessageIDs, ["first", "second"])
    XCTAssertEqual(next.workSections.first?.stepCount, 2)
    XCTAssertEqual(next.executionState, .running)
    XCTAssertTrue(try project([input("ask", at: 0)]).workSections.isEmpty)
  }

  func testInterleavedRunsAndRunlessOutputDoNotBorrowEachOthersWork() throws {
    let runless = ChatEvent(
      id: "delivery", createdAt: date(25), eventType: .outputMessage,
      payload: .init(content: "Independent delivery"))
    let history = try project([
      input("ask", at: 0), output("first", at: 10),
      event("other", .outputMessage, at: 20, runID: "other-run", content: "Other answer"),
      runless, output("late", at: 30),
    ])
    XCTAssertEqual(history.workSections.map(\.anchorMessageID), ["first", "other", "late"])
    XCTAssertTrue(history.workSections.allSatisfy { $0.hiddenMessageIDs.isEmpty })
    XCTAssertTrue(history.messages.contains { $0.id == "delivery" })
    XCTAssertEqual(history.runUsageAnchors, ["run": "late", "other-run": "other"])
  }

  func testFailureOutcomeIsShownOnceAndRetiredByTheNextInput() throws {
    let rows = [
      input("ask", at: 0), output("progress", at: 10),
      event("error", .outputError, at: 20, error: "Connection lost"),
      event("failed", .runFailed, at: 21, error: "Connection lost"),
    ]
    let failed = try project(rows)
    XCTAssertEqual(failed.messages.filter { $0.role == .system }.map(\.id), ["failed"])
    XCTAssertEqual(failed.executionState, .failed)
    let queued = ChatEvent(
      id: "retry", createdAt: date(30), eventType: .inputPrompt,
      payload: .init(
        userMessage: .init(version: 1, parts: [.init(type: "text", text: "Try again")])))
    let retried = try project(rows + [queued])
    XCTAssertFalse(retried.messages.contains { $0.role == .system })
    XCTAssertEqual(retried.executionState, .queued)
  }

  func testRecoveredErrorStaysInWorkHistoryAndCancellationHasOneOutcome() throws {
    let recovered = try project([
      input("ask", at: 0), output("progress", at: 10),
      event("temporary", .outputError, at: 15, error: "Retrying"), output("answer", at: 20),
      event("cancelled", .runCancelled, at: 30),
    ])
    XCTAssertEqual(recovered.workSections.first?.hiddenMessageIDs, ["progress", "temporary"])
    XCTAssertEqual(
      recovered.messages.filter { $0.role == .system }.map(\.id), ["temporary", "cancelled"])
    XCTAssertEqual(recovered.workSections.first?.endTime, date(30))
  }

  func testDistinctFailureDetailsArePreserved() throws {
    let history = try project([
      input("ask", at: 0), output("progress", at: 10),
      event("error", .outputError, at: 20, error: "The provider connection was lost"),
      event("failed", .runFailed, at: 21, error: "Reconnect the account before retrying"),
    ])
    XCTAssertEqual(history.messages.filter { $0.isError }.map(\.id), ["error", "failed"])
  }

  func testRejectedUserInputNeverBecomesHiddenAssistantWork() throws {
    let rejected = ChatEvent(
      id: "rejected", runId: "run", createdAt: date(0), eventType: .inputRejected,
      payload: .init(
        error: "Not accepted",
        userMessage: .init(version: 1, parts: [.init(type: "text", text: "Question")])))
    let history = try project([rejected, output("progress", at: 10), output("answer", at: 20)])
    XCTAssertTrue(history.messages.contains { $0.id == "rejected" })
    XCTAssertEqual(history.workSections.first?.hiddenMessageIDs, ["progress"])
  }

  func testRevokedMessagesAreExcludedAndClaimedInputsKeepTheirOriginalTime() throws {
    let queued = ChatEvent(
      id: "queued", createdAt: date(0), eventType: .inputPrompt,
      payload: .init(userMessage: .init(version: 1, parts: [.init(type: "text", text: "Question")]))
    )
    let claimed = ChatEvent(
      id: "claimed", runId: "run", revokesEventId: "queued", createdAt: date(30),
      eventType: .inputPrompt, payload: queued.payload)
    let revoked = ChatEvent(
      id: "revoke", runId: "run", revokesEventId: "stale", createdAt: date(50),
      eventType: .controlRevoke)
    let history = try project([
      queued, claimed, output("stale", at: 40), revoked, output("answer", at: 60),
    ])
    XCTAssertEqual(history.messages.map(\.id), ["claimed", "answer"])
    XCTAssertEqual(history.workSections.first?.startTime, date(0))
    XCTAssertEqual(history.workSections.first?.stepCount, 0)
  }

  func testInterruptKeepsTheActiveWorkInItsRunWhileStopping() throws {
    let interrupt = ChatEvent(
      id: "interrupt", runId: "run", createdAt: date(20), eventType: .controlInterrupt)
    let history = try project([input("ask", at: 0), output("progress", at: 10), interrupt])
    XCTAssertEqual(history.executionState, .stopping)
    XCTAssertFalse(history.canStop)
    XCTAssertEqual(history.workSections.count, 1)
  }

  func testRecallingAQueuedInputDoesNotSplitTheSurvivingRunWork() throws {
    let queued = ChatEvent(
      id: "queued", createdAt: date(12), eventType: .inputPrompt,
      payload: .init(
        userMessage: .init(version: 1, parts: [.init(type: "text", text: "Pending question")])))
    let recall = ChatEvent(
      id: "recall", revokesEventId: "queued", createdAt: date(13), eventType: .controlRevoke)
    let history = try project([
      input("ask", at: 0), output("work", at: 10), queued, recall, output("answer", at: 20),
      event("done", .runCompleted, at: 30),
    ])
    XCTAssertEqual(history.messages.map(\.id), ["ask", "work", "answer"])
    XCTAssertEqual(history.workSections.count, 1)
    XCTAssertEqual(history.workSections.first?.hiddenMessageIDs, ["work"])
    XCTAssertEqual(history.workSections.first?.endTime, date(30))
  }

  private func project(_ rows: [ChatEvent]) throws -> ChatHistory {
    try ChatEventProjection.history(rows: rows, recovering: false)
  }

  private func date(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: seconds) }

  private func input(_ id: String, at seconds: TimeInterval) -> ChatEvent {
    ChatEvent(
      id: id, runId: "run", createdAt: date(seconds), eventType: .inputPrompt,
      payload: .init(userMessage: .init(version: 1, parts: [.init(type: "text", text: id)])))
  }

  private func output(_ id: String, at seconds: TimeInterval) -> ChatEvent {
    event(id, .outputMessage, at: seconds, content: id)
  }

  private func event(
    _ id: String, _ type: ChatEventType, at seconds: TimeInterval, runID: String = "run",
    content: String? = nil, error: String? = nil
  ) -> ChatEvent {
    ChatEvent(
      id: id, runId: runID, createdAt: date(seconds), eventType: type,
      payload: .init(content: content, error: error))
  }
}
