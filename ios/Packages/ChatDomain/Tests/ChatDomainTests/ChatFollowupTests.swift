import ChatDomain
import Foundation
import XCTest

final class ChatFollowupTests: XCTestCase {
  func testLateFollowupsKeepOrderAndRetireVideoWithoutChangingMessages() throws {
    let rows =
      completed + [
        followups(
          4,
          content: """
            {"version":1,"followups":[{"prompt":"Talk","kind":"talk"},{"prompt":"Slides","kind":"generate","generationType":"presentation"},{"prompt":"Image","kind":"generate","generationType":"image"},{"prompt":"Site","kind":"generate","generationType":"website"},{"prompt":"Files","kind":"generate"},{"prompt":"Retired","kind":"generate","generationType":"video"}]}
            """)
      ]
    let history = try project(rows)
    XCTAssertEqual(history.recommendedFollowups?.eventID, "4")
    XCTAssertEqual(
      history.recommendedFollowups?.followups.map(\.prompt),
      ["Talk", "Slides", "Image", "Site", "Files"])
    XCTAssertEqual(history.messages, try project(completed).messages)
    XCTAssertEqual(
      try project(rows + [event(5, .usageRecorded)]).recommendedFollowups,
      history.recommendedFollowups)
  }

  func testUnsupportedLatestDocumentNeverRevivesOlderSuggestionsOrBreaksHistory() throws {
    for content in [
      "not json", "{\"version\":2,\"followups\":[]}",
      "{\"version\":true,\"followups\":[]}",
      "{\"version\":1,\"followups\":[],\"extra\":true}",
      "{\"version\":1,\"followups\":[{\"prompt\":\"x\",\"kind\":\"unknown\"}]}",
      "{\"version\":1,\"followups\":[{\"prompt\":\"x\",\"kind\":\"talk\",\"extra\":true}]}",
      "{\"version\":1,\"followups\":[{\"prompt\":\"x\",\"kind\":\"generate\",\"generationType\":null}]}",
      "{\"version\":1,\"followups\":[{\"prompt\":\"x\",\"kind\":\"generate\",\"generationType\":\"future\"}]}",
      "{\"version\":1,\"followups\":[{\"prompt\":\"x\",\"kind\":\"generate\",\"generationType\":\"video\"}]}",
    ] {
      let history = try project(completed + [followups(4), followups(5, content: content)])
      XCTAssertNil(history.recommendedFollowups, content)
      XCTAssertEqual(history.messages.count, 2)
    }
  }

  func testNewReplyNewUserAndActiveWorkHideOlderRecommendations() throws {
    let rows = completed + [followups(4)]
    XCTAssertNotNil(try project(rows).recommendedFollowups)
    for tail in [
      [event(5, .outputMessage, content: "Updated", run: "run")],
      [event(5, .inputPrompt, run: "next")],
      [event(5, .inputPrompt, run: nil)],
      [
        event(5, .inputPrompt, run: "next"),
        event(6, .outputMessage, content: "New answer", run: "next"),
        event(7, .runCompleted, run: "next"),
      ],
      [event(5, .outputError, content: "Failed")],
      [event(5, .runFailed, content: "Failed")],
      [event(5, .runCancelled)],
    ] {
      XCTAssertNil(try project(rows + tail).recommendedFollowups)
    }
    XCTAssertNil(try ChatEventProjection.history(rows: rows, recovering: true).recommendedFollowups)
  }

  func testLateOldRunDoesNotOvertakeNewRunAndSameRunNewTurnRetiresSource() throws {
    let newer = [
      event(5, .inputPrompt, run: "next"), event(6, .outputMessage, content: "New", run: "next"),
      event(7, .runCompleted, run: "next"),
    ]
    XCTAssertNil(try project(completed + newer + [followups(8)]).recommendedFollowups)
    let newerSource = followups(8, run: "next")
    XCTAssertEqual(
      try project(completed + [followups(4)] + newer + [newerSource, followups(9)])
        .recommendedFollowups?.eventID, "8")
    XCTAssertNil(
      try project(completed + [followups(4), event(5, .inputPrompt)]).recommendedFollowups)
  }

  func testRevocationAndQueuedAutomationFollowSemanticVisibility() throws {
    let rows = completed + [followups(4)]
    let queue = event(5, .inputAutomation, run: nil)
    // Queued automation is outside active groups, but still hides the finished row while queued.
    XCTAssertNil(try project(rows + [queue]).recommendedFollowups)
    let revokeQueue = ChatEvent(
      id: "6", revokesEventId: "5", createdAt: .now, eventType: .controlRevoke)
    XCTAssertNotNil(try project(rows + [queue, revokeQueue]).recommendedFollowups)
    let revokeSource = ChatEvent(
      id: "7", revokesEventId: "4", createdAt: .now, eventType: .controlRevoke)
    XCTAssertNil(try project(rows + [revokeSource]).recommendedFollowups)
    let interrupt = ChatEvent(
      id: "8", runId: "run", createdAt: .now, eventType: .controlInterrupt)
    XCTAssertNil(try project(rows + [interrupt]).recommendedFollowups)
  }

  func testErrorTailReplacesRecommendationsButLateOldErrorsDoNotHideTheLatestRun() throws {
    let error = ChatEvent(
      id: "10", runId: "run", createdAt: .now, eventType: .outputError,
      payload: .init(error: "Failure details"))
    XCTAssertNil(
      try project(completed + [followups(4), error, followups(11)]).recommendedFollowups)
    let newer = [
      event(5, .inputPrompt, run: "next"), event(6, .outputMessage, content: "New", run: "next"),
      event(7, .runCompleted, run: "next"), followups(8, run: "next"),
    ]
    XCTAssertEqual(try project(completed + newer + [error]).recommendedFollowups?.eventID, "8")
    // Bookkeeping from another run is not a replacement for the last visible outcome.
    XCTAssertNil(
      try project(
        completed + [
          error, event(12, .runCompleted, run: "bookkeeping"), followups(13, run: "bookkeeping"),
        ]
      ).recommendedFollowups)
    let interrupt = ChatEvent(id: "14", runId: "run", createdAt: .now, eventType: .controlInterrupt)
    XCTAssertNil(try project(completed + [interrupt, followups(15)]).recommendedFollowups)
  }

  private var completed: [ChatEvent] {
    [event(1, .inputPrompt), event(2, .outputMessage, content: "Answer"), event(3, .runCompleted)]
  }

  private func project(_ rows: [ChatEvent]) throws -> ChatHistory {
    try ChatEventProjection.history(rows: rows, recovering: false)
  }

  private func followups(
    _ id: Int,
    content: String = "{\"version\":1,\"followups\":[{\"prompt\":\"Continue\",\"kind\":\"talk\"}]}",
    run: String = "run"
  ) -> ChatEvent {
    event(id, .outputFollowups, content: content, run: run)
  }

  private func event(_ id: Int, _ type: ChatEventType, content: String? = nil, run: String? = "run")
    -> ChatEvent
  {
    ChatEvent(
      id: String(id), runId: run, createdAt: Date(timeIntervalSince1970: Double(id)),
      eventType: type,
      payload: .init(
        content: content,
        userMessage: type == .inputPrompt
          ? .init(version: 1, parts: [.init(type: "text", text: "Question")]) : nil))
  }
}
