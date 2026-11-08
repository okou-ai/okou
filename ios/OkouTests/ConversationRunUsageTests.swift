import CCState
import CCStateSwiftUI
import ChatData
import ChatDataTestSupport
import ChatDomain
import Observation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationRunUsageTests: XCTestCase {

  nonisolated private static let runID = "10000000-0000-4000-8000-000000000001"
  nonisolated private static func receipt(_ credits: Int) -> String {
    "{\"version\":1,\"totalCredits\":\(credits),\"settledAt\":\"2026-10-20T00:00:00Z\",\"breakdown\":[]}"
  }
  nonisolated private static func response(_ credits: Int, runIDs: [String] = [runID])
    -> ChatHTTPResponse
  {
    ChatHTTPResponse(
      body: "{\"runs\":["
        + runIDs.map { "{\"runId\":\"\($0)\",\"usage\":\(receipt(credits))}" }.joined(
          separator: ",") + "]}")
  }
  private func row(
    _ index: Int, type: String = "output.message", text: String = "",
    runID: String = ConversationRunUsageTests.runID
  ) throws -> String {
    let payload: [String: Any]
    if type == "input.prompt" {
      payload = ["userMessage": ["version": 1, "parts": [["type": "text", "text": text]]]]
    } else if type == "usage.recorded" {
      payload = ["usage": try JSONSerialization.jsonObject(with: Data(Self.receipt(999).utf8))]
    } else {
      payload = ["content": text]
    }
    let encoded = String(
      decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
    return """
      {"id":"\(ConversationHistoryFixture.id(index))","chatThreadId":"\(ConversationHistoryFixture.threadID)","seqId":\(index),"eventType":"\(type)","runId":"\(runID)","createdAt":"2026-10-20T00:00:00Z","payload":\(encoded)}
      """
  }
  func testHiddenResidentConversationOnlyReadsUsageWhenSelected() async throws {
    let reads = Mutex(0)
    let total = Mutex(5)
    let fixture = ConversationHistoryFixture(
      rows: [
        try row(1, type: "input.prompt", text: "Question"), try row(2, text: "Answer"),
        try row(3, type: "run.completed"), try row(4, type: "usage.recorded"),
      ],
      usage: { _ in
        reads.withLock { $0 += 1 }
        return Self.response(total.withLock { $0 })
      })
    var selected = false
    let conversation = fixture.conversation(isVisible: { selected })
    let usage = RunUsageProbe(conversation.runUsage, owner: self)
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertTrue(usage.states.isEmpty)
    XCTAssertEqual(reads.withLock { $0 }, 0)
    selected = true
    conversation.reconcileVisibility()
    try await waitForBusinessResult {
      usage.states[Self.runID] == .available(Self.usage(5))
    }
    selected = false
    conversation.reconcileVisibility()
    fixture.append(try row(5, type: "usage.recorded"))
    total.withLock { $0 = 9 }
    await conversation.refresh()
    XCTAssertEqual(reads.withLock { $0 }, 1)
    selected = true
    conversation.reconcileVisibility()
    try await waitForBusinessResult {
      usage.states[Self.runID] == .available(Self.usage(9))
    }
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testHidingUsageCancelsOldReadBeforeSameRunIsShownAgain() async throws {
    let gate = UsageResponseGate(owner: self)
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { _ in
      let count = reads.withLock {
        $0 += 1
        return $0
      }
      if count == 1 { await gate.wait() }
      return Self.response(count == 1 ? 999 : 3)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: fixture.client), threadID: "thread", didFail: { _ in })
    let usage = RunUsageProbe(store, owner: self)
    defer { store.close() }
    store.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    try await gate.started()
    store.update(runIDs: [], events: [Self.runID: "event"])
    store.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    try await waitForBusinessResult { usage.states[Self.runID] == .available(Self.usage(3)) }
    gate.release()
    XCTAssertEqual(usage.states[Self.runID], .available(Self.usage(3)))
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testSteerAndMultipleOutputsShowOneTotalAfterFinalReplyOutsideFoldedWork() async throws {
    let fixture = ConversationHistoryFixture(
      rows: [
        try row(1, type: "input.prompt", text: "Start"),
        try row(2, text: "Earlier work"), try row(3, text: "First reply"),
        try row(4, type: "input.prompt", text: "Supplement"),
        try row(5, text: "More work"), try row(6, text: "Final reply"),
        try row(7, type: "run.cancelled"), try row(8, type: "usage.recorded"),
      ], usage: { _ in Self.response(8) })
    let conversation = fixture.conversation()
    let usage = RunUsageProbe(conversation.runUsage, owner: self)
    defer { conversation.close() }
    conversation.draft = "Keep this draft"
    await conversation.refresh()
    try await waitForBusinessResult {
      usage.states[Self.runID] == .available(Self.usage(8))
    }
    XCTAssertEqual(usageRuns(conversation), [Self.runID])
    let ids = conversation.visibleItems.map(\.id)
    XCTAssertEqual(ids.suffix(2), [ConversationHistoryFixture.id(7), "usage:\(Self.runID)"])
    XCTAssertFalse(ids.contains(ConversationHistoryFixture.id(2)))
    XCTAssertFalse(ids.contains(ConversationHistoryFixture.id(5)))
    for section in conversation.history?.workSections ?? [] {
      conversation.toggleWorkHistory(section.id)
    }
    XCTAssertEqual(usageRuns(conversation), [Self.runID])
    XCTAssertEqual(conversation.draft, "Keep this draft")
  }

  func testOnlyVisibleRunsLoadAndWindowChangesReuseSettledReads() async throws {
    let reads = Mutex<[String]>([])
    var rows: [String] = []
    for index in 0..<16 {
      let runID = "run-\(index)"
      rows += [
        try row(index * 4 + 1, type: "input.prompt", text: "Question", runID: runID),
        try row(index * 4 + 2, text: "Answer", runID: runID),
        try row(index * 4 + 3, type: "run.completed", runID: runID),
        try row(index * 4 + 4, type: "usage.recorded", runID: runID),
      ]
    }
    let fixture = ConversationHistoryFixture(
      rows: rows,
      usage: { request in
        let body = try JSONDecoder().decode(UsageBody.self, from: chatRequestBody(request))
        reads.withLock { $0 += body.runIds }
        return Self.response(5, runIDs: body.runIds)
      })
    let conversation = fixture.conversation()
    let usage = RunUsageProbe(conversation.runUsage, owner: self)
    defer { conversation.close() }
    await conversation.refresh()
    let visible = Set(usageRuns(conversation))
    XCTAssertLessThan(visible.count, 16)
    try await waitForBusinessResult {
      visible.allSatisfy { usage.states[$0] == .available(Self.usage(5)) }
    }
    XCTAssertEqual(Set(reads.withLock { $0 }), visible)
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    try await waitForBusinessResult {
      usage.states.count == 16
        && usage.states.values.allSatisfy { $0 == .available(Self.usage(5)) }
    }
    XCTAssertEqual(reads.withLock { $0.count }, 16)
    conversation.resetRenderWindowToLatest()
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    await conversation.refresh()
    XCTAssertEqual(reads.withLock { $0.count }, 16)
  }

  func testLateSettlementMissingZeroFailureAndReplacementUseAuthoritativeRead() async throws {
    let response = Mutex(ChatHTTPResponse(body: "{\"runs\":[]}"))
    let reads = Mutex(0)
    let fixture = ConversationHistoryFixture(
      rows: [try row(1, type: "input.prompt", text: "Question"), try row(2, text: "Answer")],
      usage: { _ in
        reads.withLock { $0 += 1 }
        return response.withLock { $0 }
      })
    let conversation = fixture.conversation()
    let usage = RunUsageProbe(conversation.runUsage, owner: self)
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertTrue(usageRuns(conversation).isEmpty)
    XCTAssertEqual(reads.withLock { $0 }, 0)
    fixture.append(try row(3, type: "run.failed"))
    fixture.append(try row(4, type: "usage.recorded"))
    await conversation.refresh()
    try await waitForBusinessResult { usage.states[Self.runID] == .unavailable }
    response.withLock { $0 = Self.response(0) }
    fixture.append(try row(5, type: "usage.recorded"))
    await conversation.refresh()
    try await waitForBusinessResult {
      usage.states[Self.runID] == .available(Self.usage(0))
    }
    response.withLock {
      $0 = ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Offline\"}}")
    }
    fixture.append(try row(6, type: "usage.recorded"))
    await conversation.refresh()
    try await waitForBusinessResult {
      if case .failed = usage.states[Self.runID] { return true }
      return false
    }
    response.withLock { $0 = Self.response(9) }
    conversation.runUsage.retry(Self.runID)
    try await waitForBusinessResult {
      usage.states[Self.runID] == .available(Self.usage(9))
    }
    XCTAssertEqual(reads.withLock { $0 }, 4)
    XCTAssertEqual(usageRuns(conversation).count, 1)
  }

  func testClosingScopeRejectsLateResponseAndOtherScopeKeepsItsOwnTotal() async throws {
    let gate = UsageResponseGate(owner: self)
    let old = ChatHTTPFixture { _ in
      await gate.wait()
      return Self.response(999)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: old.client), threadID: "old-thread", didFail: { _ in })
    let usage = RunUsageProbe(store, owner: self)
    defer { store.close() }
    store.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    try await gate.started()
    store.close()
    let other = ChatHTTPFixture { _ in Self.response(3) }
    let next = ConversationRunUsageStore(
      sync: ChatSync(client: other.client), threadID: "new-thread", didFail: { _ in })
    let nextUsage = RunUsageProbe(next, owner: self)
    defer { next.close() }
    next.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    gate.release()
    try await waitForBusinessResult { nextUsage.states[Self.runID] == .available(Self.usage(3)) }
    XCTAssertTrue(usage.states.isEmpty)
  }

  func testNewUsageHintDuringReadDiscardsOldTotalAndCoalescesRetry() async throws {
    let first = UsageResponseGate(owner: self)
    let second = UsageResponseGate(owner: self)
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { _ in
      let count = reads.withLock {
        $0 += 1
        return $0
      }
      if count == 1 { await first.wait() } else { await second.wait() }
      return Self.response(count == 1 ? 999 : 12)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: fixture.client), threadID: "thread", didFail: { _ in })
    let usage = RunUsageProbe(store, owner: self)
    defer { store.close() }
    store.update(runIDs: [Self.runID], events: [Self.runID: "first"])
    try await first.started()
    store.update(runIDs: [Self.runID], events: [Self.runID: "replacement"])
    store.retry(Self.runID)
    first.release()
    try await second.started()
    XCTAssertEqual(usage.states[Self.runID], .loading)
    second.release()
    try await waitForBusinessResult { usage.states[Self.runID] == .available(Self.usage(12)) }
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testLargeExpandedWindowBatchesAtContractLimitAndDeduplicatesRuns() async throws {
    let sizes = Mutex<[Int]>([])
    let fixture = ChatHTTPFixture { request in
      let body = try JSONDecoder().decode(UsageBody.self, from: chatRequestBody(request))
      sizes.withLock { $0.append(body.runIds.count) }
      return Self.response(5, runIDs: body.runIds)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: fixture.client), threadID: "thread", didFail: { _ in })
    let usage = RunUsageProbe(store, owner: self)
    defer { store.close() }
    let ids = (0..<205).map { "run-\($0)" }
    store.update(
      runIDs: ids + ids, events: Dictionary(uniqueKeysWithValues: ids.map { ($0, "event") }))
    try await waitForBusinessResult {
      usage.states.count == 205
        && usage.states.values.allSatisfy { $0 == .available(Self.usage(5)) }
    }
    XCTAssertEqual(sizes.withLock { $0 }, [100, 100, 5])
  }

  func testIndependentUsageConsumersShareAReadAndDetachingOneKeepsTheOtherAlive() async throws {
    let gate = UsageResponseGate(owner: self)
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { _ in
      reads.withLock { $0 += 1 }
      await gate.wait()
      return Self.response(7)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: fixture.client), threadID: "shared-thread", didFail: { _ in })
    defer { store.close() }
    let label = RunUsageProbe(store, owner: self)
    let details = RunUsageProbe(store, owner: self)
    store.update(runIDs: [Self.runID], events: [Self.runID: "settled"])
    try await gate.started()
    label.detach()
    gate.release()
    try await waitForBusinessResult { details.states[Self.runID] == .available(Self.usage(7)) }
    XCTAssertEqual(reads.withLock { $0 }, 1)
  }

  func testLeavingAnExpandedWindowEvictsOldReadsAndReusesTheRetainedRun() async throws {
    let reads = Mutex(0)
    let ids = (0..<205).map { String(format: "run-%03d", $0) }
    let fixture = ChatHTTPFixture { request in
      let count = reads.withLock {
        $0 += 1
        return $0
      }
      let body = try JSONDecoder().decode(UsageBody.self, from: chatRequestBody(request))
      return Self.response(count > 3 ? 9 : 5, runIDs: body.runIds)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: fixture.client), threadID: "bounded-thread", didFail: { _ in })
    let usage = RunUsageProbe(store, owner: self)
    defer { store.close() }
    let events = Dictionary(uniqueKeysWithValues: ids.map { ($0, "settled") })
    store.update(runIDs: ids, events: events)
    try await waitForBusinessResult {
      usage.states.count == 205
        && usage.states.values.allSatisfy { $0 == .available(Self.usage(5)) }
    }
    let last = try XCTUnwrap(ids.last)
    store.update(runIDs: [last], events: events)
    XCTAssertEqual(usage.states[last], .available(Self.usage(5)))
    let oldest = try XCTUnwrap(ids.first)
    store.update(runIDs: [oldest, last], events: events)
    try await waitForBusinessResult { usage.states[oldest] == .available(Self.usage(9)) }
    XCTAssertEqual(usage.states[last], .available(Self.usage(5)))
    XCTAssertEqual(reads.withLock { $0 }, 4)
  }

  private func usageRuns(_ conversation: ConversationStore) -> [String] {
    conversation.visibleItems.compactMap {
      if case .usage(let runID) = $0 { return runID }
      return nil
    }
  }
  nonisolated private static func usage(_ credits: Int) -> ChatRunUsage {
    try! JSONDecoder().decode(ChatRunUsage.self, from: Data(receipt(credits).utf8))
  }
  private struct UsageBody: Decodable { let runIds: [String] }
}

private final class UsageResponseGate: Sendable {
  private let entered: XCTestExpectation
  private let responses: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  @MainActor
  init(owner: XCTestCase) {
    entered = owner.expectation(description: "The usage request reached its HTTP gate")
    entered.assertForOverFulfill = true
    let pair = AsyncStream<Void>.makeStream()
    responses = pair.stream
    continuation = pair.continuation
    owner.addTeardownBlock { pair.continuation.finish() }
  }

  func wait() async {
    entered.fulfill()
    for await _ in responses { break }
  }

  @MainActor
  func started(file: StaticString = #filePath, line: UInt = #line) async throws {
    let result = await XCTWaiter.fulfillment(of: [entered], timeout: 3)
    _ = try XCTUnwrap(
      result == .completed ? true : nil, "The usage request did not reach HTTP",
      file: file, line: line)
  }

  func release() { continuation.finish() }
}

/// Observe the same public Task signals as the native label and details, without mounting UI.
@MainActor @Observable
private final class RunUsageProbe {
  private let usage: ConversationRunUsageStore
  private(set) var states: [String: ConversationRunUsageState] = [:]
  @ObservationIgnored private var subscriptions: [String: Subscription] = [:]
  @ObservationIgnored private var watched: [String: ConversationRunUsageResource] = [:]
  @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
  @ObservationIgnored private var revisions: [String: UUID] = [:]
  @ObservationIgnored private var stopped = false

  init(_ usage: ConversationRunUsageStore, owner: XCTestCase) {
    self.usage = usage
    owner.addTeardownBlock { @MainActor [self] in await close() }
    trackResources()
  }

  func detach() {
    stopped = true
    for subscription in subscriptions.values {
      do { try subscription.cancel() } catch { XCTFail("Cannot detach usage observer: \(error)") }
    }
    for task in tasks.values { task.cancel() }
    subscriptions = [:]
  }

  func close() async {
    detach()
    for task in tasks.values { await task.value }
    watched = [:]
    tasks = [:]
  }

  private func trackResources() {
    guard !stopped else { return }
    let resources = withObservationTracking {
      usage.resources
    } onChange: { [weak self] in
      Task { @MainActor in self?.trackResources() }
    }
    for id in subscriptions.keys where resources[id] == nil || resources[id] !== watched[id] {
      do { try subscriptions.removeValue(forKey: id)?.cancel() } catch {
        XCTFail("Cannot detach usage observer: \(error)")
      }
      tasks.removeValue(forKey: id)?.cancel()
      revisions[id] = nil
      watched[id] = nil
      states[id] = nil
    }
    for (id, resource) in resources where subscriptions[id] == nil {
      do {
        watched[id] = resource
        subscriptions[id] = try usage.stateStore.watch(resource.value) { [weak self] in
          self?.read(resource)
        }
        read(resource)
      } catch { XCTFail("Cannot observe usage: \(error)") }
    }
  }

  private func read(_ resource: ConversationRunUsageResource) {
    let id = resource.runID
    tasks[id]?.cancel()
    let revision = UUID()
    revisions[id] = revision
    states[id] = .loading
    do {
      let pending = try usage.stateStore.get(resource.value)
      tasks[id] = Task { [weak self] in
        let result = await pending.result
        guard let self, !stopped, !Task.isCancelled, revisions[id] == revision else { return }
        switch result {
        case .success(let value): states[id] = ConversationRunUsageState(.hasData(value))
        case .failure(let error): states[id] = ConversationRunUsageState(.hasError(error))
        }
      }
    } catch {
      states[id] = .failed(ChatRequestFailure.message(for: error))
    }
  }
}
