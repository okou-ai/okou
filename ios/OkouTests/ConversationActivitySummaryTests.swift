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
  func testRefreshRotationAndFailureDegradationDoNotChangeTranscript() async throws {
    let scenario = ActivityScenario()
    let clock = ActivityClock()
    let conversation = scenario.conversation(clock: clock)
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertNil(conversation.activitySummary.text)
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 0)
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    try await waitForBusinessResult { conversation.activitySummary.text == "Checking the sources" }
    let messages = conversation.messages
    let items = conversation.visibleItems
    let history = conversation.history
    try await waitForSleep(clock, .seconds(5))
    clock.advance(.seconds(5))
    try await waitForBusinessResult { conversation.activitySummary.text == "Comparing the results" }
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 1)
    try await waitForSleep(clock, .seconds(15))
    clock.advance(.seconds(15))
    try await waitForRequest(scenario, after: 1)
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 2)
    XCTAssertEqual(conversation.activitySummary.text, "Comparing the results")
    XCTAssertEqual(conversation.messages, messages)
    XCTAssertEqual(conversation.visibleItems, items)
    XCTAssertEqual(conversation.history, history)

    for response in [
      ChatHTTPResponse(
        body: "{\"runId\":\"\(ActivityScenario.run)\",\"status\":\"available\",\"messages\":[]}"),
      ChatHTTPResponse(
        body: "{\"runId\":\"\(ActivityScenario.run)\",\"status\":\"ineligible\",\"messages\":[]}"),
      ChatHTTPResponse(
        body: "{\"runId\":\"\(ActivityScenario.run)\",\"status\":\"unavailable\",\"messages\":[]}"),
      ChatHTTPResponse(status: 403, body: "{\"error\":{\"message\":\"Denied\"}}"),
      ChatHTTPResponse(status: 500, body: "{\"error\":{\"message\":\"Unavailable\"}}"),
    ] {
      scenario.state.response.withLock { $0 = response }
      let previous = scenario.state.requests.withLock { $0 }
      try await waitForSleep(clock, .seconds(15))
      clock.advance(.seconds(15))
      try await waitForRequest(scenario, after: previous)
      try await waitForBusinessResult { conversation.activitySummary.text == nil }
      XCTAssertNil(conversation.error)
      XCTAssertEqual(conversation.history, history)

      // Restore visible content so the next empty/error response must be consumed.
      scenario.state.response.withLock { $0 = nil }
      try await waitForSleep(clock, .seconds(15))
      clock.advance(.seconds(15))
      try await waitForBusinessResult {
        conversation.activitySummary.text == "Checking the sources"
      }
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
    try await waitForBusinessResult { conversation.activitySummary.text != nil }
    let replacementOwner = UUID()
    conversation.setDetailVisible(true, owner: replacementOwner)
    conversation.setDetailVisible(false, owner: ActivityScenario.detailOwner)
    XCTAssertNotNil(conversation.activitySummary.text)
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    visible.active = false
    conversation.reconcileActivitySummary()
    XCTAssertNil(conversation.activitySummary.text)
    try await waitForNoSleep(clock)
    visible.active = true
    conversation.reconcileActivitySummary()
    try await waitForBusinessResult { conversation.activitySummary.text != nil }
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 2)
    conversation.setDetailVisible(false, owner: ActivityScenario.detailOwner)
    XCTAssertNil(conversation.activitySummary.text)
    try await waitForNoSleep(clock)
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    try await waitForBusinessResult { conversation.activitySummary.text != nil }
    XCTAssertEqual(scenario.state.requests.withLock { $0 }, 3)
    scenario.append(type: "run.completed")
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .completed)
    XCTAssertNil(conversation.activitySummary.text)
    try await waitForNoSleep(clock)
    conversation.close()
    conversation.setDetailVisible(true, owner: ActivityScenario.detailOwner)
    XCTAssertNil(conversation.activitySummary.text)
    try await waitForNoSleep(clock)
  }

  func testRunReplacementCancelsOldHTTPAndStoppedStateKeepsItsLabel() async throws {
    let scenario = ActivityScenario()
    let clock = ActivityClock()
    let started = expectation(description: "Old run HTTP started")
    let cancelled = expectation(description: "Old HTTP cancelled")
    let release = ActivityClock()
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
    await fulfillment(of: [started], timeout: 3)
    try await waitForSleep(release, .seconds(1))
    scenario.state.hold.withLock { $0 = nil }
    let newer = "10000000-0000-4000-8000-000000000004"
    scenario.append(type: "input.prompt", run: newer)
    await conversation.refresh()
    await fulfillment(of: [cancelled], timeout: 3)
    try await waitForBusinessResult { conversation.activitySummary.text == "Checking the sources" }
    XCTAssertEqual(conversation.history?.activityRunID, newer)
    release.advance(.seconds(1))
    scenario.append(type: "control.interrupt", run: newer)
    await conversation.refresh()
    XCTAssertEqual(conversation.history?.executionState, .stopping)
    XCTAssertNil(conversation.activitySummary.text)
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
    try await waitForBusinessResult { conversation.activitySummary.text != nil }
    workspace.setForeground(false)
    XCTAssertNil(conversation.activitySummary.text)
    workspace.setForeground(true)
    try await waitForBusinessResult { conversation.activitySummary.text != nil }
    workspace.selectedThreadID = nil
    XCTAssertNil(conversation.activitySummary.text)
    workspace.selectedThreadID = ActivityScenario.thread
    try await waitForBusinessResult { conversation.activitySummary.text != nil }
    workspace.close()
    XCTAssertNil(conversation.activitySummary.text)
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
      case "/api/user-preferences": return ChatHTTPResponse(body: "{\"pinnedAgentIds\":[]}")
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
        requestEvents.yield(count)
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
