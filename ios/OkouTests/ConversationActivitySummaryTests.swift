import ChatData
import ChatDataTestSupport
import ChatDomain
import Observation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationActivitySummaryTests: XCTestCase {

  private func waitForSleep(_ clock: ActivityClock, _ duration: Duration) async throws {
    try await waitForBusinessResult { clock.hasSleeper(duration) }
  }

  private func waitForNoSleep(_ clock: ActivityClock, duration: Duration? = nil) async throws {
    try await waitForBusinessResult { !clock.hasSleeper(duration) }
  }

  private func waitForRequest(_ scenario: ActivityScenario, after count: Int) async throws {
    let received = expectation(description: "The activity summary request reached HTTP")
    let observation = Task {
      for await total in scenario.requests where total > count {
        received.fulfill()
        return
      }
    }
    await fulfillment(of: [received], timeout: 3)
    observation.cancel()
    await observation.value
    _ = try XCTUnwrap(scenario.state.requests.withLock { $0 } > count ? true : nil)
  }
  private func read(_ conversation: ConversationStore) async throws -> ChatActivitySummary? {
    let summary = conversation.activitySummary
    return try await summary.stateStore.get(summary.value).value
  }

  private func assertHidden(
    _ conversation: ConversationStore, batch: ChatActivitySummary?,
    file: StaticString = #filePath, line: UInt = #line
  ) {
    XCTAssertNil(conversation.activitySummary.text(in: batch), file: file, line: line)
  }

  func testRefreshRotationAndFailureDegradationDoNotChangeTranscript() async throws {
    let scenario = ActivityScenario()
    let clock = ActivityClock()
    let conversation = scenario.conversation(clock: clock)
    defer { conversation.close() }
    await conversation.refresh()
    let hidden = try await read(conversation)
    assertHidden(conversation, batch: hidden)
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 0)
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    let initial = try await read(conversation)
    XCTAssertEqual(conversation.activitySummary.text(in: initial), "Checking the sources")
    let messages = conversation.messages
    let items = conversation.visibleItems
    let history = conversation.history
    try await waitForSleep(clock, .seconds(5))
    clock.advance(.seconds(5))
    try await waitForBusinessResult {
      conversation.activitySummary.text(in: initial) == "Comparing the results"
    }
    try await waitForSleep(clock, .seconds(15))
    clock.advance(.seconds(15))
    try await waitForRequest(scenario, after: 1)
    let refreshed = try await read(conversation)
    XCTAssertEqual(conversation.activitySummary.text(in: refreshed), "Comparing the results")
    XCTAssertEqual(conversation.messages, messages)
    XCTAssertEqual(conversation.visibleItems, items)
    XCTAssertEqual(conversation.history, history)

    for status in ["available", "ineligible", "unavailable"] {
      scenario.state.response.withLock {
        $0 = ChatHTTPResponse(
          body: "{\"runId\":\"\(ActivityScenario.run)\",\"status\":\"\(status)\",\"messages\":[]}")
      }
      conversation.activitySummary.retry()
      let empty = try await read(conversation)
      assertHidden(conversation, batch: empty)
      XCTAssertNil(conversation.error)
      XCTAssertEqual(conversation.history, history)
    }
    for status in [401, 403, 500] {
      scenario.state.response.withLock {
        $0 = ChatHTTPResponse(status: status, body: #"{"error":{"message":"Unavailable"}}"#)
      }
      conversation.activitySummary.retry()
      let original = try conversation.activitySummary.stateStore.get(
        conversation.activitySummary.value)
      guard case .failure(let error) = await original.result else {
        return XCTFail("The original resource must retain its HTTP failure")
      }
      XCTAssertEqual((error as? APIClientError)?.statusCode, status)
      XCTAssertNil(conversation.error)
      XCTAssertEqual(conversation.history, history)
      XCTAssertEqual(conversation.messages, messages)
    }
    scenario.state.response.withLock { $0 = nil }
    conversation.activitySummary.retry()
    let recovered = try await read(conversation)
    try await waitForSleep(clock, .seconds(5))
    XCTAssertEqual(conversation.activitySummary.text(in: recovered), "Checking the sources")
    conversation.activitySummary.setRotates(false)
    try await waitForNoSleep(clock, duration: .seconds(5))
    XCTAssertEqual(conversation.activitySummary.text(in: recovered), "Checking the sources")
    conversation.activitySummary.setRotates(true)
    try await waitForSleep(clock, .seconds(5))
    clock.advance(.seconds(5))
    try await waitForBusinessResult {
      conversation.activitySummary.text(in: recovered) == "Comparing the results"
    }
  }

  func testHiddenBackgroundCompletedAndClosedDetailsCancelDemand() async throws {
    let scenario = ActivityScenario()
    let clock = ActivityClock()
    let visible = ActivityVisibility()
    let conversation = scenario.conversation(clock: clock, visible: { visible.active })
    defer { conversation.close() }
    await conversation.refresh()
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    let initial = try await read(conversation)
    XCTAssertNotNil(conversation.activitySummary.text(in: initial))
    let replacementOwner = UUID()
    conversation.setDetailVisible(true, owner: replacementOwner)
    conversation.setDetailVisible(false, owner: ActivityScenario.detailOwner)
    XCTAssertNotNil(conversation.activitySummary.text(in: initial))
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    visible.active = false
    conversation.reconcileActivitySummary()
    assertHidden(conversation, batch: initial)
    try await waitForNoSleep(clock)
    visible.active = true
    conversation.reconcileActivitySummary()
    let foreground = try await read(conversation)
    XCTAssertNotNil(conversation.activitySummary.text(in: foreground))
    conversation.setDetailVisible(false, owner: ActivityScenario.detailOwner)
    assertHidden(conversation, batch: foreground)
    try await waitForNoSleep(clock)
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    let reopened = try await read(conversation)
    XCTAssertNotNil(conversation.activitySummary.text(in: reopened))
    scenario.append(type: "run.completed")
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .completed)
    assertHidden(conversation, batch: reopened)
    try await waitForNoSleep(clock)
    conversation.close()
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    assertHidden(conversation, batch: reopened)
    XCTAssertThrowsError(
      try conversation.activitySummary.stateStore.get(conversation.activitySummary.value))
  }

  func testRunReplacementCancelsOldHTTPAndStoppedStateKeepsItsLabel() async throws {
    let scenario = ActivityScenario()
    let clock = ActivityClock()
    let started = expectation(description: "Old run HTTP started")
    let cancelled = expectation(description: "Old HTTP cancelled")
    let release = ActivityClock()
    let conversation = scenario.conversation(clock: clock)
    defer { conversation.close() }
    await conversation.refresh()
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    let stale = try await read(conversation)
    scenario.state.hold.withLock {
      $0 = {
        started.fulfill()
        do { try await release.sleep(.seconds(1)) } catch { cancelled.fulfill() }
      }
    }
    conversation.activitySummary.retry()
    let old = try conversation.activitySummary.stateStore.get(conversation.activitySummary.value)
    await fulfillment(of: [started], timeout: 3)
    try await waitForSleep(release, .seconds(1))
    scenario.state.hold.withLock { $0 = nil }
    let newer = "10000000-0000-4000-8000-000000000004"
    scenario.append(type: "input.prompt", run: newer)
    await conversation.refresh()
    await fulfillment(of: [cancelled], timeout: 3)
    let replacement = try await read(conversation)
    XCTAssertEqual(replacement?.runId, newer)
    XCTAssertEqual(conversation.activitySummary.text(in: replacement), "Checking the sources")
    guard case .failure = await old.result else {
      return XCTFail("A replaced Run must cancel the original resource Task")
    }
    // Even a retained old phase cannot be displayed for the new demand.
    assertHidden(conversation, batch: stale)
    XCTAssertEqual(conversation.history?.activityRunID, newer)
    release.advance(.seconds(1))
    scenario.append(type: "control.interrupt", run: newer)
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .stopping)
    assertHidden(conversation, batch: replacement)
    try await waitForNoSleep(clock)
  }

  func testHidingAndClosingCancelTheOriginalInFlightHTTP() async throws {
    for closesScope in [false, true] {
      let scenario = ActivityScenario()
      let clock = ActivityClock()
      let release = ActivityClock()
      let started = expectation(description: "Visible Run HTTP started")
      let cancelled = expectation(description: "Visibility retirement cancelled HTTP")
      scenario.state.hold.withLock {
        $0 = {
          started.fulfill()
          do { try await release.sleep(.seconds(1)) } catch { cancelled.fulfill() }
        }
      }
      let conversation = scenario.conversation(clock: clock)
      defer { conversation.close() }
      await conversation.refresh()
      conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
      let original = try conversation.activitySummary.stateStore.get(
        conversation.activitySummary.value)
      await fulfillment(of: [started], timeout: 3)
      try await waitForSleep(release, .seconds(1))
      if closesScope {
        conversation.close()
      } else {
        conversation.setDetailVisible(false, owner: ActivityScenario.detailOwner)
      }
      await fulfillment(of: [cancelled], timeout: 3)
      guard case .failure = await original.result else {
        return XCTFail("Retirement must cancel the original HTTP Task")
      }
      try await waitForNoSleep(clock)
      if closesScope {
        conversation.activitySummary.demand(ActivityScenario.run)
        XCTAssertThrowsError(
          try conversation.activitySummary.stateStore.get(conversation.activitySummary.value))
      } else {
        let hidden = try await read(conversation)
        XCTAssertNil(hidden)
      }
    }
  }

  func testUpgradeFailureReachesTheConversationWithoutChangingTranscript() async throws {
    let scenario = ActivityScenario()
    let clock = ActivityClock()
    let conversation = scenario.conversation(clock: clock)
    defer { conversation.close() }
    await conversation.refresh()
    let messages = conversation.messages
    scenario.state.response.withLock {
      $0 = ChatHTTPResponse(status: 426, body: #"{"error":{"message":"Upgrade required"}}"#)
    }
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    let original = try conversation.activitySummary.stateStore.get(
      conversation.activitySummary.value)
    guard case .failure(let error) = await original.result else {
      return XCTFail("Upgrade failure must remain in the original resource")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 426)
    try await waitForBusinessResult { conversation.needsUpgrade }
    XCTAssertEqual(conversation.messages, messages)
    try await waitForNoSleep(clock)
  }

  func testWorkspaceSelectionForegroundAndCloseOwnTheDemand() async throws {
    let scenario = ActivityScenario()
    let workspace = scenario.workspace()
    defer { workspace.close() }
    await workspace.refreshNavigation()
    await workspace.refresh()
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 0)
    workspace.setForeground(true)
    workspace.selectedThreadID = ActivityScenario.thread
    let conversation = try XCTUnwrap(workspace.selectedConversation)
    await conversation.refresh()
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    let initial = try await read(conversation)
    XCTAssertNotNil(conversation.activitySummary.text(in: initial))
    workspace.setForeground(false)
    assertHidden(conversation, batch: initial)
    workspace.setForeground(true)
    let foreground = try await read(conversation)
    XCTAssertNotNil(conversation.activitySummary.text(in: foreground))
    workspace.selectedThreadID = nil
    assertHidden(conversation, batch: foreground)
    workspace.selectedThreadID = ActivityScenario.thread
    let reselected = try await read(conversation)
    XCTAssertNotNil(conversation.activitySummary.text(in: reselected))
    workspace.close()
    assertHidden(conversation, batch: reselected)
  }

}

@MainActor private final class ActivityVisibility { var active = true }

@MainActor @Observable
private final class ActivityClock {
  private var sleepers: [UUID: (Duration, CheckedContinuation<Void, Error>)] = [:]

  func sleep(_ duration: Duration) async throws {
    let id = UUID()
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      try await withCheckedThrowingContinuation { sleepers[id] = (duration, $0) }
    } onCancel: {
      Task { @MainActor in self.cancel(id) }
    }
  }

  private func cancel(_ id: UUID) {
    sleepers.removeValue(forKey: id)?.1.resume(throwing: CancellationError())
  }

  func advance(_ duration: Duration) {
    let ready = sleepers.filter { $0.value.0 == duration }
    for (id, value) in ready {
      sleepers.removeValue(forKey: id)
      value.1.resume()
    }
  }

  func hasSleeper(_ duration: Duration? = nil) -> Bool {
    sleepers.values.contains { duration == nil || $0.0 == duration }
  }
}

private final class ActivityScenario: Sendable {
  static let detailOwner = UUID()
  static let thread = "10000000-0000-4000-8000-000000000001"
  static let run = "f0000000-0000-4000-8000-000000000003"
  let state = ActivityHTTPState()
  let requests: AsyncStream<Int>
  private let requestEvents: AsyncStream<Int>.Continuation
  private let fixture: ChatHTTPFixture

  init() {
    (requests, requestEvents) = AsyncStream<Int>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let state = state
    let requestEvents = requestEvents
    fixture = ChatHTTPFixture { request in
      let path = "/api/chat-threads/\(Self.thread)"
      switch request.url?.path {
      case "/api/agents": return ChatHTTPResponse(body: "[]")

      case "/api/feature-switches":
        return ChatHTTPResponse(body: "{\"effectiveSwitches\":{}}")
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[{"id":"\(Self.thread)","agentId":"\(Self.thread)","title":"Activity summary","sortAt":"2026-10-20T00:00:00Z","createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z","pinnedAt":null,"renamedAt":null,"selectedModel":null,"serviceTier":null,"computerUseHostId":null,"cloudBrowserEnabled":false}],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      case path + "/mark-read":
        return ChatHTTPResponse(body: #"{"lastReadAt":"2026-10-20T00:00:00Z"}"#)
      case path + "/activity-summary":
        let count = state.requests.withLock {
          $0 += 1
          return $0
        }
        defer { requestEvents.yield(count) }
        if let wait = state.hold.withLock({ $0 }) { await wait() }
        if let override = state.response.withLock({ $0 }) { return override }
        let body =
          try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: String]
        return ChatHTTPResponse(
          body: """
            {"runId":"\(body?["runId"] ?? "")","status":"available","messages":[{"id":"sources","text":"Checking the sources"},{"id":"results","text":"Comparing the results"}]}
            """)
      case path + "/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body:
            "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
      case path + "/event-rows":
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "sinceSeqId"
          }?.value.flatMap(Int.init) ?? 0
        return state.rows.withLock { values in
          ChatHTTPResponse(
            body: """
              {"rows":[\(values.dropFirst(after).joined(separator: ","))],"cursor":{"lastEventId":"\(Self.id(values.count))","lastSeqId":\(values.count)},"hasMore":false}
              """)
        }
      case path: return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    append(type: "input.prompt")
  }

  deinit { requestEvents.finish() }

  func append(type: String, run: String = ActivityScenario.run) {
    state.rows.withLock { values in
      let index = values.count + 1
      let payload =
        type == "input.prompt"
        ? "{\"userMessage\":{\"version\":1,\"parts\":[{\"type\":\"text\",\"text\":\"Check the source and summarize the results\"}]}}"
        : "null"
      values.append(
        """
        {"id":"\(Self.id(index))","chatThreadId":"\(Self.thread)","runId":"\(run)","revokesEventId":null,"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":\(index),"createdAt":"2026-10-20T00:00:00.000Z","eventType":"\(type)","payload":\(payload)}
        """)
    }
  }

  @MainActor func workspace() -> WorkspaceStore {
    WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
  }

  @MainActor func conversation(
    clock: ActivityClock, visible: @escaping @MainActor () -> Bool = { true }
  ) -> ConversationStore {
    let sync = ChatSync(client: fixture.client)
    let conversation = ConversationStore(
      thread: ChatThread(
        id: Self.thread, agentID: Self.thread, title: "Activity summary", createdAt: .now,
        updatedAt: .now, sortAt: .now),
      sync: sync, commands: ChatCommands(client: fixture.client, sync: sync),
      webURL: fixture.baseURL,
      messageMarkdown: MessageMarkdownCache(baseURL: fixture.baseURL), isVisible: visible,
      didMarkRead: { _ in }, didSend: {}, didFail: { _ in }, didSettle: {},
      activitySleep: { try await clock.sleep($0) })
    return conversation
  }

  private static func id(_ index: Int) -> String {
    String(format: "10000000-0000-4000-8000-%012d", index + 10)
  }
}

private final class ActivityHTTPState: Sendable {
  let requests = Mutex(0)
  let response = Mutex<ChatHTTPResponse?>(nil)
  let hold = Mutex<(@Sendable () async -> Void)?>(nil)
  let rows = Mutex<[String]>([])
}
