import ChatDomain
import Foundation
import XCTest

private let replayThread = "10000000-0000-4000-8000-000000000101"
private let replayOtherThread = "10000000-0000-4000-8000-000000000102"
private let replayAgent = "10000000-0000-4000-8000-000000000103"

final class ChatThreadReplayTests: XCTestCase {

  func testProjectMembershipMovesAndLeavesWithoutChangingAgentOrActivity() throws {
    let original = try XCTUnwrap(
      ChatThreadReplay.replay(
        snapshot: [], events: [event(.created, at: 1, title: "Planning")]
      ).first)
    let project = "10000000-0000-4000-8000-000000000071"
    let moved = ChatThreadChange(
      kind: .projectUpdated, chatThreadId: replayThread, agentId: replayAgent,
      projectId: project, createdAt: date(10))
    let member = try XCTUnwrap(ChatThreadReplay.replay(snapshot: [original], events: [moved]).first)
    XCTAssertEqual(member.projectId, project)
    XCTAssertEqual(member.agentID, original.agentID)
    XCTAssertEqual(member.sortAt, original.sortAt)
    XCTAssertEqual(member.title, original.title)
    let leave = ChatThreadChange(
      kind: .projectUpdated, chatThreadId: replayThread, agentId: replayAgent,
      projectId: nil, createdAt: date(11))
    XCTAssertNil(ChatThreadReplay.replay(snapshot: [member], events: [leave]).first?.projectId)
    XCTAssertEqual(
      ChatThreadReplay.replay(snapshot: [member], events: []).first?.projectId, project)
    XCTAssertEqual(
      ChatThreadReplay.replay(
        snapshot: [], events: [moved, event(.created, at: 1)]
      ).first?.projectId,
      project)
  }

  func testPrependingPinsMatchesPWAFractionalKeysAndLegacyRanking() throws {
    XCTAssertEqual(try ChatThreadReplay.firstPinOrder([]), "a0")
    let smallest = "A" + String(repeating: "0", count: 26)
    for (existing, expected) in [
      ("a1", "a0"), ("a0", "Zz"), ("Zz", "Zy"), ("Z0", "Yzz"),
      ("Y00", "Xzzz"), ("b00", "az"), ("a0V", "a0"),
      (smallest + "V", smallest + "G"), (smallest + "01", smallest + "00V"),
    ] {
      let snapshot = ChatThreadReplay.replay(
        snapshot: [], events: [event(.created, at: 1), event(.pinned, at: 2, pinOrder: existing)])
      XCTAssertEqual(try ChatThreadReplay.firstPinOrder(snapshot), expected, existing)
    }
    let legacy = ChatThreadReplay.replay(
      snapshot: [], events: [event(.created, at: 1), event(.pinned, at: 2)])
    XCTAssertEqual(try ChatThreadReplay.firstPinOrder(legacy), "a0")
  }

  func testPinOrderKeysMatchPWAFractionalIndexing() throws {
    let cases: [(String?, String?, String)] = [
      (nil, nil, "a0"), (nil, "a0", "Zz"), ("a0", nil, "a1"), ("a0", "a1", "a0V"),
      ("a1", "a2", "a1V"), ("a0V", "a1", "a0l"), ("Zz", "a0", "ZzV"), ("Zz", "a1", "a0"),
      ("bzz", nil, "c000"), ("a0", "a0V", "a0G"), ("b125", "b129", "b127"),
    ]
    for (lower, upper, expected) in cases {
      XCTAssertEqual(
        try ChatPinOrder.key(between: lower, and: upper), expected,
        "\(lower ?? "-") \(upper ?? "-")")
    }
    XCTAssertEqual(
      try ChatPinOrder.keys(between: "a0", and: "a1", count: 5),
      ["a08", "a0G", "a0V", "a0d", "a0l"])
    XCTAssertEqual(try ChatPinOrder.keys(between: nil, and: nil, count: 3), ["a0", "a1", "a2"])
    XCTAssertEqual(try ChatPinOrder.keys(between: nil, and: "a0", count: 2), ["Zy", "Zz"])
    // Reversed bounds and a fraction ending in zero are not keys the API or the PWA accept.
    XCTAssertThrowsError(try ChatPinOrder.key(between: "a1", and: "a0"))
    XCTAssertThrowsError(try ChatPinOrder.key(between: "a10", and: nil))
  }

  func testMovingAPinRewritesOnlyItsRankUnlessItLandsInATiedRun() throws {
    let third = "10000000-0000-4000-8000-000000000104"
    let pins = ChatThreadReplay.replay(
      snapshot: [],
      events: [
        event(.created, at: 1), event(.created, thread: replayOtherThread, at: 1),
        event(.created, thread: third, at: 1), event(.pinned, at: 2, pinOrder: "a0"),
        event(.pinned, thread: replayOtherThread, at: 2, pinOrder: "a1"),
        event(.pinned, thread: third, at: 2, pinOrder: "a2"),
      ])
    func move(_ id: String, _ target: String, _ placement: ChatThreadReplay.PinPlacement)
      throws -> [[String]]
    {
      try ChatThreadReplay.movePinOrder(
        pins, threadID: id, targetID: target, placement: placement
      ).map { [$0.threadID, $0.pinOrder] }
    }
    XCTAssertEqual(try move(third, replayThread, .before), [[third, "Zz"]])
    XCTAssertEqual(try move(replayThread, replayOtherThread, .after), [[replayThread, "a1V"]])
    XCTAssertEqual(try move(replayThread, third, .after), [[replayThread, "a3"]])
    // Already in place, or beside itself: nothing to write.
    XCTAssertEqual(try move(replayOtherThread, replayThread, .after), [])
    XCTAssertEqual(try move(replayThread, replayThread, .before), [])

    // Ties order by id, larger first. Landing between equal ranks re-spreads that run.
    let tied = ChatThreadReplay.replay(
      snapshot: pins,
      events: [event(.sortTouched, thread: replayOtherThread, at: 3, pinOrder: "a2")])
    XCTAssertEqual(
      ChatThreadReplay.sidebarOrder(tied).map(\.id), [replayThread, third, replayOtherThread])
    let spread = try ChatThreadReplay.movePinOrder(
      tied, threadID: replayThread, targetID: third, placement: .after)
    XCTAssertEqual(
      spread.map { [$0.threadID, $0.pinOrder] },
      [[replayThread, "a3"], [replayOtherThread, "a4"]])
  }

  func testMuteReplaySuppressesUnreadWithoutChangingActivityOrPinRanking() throws {
    var original = try XCTUnwrap(
      ChatThreadReplay.replay(
        snapshot: [], events: [event(.created, at: 1, title: "Brief")]
      ).first)
    original.unreadAt = date(5)
    original.indicator = .active
    let muted = ChatThreadChange(
      kind: .sortTouched, chatThreadId: replayThread, agentId: replayAgent,
      muted: true, createdAt: date(10))
    let result = try XCTUnwrap(ChatThreadReplay.replay(snapshot: [original], events: [muted]).first)
    XCTAssertTrue(result.isMuted)
    XCTAssertFalse(result.isUnread)
    XCTAssertEqual(result.indicator, .active)
    XCTAssertEqual(result.sortAt, original.sortAt)
    XCTAssertEqual(result.updatedAt, original.updatedAt)
    let unmuted = ChatThreadChange(
      kind: .sortTouched, chatThreadId: replayThread, agentId: replayAgent,
      muted: false, createdAt: date(11))
    XCTAssertEqual(ChatThreadReplay.replay(snapshot: [result], events: [unmuted]), [original])
  }

  func testHiddenThreadsCanBecomeVisibleWithoutLosingConversationMetadata() throws {
    let snapshot = ChatThreadReplay.replay(
      snapshot: [], events: [event(.created, at: 1, title: "Brief")])
    let hide = ChatThreadChange(
      kind: .sortTouched, chatThreadId: replayThread, agentId: replayAgent,
      hidden: true, createdAt: date(10))
    let show = ChatThreadChange(
      kind: .sortTouched, chatThreadId: replayThread, agentId: replayAgent,
      hidden: false, createdAt: date(11))
    XCTAssertTrue(ChatThreadReplay.replay(snapshot: snapshot, events: [hide]).isEmpty)
    XCTAssertEqual(ChatThreadReplay.replay(snapshot: snapshot, events: [hide, show]), snapshot)
    var hiddenSnapshot = try XCTUnwrap(snapshot.first)
    hiddenSnapshot.isHidden = true
    XCTAssertTrue(ChatThreadReplay.replay(snapshot: [hiddenSnapshot], events: []).isEmpty)
    XCTAssertEqual(ChatThreadReplay.replay(snapshot: [hiddenSnapshot], events: [show]), snapshot)
  }
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
