import ChatDomain
import Foundation
import XCTest

private let replayThread = "10000000-0000-4000-8000-000000000101"
private let replayOtherThread = "10000000-0000-4000-8000-000000000102"
private let replayAgent = "10000000-0000-4000-8000-000000000103"

final class ChatThreadReplayTests: XCTestCase {
  func testCreationReplaysOnlyNewerDeferredSettingsAndDropsOtherPreCreationEvents() throws {
    let events = [
      event(.renamed, at: 11, title: "Ignored"),
      event(
        .modelSelectionUpdated, at: 9, selectedModel: "old",
        modelSettingsPatch: .init(model: "old", effort: "low")),
      event(
        .modelSelectionUpdated, at: 11, selectedModel: "claude-opus-4-8",
        modelSettingsPatch: .init(model: "claude-opus-4-8", effort: "extra")),
      event(.serviceTierUpdated, at: 12, serviceTier: "priority"),
      event(
        .computerUseHostUpdated, at: 13,
        computerUseHostId: "10000000-0000-4000-8000-000000000104", cloudBrowserEnabled: true),
      event(
        .created, at: 10, title: "Original", selectedModel: "claude-opus-5-5",
        modelSettings: ["claude-opus-5-5": .init(effort: "high")]),
    ]
    let result = try XCTUnwrap(ChatThreadReplay.replay(snapshot: [], events: events).first)

    XCTAssertEqual(result.title, "Original")
    XCTAssertNil(result.renamedAt)
    XCTAssertEqual(result.selectedModel, "claude-opus-4-8")
    XCTAssertEqual(result.modelSettings["claude-opus-5-5"]?.effort, "high")
    XCTAssertEqual(result.modelSettings["claude-opus-4-8"]?.effort, "extra")
    XCTAssertNil(result.modelSettings["old"])
    XCTAssertEqual(result.serviceTier, "priority")
    XCTAssertEqual(result.computerUseHostId, "10000000-0000-4000-8000-000000000104")
    XCTAssertTrue(result.cloudBrowserEnabled)
    XCTAssertEqual(result.updatedAt, date(13))
  }

  func testSnapshotTailPreservesActivityTimeAndManualPinMove() throws {
    let snapshot = [
      ChatThread(
        id: replayThread, agentID: replayAgent, title: "Snapshot", selectedModel: "claude-opus-5-5",
        createdAt: date(0), updatedAt: date(0), sortAt: date(0),
        modelSettings: ["claude-opus-5-5": .init(effort: "high")]),
      ChatThread(
        id: replayOtherThread, agentID: replayAgent, title: "Deleted",
        createdAt: date(0), updatedAt: date(0), sortAt: date(0)),
    ]
    let events = [
      event(.deleted, thread: replayOtherThread, at: 1),
      event(.archived, at: 2),
      event(.sortTouched, at: 10),
      event(.sortTouched, at: 5),
      event(.pinned, at: 11, pinOrder: "a1"),
      event(.sortTouched, at: 12, pinOrder: "a0"),
      event(.unarchived, at: 13),
    ]
    let threads = ChatThreadReplay.replay(snapshot: snapshot, events: events)
    let result = try XCTUnwrap(threads.first)

    XCTAssertEqual(threads.count, 1)
    XCTAssertFalse(result.isArchived)
    XCTAssertEqual(result.sortAt, date(10))
    XCTAssertEqual(result.updatedAt, date(13))
    XCTAssertEqual(result.pinnedAt, date(11))
    XCTAssertEqual(result.pinOrder, "a0")
    XCTAssertEqual(result.modelSettings["claude-opus-5-5"]?.effort, "high")
  }

  func testManualPinMoveDoesNotChangeUpdatedOrSortTimeAndRanksSidebar() throws {
    let events = [
      event(.created, at: 1),
      event(.created, thread: replayOtherThread, at: 0),
      event(.pinned, at: 2, pinOrder: "a1"),
      event(.pinned, thread: replayOtherThread, at: 3, pinOrder: "a2"),
      event(.sortTouched, thread: replayOtherThread, at: 4, pinOrder: "a0"),
    ]
    let replayed = ChatThreadReplay.replay(snapshot: [], events: events)
    let moved = try XCTUnwrap(replayed.first(where: { $0.id == replayOtherThread }))

    XCTAssertEqual(replayed.map(\.id), [replayThread, replayOtherThread])
    XCTAssertEqual(moved.updatedAt, date(3))
    XCTAssertEqual(moved.sortAt, date(0))
    XCTAssertEqual(
      ChatThreadReplay.sidebarOrder(replayed).map(\.id), [replayOtherThread, replayThread])
  }

  func testCanonicalAgentReassignmentSurvivesLaterActivityFromTheOldAgent() throws {
    let newAgent = "10000000-0000-4000-8000-000000000105"
    let events = [
      event(.created, at: 1),
      event(.sortTouched, at: 2, reassignedAgentId: newAgent),
      event(.sortTouched, at: 3),
    ]
    let thread = try XCTUnwrap(ChatThreadReplay.replay(snapshot: [], events: events).first)

    XCTAssertEqual(thread.agentID, newAgent)
    XCTAssertEqual(thread.sortAt, date(3))
    XCTAssertEqual(thread.updatedAt, date(1))
  }

  func testManualOrderingTouchReassignsPinnedAndUnpinnedThreadsWithoutActivity() throws {
    let newAgent = "10000000-0000-4000-8000-000000000105"
    let events = [
      event(.created, at: 1),
      event(.created, thread: replayOtherThread, at: 1),
      event(.pinned, at: 2, pinOrder: "a1"),
      event(.sortTouched, at: 3, reassignedAgentId: newAgent, pinOrder: "a0"),
      event(
        .sortTouched, thread: replayOtherThread, at: 3, reassignedAgentId: newAgent, pinOrder: "a0"),
    ]
    let threads = ChatThreadReplay.replay(snapshot: [], events: events)
    let pinned = try XCTUnwrap(threads.first(where: { $0.id == replayThread }))
    let unpinned = try XCTUnwrap(threads.first(where: { $0.id == replayOtherThread }))

    XCTAssertEqual(pinned.agentID, newAgent)
    XCTAssertEqual(unpinned.agentID, newAgent)
    XCTAssertEqual(pinned.pinOrder, "a0")
    XCTAssertNil(unpinned.pinOrder)
    XCTAssertEqual(pinned.sortAt, date(1))
    XCTAssertEqual(unpinned.sortAt, date(1))
    XCTAssertEqual(pinned.updatedAt, date(2))
    XCTAssertEqual(unpinned.updatedAt, date(1))
  }

  private func date(_ seconds: TimeInterval) -> Date {
    Date(timeIntervalSince1970: seconds)
  }

  private func event(
    _ kind: ChatThreadChange.Kind, thread: String = replayThread, at seconds: TimeInterval,
    reassignedAgentId: String? = nil, title: String? = nil, selectedModel: String? = nil,
    pinOrder: String? = nil, modelSettings: [String: ThreadModelSetting]? = nil,
    modelSettingsPatch: ThreadModelSettingsPatch? = nil, serviceTier: String? = nil,
    computerUseHostId: String? = nil, cloudBrowserEnabled: Bool? = nil
  ) -> ChatThreadChange {
    ChatThreadChange(
      kind: kind, chatThreadId: thread, agentId: replayAgent, reassignedAgentId: reassignedAgentId,
      title: title, selectedModel: selectedModel, pinOrder: pinOrder, modelSettings: modelSettings,
      modelSettingsPatch: modelSettingsPatch, serviceTier: serviceTier,
      computerUseHostId: computerUseHostId, cloudBrowserEnabled: cloudBrowserEnabled,
      createdAt: date(seconds))
  }
}
