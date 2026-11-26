import ChatDomain
import Foundation
import XCTest

@testable import Okou

@MainActor
final class ConversationTimelineTests: XCTestCase {
  func testAnOvernightAnswerStartsItsOwnDayAndOnlyTheNewestReplyPlays() throws {
    // Both answers are on Nov 25 in UTC, on different local days in Shanghai.
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
    let late = try Date("2026-11-25T15:58:00Z", strategy: .iso8601)
    let early = try Date("2026-11-25T16:02:00Z", strategy: .iso8601)
    let timeline = ConversationTimeline(
      now: early, calendar: calendar, locale: Locale(identifier: "en_US"))
    let history = try ChatEventProjection.history(
      rows: [
        prompt("question-1", run: "first", at: late), answer("answer-1", run: "first", at: late),
        ChatEvent(id: "done-1", runId: "first", createdAt: late, eventType: .runCompleted),
        prompt("question-2", run: "next", at: late), answer("answer-2", run: "next", at: early),
        ChatEvent(id: "done-2", runId: "next", createdAt: early, eventType: .runCompleted)
      ], recovering: false)
    let conversation = ConversationHistoryFixture(count: 0).conversation()
    defer { conversation.close() }
    let projection = ConversationProjection(store: conversation.graph)
    projection.confirmHistory(history)
    let value = projection.currentValue
    let rows = ConversationRowProjection(
      conversation: conversation, transcript: value,
      window: .init(items: value.items), isSending: false, models: nil, timeline: timeline
    ).rows
    let headers = history.workSections
    let newest = try XCTUnwrap(headers.last)
    XCTAssertEqual(rows.filter(\.animatesAvatar).map(\.id), [newest.id])
    let dates = rows.compactMap { row -> String? in
      guard case .dateDivider(_, let label) = row.content else { return nil }
      return label
    }
    XCTAssertEqual(dates, ["Yesterday", "Today"])
    let start = try XCTUnwrap(rows.firstIndex { $0.id == newest.id })
    XCTAssertEqual(rows[start - 1].content, .dateDivider(before: newest.id, label: "Today"))
    XCTAssertTrue(
      rows.contains {
        if case .finished(let label, nil, false) = $0.content {
          return label.contains("Delivered at")
        }
        return false
      })
    let todayOnly = timeline.rows(
      [
        .share(
          .init(id: "answer-2", messages: [try XCTUnwrap(history.messages.last)]), topSpacing: 0)
      ], items: [])
    XCTAssertFalse(
      todayOnly.contains {
        if case .dateDivider = $0.content { return true }
        return false
      })
  }

  private func prompt(_ id: String, run: String, at date: Date) -> ChatEvent {
    ChatEvent(
      id: id, runId: run, createdAt: date, eventType: .inputPrompt,
      payload: .init(userMessage: .init(version: 1, parts: [.init(type: "text", text: "Question")]))
    )
  }

  private func answer(_ id: String, run: String, at date: Date) -> ChatEvent {
    ChatEvent(
      id: id, runId: run, createdAt: date, eventType: .outputMessage,
      payload: .init(content: "Answer"))
  }
}
