import Foundation
import XCTest

@testable import Okou

private let replayThread = "10000000-0000-4000-8000-000000000101"
private let replayOtherThread = "10000000-0000-4000-8000-000000000102"
private let replayAgent = "10000000-0000-4000-8000-000000000103"

final class ChatThreadReplayTests: XCTestCase {
  func testCreationReplaysOnlyNewerDeferredSettingsAndDropsOtherPreCreationEvents() throws {
    let events = try decodeEvents(
      [
        event(1, "renamed", at: "2026-09-09T00:00:11.000Z", extra: #""title":"Ignored""#),
        event(
          2, "model_selection_updated", at: "2026-09-09T00:00:09.000Z",
          extra: #""selectedModel":"old","modelSettingsPatch":{"model":"old","effort":"low"}"#),
        event(
          3, "model_selection_updated", at: "2026-09-09T00:00:11.000Z",
          extra:
            #""selectedModel":"claude-opus-4-8","modelSettingsPatch":{"model":"claude-opus-4-8","effort":"extra"}"#
        ),
        event(
          4, "service_tier_updated", at: "2026-09-09T00:00:12.000Z",
          extra: #""serviceTier":"priority""#),
        event(
          5, "computer_use_host_updated", at: "2026-09-09T00:00:13.000Z",
          extra:
            #""computerUseHostId":"10000000-0000-4000-8000-000000000104","cloudBrowserEnabled":true"#
        ),
        event(
          6, "created", at: "2026-09-09T00:00:10.000Z",
          extra:
            #""title":"Original","selectedModel":"claude-sonnet-5","modelSettings":{"claude-sonnet-5":{"effort":"high"}}"#
        ),
      ])

    let result = try XCTUnwrap(ChatThreadReplay.replay(snapshot: [], events: events).first)
    XCTAssertEqual(result.title, "Original")
    XCTAssertNil(result.renamedAt)
    XCTAssertEqual(result.selectedModel, "claude-opus-4-8")
    XCTAssertEqual(result.modelSettings["claude-sonnet-5"]?.effort, "high")
    XCTAssertEqual(result.modelSettings["claude-opus-4-8"]?.effort, "extra")
    XCTAssertNil(result.modelSettings["old"])
    XCTAssertEqual(result.serviceTier, "priority")
    XCTAssertEqual(result.computerUseHostId, "10000000-0000-4000-8000-000000000104")
    XCTAssertTrue(result.cloudBrowserEnabled)
    XCTAssertEqual(result.updatedAt, try date("2026-09-09T00:00:13.000Z"))
  }

  func testSnapshotTailPreservesActivityTimeAndManualPinMove() throws {
    let snapshot = try decodeSnapshot(
      """
      {"chatThreads":[
        {"id":"\(replayThread)","agentId":"\(replayAgent)","title":"Snapshot",\
         "createdAt":"2026-09-09T00:00:00.000Z","updatedAt":"2026-09-09T00:00:00.000Z",\
         "sortAt":"2026-09-09T00:00:00.000Z","pinnedAt":null,"archived":false,\
         "selectedModel":"claude-sonnet-5","modelSettings":{"claude-sonnet-5":{"effort":"high"}}},
        {"id":"\(replayOtherThread)","agentId":"\(replayAgent)","title":"Deleted",\
         "createdAt":"2026-09-09T00:00:00.000Z","updatedAt":"2026-09-09T00:00:00.000Z",\
         "sortAt":"2026-09-09T00:00:00.000Z","pinnedAt":null,"archived":false}]}
      """)
    let events = try decodeEvents(
      [
        event(1, "deleted", thread: replayOtherThread, at: "2026-09-09T00:00:01.000Z"),
        event(2, "archived", at: "2026-09-09T00:00:02.000Z"),
        event(3, "sort_touched", at: "2026-09-09T00:00:10.000Z"),
        event(4, "sort_touched", at: "2026-09-09T00:00:05.000Z"),
        event(5, "pinned", at: "2026-09-09T00:00:11.000Z", extra: #""pinOrder":"a1""#),
        event(
          6, "sort_touched", at: "2026-09-09T00:00:12.000Z",
          extra: #""pinOrder":"a0""#),
        event(7, "unarchived", at: "2026-09-09T00:00:13.000Z"),
      ])

    let result = try XCTUnwrap(ChatThreadReplay.replay(snapshot: snapshot, events: events).first)
    XCTAssertEqual(ChatThreadReplay.replay(snapshot: snapshot, events: events).count, 1)
    XCTAssertFalse(result.isArchived)
    XCTAssertEqual(result.sortAt, try date("2026-09-09T00:00:10.000Z"))
    XCTAssertEqual(result.updatedAt, try date("2026-09-09T00:00:13.000Z"))
    XCTAssertEqual(result.pinnedAt, try date("2026-09-09T00:00:11.000Z"))
    XCTAssertEqual(result.pinOrder, "a0")
    XCTAssertEqual(result.modelSettings["claude-sonnet-5"]?.effort, "high")
  }

  func testManualPinMoveDoesNotChangeUpdatedOrSortTimeAndRanksSidebar() throws {
    let threads = try decodeEvents(
      [
        event(1, "created", at: "2026-09-09T00:00:01.000Z"),
        event(
          2, "created", thread: replayOtherThread, at: "2026-09-09T00:00:00.000Z"),
        event(3, "pinned", at: "2026-09-09T00:00:02.000Z", extra: #""pinOrder":"a1""#),
        event(
          4, "pinned", thread: replayOtherThread, at: "2026-09-09T00:00:03.000Z",
          extra: #""pinOrder":"a2""#),
        event(
          5, "sort_touched", thread: replayOtherThread, at: "2026-09-09T00:00:04.000Z",
          extra: #""pinOrder":"a0""#),
      ])
    let replayed = ChatThreadReplay.replay(snapshot: [], events: threads)
    XCTAssertEqual(replayed.map(\.id), [replayThread, replayOtherThread])
    let moved = try XCTUnwrap(replayed.first(where: { $0.id == replayOtherThread }))
    XCTAssertEqual(moved.updatedAt, try date("2026-09-09T00:00:03.000Z"))
    XCTAssertEqual(moved.sortAt, try date("2026-09-09T00:00:00.000Z"))
    XCTAssertEqual(
      ChatThreadReplay.sidebarOrder(replayed).map(\.id), [replayOtherThread, replayThread])
  }

  func testCanonicalAgentReassignmentSurvivesLaterActivityFromTheOldAgent() throws {
    let newAgent = "10000000-0000-4000-8000-000000000105"
    let events = try decodeEvents(
      [
        event(1, "created", at: "2026-09-09T00:00:01.000Z"),
        event(
          2, "sort_touched", at: "2026-09-09T00:00:02.000Z",
          extra: #""reassignedAgentId":"\#(newAgent)""#),
        event(3, "sort_touched", at: "2026-09-09T00:00:03.000Z"),
      ])

    let thread = try XCTUnwrap(ChatThreadReplay.replay(snapshot: [], events: events).first)
    XCTAssertEqual(thread.agentID, newAgent)
    XCTAssertEqual(thread.sortAt, try date("2026-09-09T00:00:03.000Z"))
    XCTAssertEqual(thread.updatedAt, try date("2026-09-09T00:00:01.000Z"))
  }

  func testManualOrderingTouchReassignsPinnedAndUnpinnedThreadsWithoutActivity() throws {
    let newAgent = "10000000-0000-4000-8000-000000000105"
    let events = try decodeEvents(
      [
        event(1, "created", at: "2026-09-09T00:00:01.000Z"),
        event(2, "created", thread: replayOtherThread, at: "2026-09-09T00:00:01.000Z"),
        event(3, "pinned", at: "2026-09-09T00:00:02.000Z", extra: #""pinOrder":"a1""#),
        event(
          4, "sort_touched", at: "2026-09-09T00:00:03.000Z",
          extra: #""pinOrder":"a0","reassignedAgentId":"\#(newAgent)""#),
        event(
          5, "sort_touched", thread: replayOtherThread, at: "2026-09-09T00:00:03.000Z",
          extra: #""pinOrder":"a0","reassignedAgentId":"\#(newAgent)""#),
      ])

    let threads = ChatThreadReplay.replay(snapshot: [], events: events)
    let pinned = try XCTUnwrap(threads.first(where: { $0.id == replayThread }))
    let unpinned = try XCTUnwrap(threads.first(where: { $0.id == replayOtherThread }))
    XCTAssertEqual(pinned.agentID, newAgent)
    XCTAssertEqual(unpinned.agentID, newAgent)
    XCTAssertEqual(pinned.pinOrder, "a0")
    XCTAssertNil(unpinned.pinOrder)
    XCTAssertEqual(pinned.sortAt, try date("2026-09-09T00:00:01.000Z"))
    XCTAssertEqual(unpinned.sortAt, try date("2026-09-09T00:00:01.000Z"))
    XCTAssertEqual(pinned.updatedAt, try date("2026-09-09T00:00:02.000Z"))
    XCTAssertEqual(unpinned.updatedAt, try date("2026-09-09T00:00:01.000Z"))
  }

  private func decodeEvents(_ json: [String]) throws -> [ThreadEvent] {
    try json.map { try APIClient.decoder().decode(ThreadEvent.self, from: Data($0.utf8)) }
  }

  private func decodeSnapshot(_ json: String) throws -> [ThreadProjection] {
    try APIClient.decoder().decode(ThreadSnapshotArchive.self, from: Data(json.utf8)).chatThreads
  }

  private func date(_ text: String) throws -> Date {
    try APIClient.decoder().decode(Date.self, from: Data("\"\(text)\"".utf8))
  }

  private func event(
    _ seq: Int, _ kind: String, thread: String = replayThread,
    at createdAt: String, extra: String = ""
  ) -> String {
    let eventID = String(format: "10000000-0000-4000-8000-%012d", seq)
    return """
      {"id":"\(eventID)","seqId":\(seq),"kind":"\(kind)",\
       "chatThreadId":"\(thread)","agentId":"\(replayAgent)",\
       "createdAt":"\(createdAt)"\(extra.isEmpty ? "" : ",\(extra)")}
      """
  }
}
