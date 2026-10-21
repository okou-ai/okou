import ChatData
import ChatDataTestSupport
import ChatDomain
import SwiftUI
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ConversationRunUsageTests: XCTestCase {
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
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertTrue(conversation.runUsage.states.isEmpty)
    XCTAssertEqual(reads.withLock { $0 }, 0)
    selected = true
    conversation.reconcileVisibility()
    try await eventually { conversation.runUsage.states[Self.runID] == .available(Self.usage(5)) }
    selected = false
    conversation.reconcileVisibility()
    fixture.append(try row(5, type: "usage.recorded"))
    total.withLock { $0 = 9 }
    await conversation.refresh()
    XCTAssertEqual(reads.withLock { $0 }, 1)
    selected = true
    conversation.reconcileVisibility()
    try await eventually { conversation.runUsage.states[Self.runID] == .available(Self.usage(9)) }
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testHidingUsageCancelsOldReadBeforeSameRunIsShownAgain() async throws {
    let gate = UsageResponseGate()
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
    defer { store.close() }
    store.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    await gate.started()
    store.update(runIDs: [], events: [Self.runID: "event"])
    store.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    try await eventually { store.states[Self.runID] == .available(Self.usage(3)) }
    await gate.release()
    XCTAssertEqual(store.states[Self.runID], .available(Self.usage(3)))
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
    defer { conversation.close() }
    conversation.draft = "Keep this draft"
    await conversation.refresh()
    try await eventually { conversation.runUsage.states[Self.runID] == .available(Self.usage(8)) }
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
    defer { conversation.close() }
    await conversation.refresh()
    let visible = Set(usageRuns(conversation))
    XCTAssertLessThan(visible.count, 16)
    try await eventually { visible.allSatisfy { conversation.runUsage.states[$0] != .loading } }
    XCTAssertEqual(Set(reads.withLock { $0 }), visible)
    while conversation.hasEarlierMessages { await conversation.loadEarlierMessages() }
    try await eventually {
      reads.withLock { $0.count } == 16
        && conversation.runUsage.states.values.allSatisfy { $0 == .available(Self.usage(5)) }
    }
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
    defer { conversation.close() }
    await conversation.refresh()
    XCTAssertTrue(usageRuns(conversation).isEmpty)
    XCTAssertEqual(reads.withLock { $0 }, 0)
    fixture.append(try row(3, type: "run.failed"))
    fixture.append(try row(4, type: "usage.recorded"))
    await conversation.refresh()
    try await eventually { conversation.runUsage.states[Self.runID] == .unavailable }
    response.withLock { $0 = Self.response(0) }
    fixture.append(try row(5, type: "usage.recorded"))
    await conversation.refresh()
    try await eventually { conversation.runUsage.states[Self.runID] == .available(Self.usage(0)) }
    response.withLock {
      $0 = ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Offline\"}}")
    }
    fixture.append(try row(6, type: "usage.recorded"))
    await conversation.refresh()
    try await eventually {
      if case .failed = conversation.runUsage.states[Self.runID] { return true }
      return false
    }
    response.withLock { $0 = Self.response(9) }
    conversation.runUsage.retry(Self.runID)
    try await eventually { conversation.runUsage.states[Self.runID] == .available(Self.usage(9)) }
    XCTAssertEqual(reads.withLock { $0 }, 4)
    XCTAssertEqual(usageRuns(conversation).count, 1)
  }

  func testClosingScopeRejectsLateResponseAndOtherScopeKeepsItsOwnTotal() async throws {
    let gate = UsageResponseGate()
    let old = ChatHTTPFixture { _ in
      await gate.wait()
      return Self.response(999)
    }
    let store = ConversationRunUsageStore(
      sync: ChatSync(client: old.client), threadID: "old-thread", didFail: { _ in })
    store.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    await gate.started()
    store.close()
    let other = ChatHTTPFixture { _ in Self.response(3) }
    let next = ConversationRunUsageStore(
      sync: ChatSync(client: other.client), threadID: "new-thread", didFail: { _ in })
    defer { next.close() }
    next.update(runIDs: [Self.runID], events: [Self.runID: "event"])
    await gate.release()
    try await eventually { next.states[Self.runID] == .available(Self.usage(3)) }
    XCTAssertTrue(store.states.isEmpty)
  }

  func testNewUsageHintDuringReadDiscardsOldTotalAndCoalescesRetry() async throws {
    let first = UsageResponseGate()
    let second = UsageResponseGate()
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
    defer { store.close() }
    store.update(runIDs: [Self.runID], events: [Self.runID: "first"])
    await first.started()
    store.update(runIDs: [Self.runID], events: [Self.runID: "replacement"])
    store.retry(Self.runID)
    await first.release()
    await second.started()
    XCTAssertEqual(store.states[Self.runID], .loading)
    await second.release()
    try await eventually { store.states[Self.runID] == .available(Self.usage(12)) }
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
    defer { store.close() }
    let ids = (0..<205).map { "run-\($0)" }
    store.update(
      runIDs: ids + ids, events: Dictionary(uniqueKeysWithValues: ids.map { ($0, "event") }))
    try await eventually {
      store.states.count == 205
        && store.states.values.allSatisfy { $0 == .available(Self.usage(5)) }
    }
    XCTAssertEqual(sizes.withLock { $0 }, [100, 100, 5])
  }

  func testLateUsagePreservesNativeReadingPositionAndFoldedRows() async throws {
    let fixture = ConversationHistoryFixture(
      rows: [
        try row(1, type: "input.prompt", text: String(repeating: "Question ", count: 25)),
        try row(2, text: "Earlier work"),
        try row(3, text: String(repeating: "A long final answer.\n\n", count: 50)),
        try row(4, type: "run.completed"),
      ], usage: { _ in Self.response(1234) })
    let conversation = fixture.conversation()
    defer { conversation.close() }
    await conversation.refresh()
    let section = try XCTUnwrap(conversation.history?.workSections.first)
    conversation.rememberReadingPosition(.init(messageID: section.id, offset: 0))
    let host = UIHostingController(rootView: ChatDetailView(conversation: conversation))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    try await eventually { abs(offset(of: section.id, in: host.view) ?? .infinity) < 1 }
    fixture.append(try row(5, type: "usage.recorded"))
    await conversation.refresh()
    try await eventually {
      conversation.runUsage.states[Self.runID] == .available(Self.usage(1234))
    }
    try await savedReadingPositionMatchesViewport(conversation, in: host.view)
    XCTAssertEqual(offset(of: section.id, in: host.view) ?? .infinity, 0, accuracy: 1)
    XCTAssertFalse(conversation.visibleItems.map(\.id).contains(ConversationHistoryFixture.id(2)))
  }

  func testCachedHistoryReopensWithUsageHintAndReadsFreshSettlement() async throws {
    let total = Mutex(4)
    let fixture = ConversationHistoryFixture(
      rows: [
        try row(1, type: "input.prompt", text: "Summarize the project costs."),
        try row(2, text: "The summary is ready. You can review this round's credit usage below."),
        try row(3, type: "run.completed"), try row(4, type: "usage.recorded"),
      ], usage: { _ in Self.response(total.withLock { $0 }) })
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace")
    let first = fixture.conversation(cache: ChatCache(scope: scope, directory: directory))
    await first.refresh()
    try await eventually { first.runUsage.states[Self.runID] == .available(Self.usage(4)) }
    first.close()
    total.withLock { $0 = 1234 }
    let restored = fixture.conversation(cache: ChatCache(scope: scope, directory: directory))
    defer { restored.close() }
    await restored.refresh()
    try await eventually { restored.runUsage.states[Self.runID] == .available(Self.usage(1234)) }
    let host = UIHostingController(rootView: ChatDetailView(conversation: restored))
    let window = try await mountConversationHost(host)
    defer { unmount(window) }
    await stableHostingGeometry(host.view)
    let collection = try XCTUnwrap(
      markers(in: host.view).first?.enclosingScrollView as? UICollectionView)
    let source = try XCTUnwrap(
      collection.dataSource as? UICollectionViewDiffableDataSource<Int, String>)
    XCTAssertTrue(source.snapshot().itemIdentifiers.contains("usage:\(Self.runID)"))
    let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
      window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    let attachment = XCTAttachment(image: screenshot)
    attachment.name = "Credit usage in conversation"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func testDisplayMergesManagedKindsAndKeepsHistoricalModelNamesAndFormats() throws {
    let catalog = try JSONDecoder().decode(
      ModelCatalog.self,
      from: Data(
        """
        {"models":[{"model":"old-model","resolvedModel":"new-model","displayName":"Historical Model","sortOrder":1,"replacedBy":"new-model"},{"model":"new-model","resolvedModel":"new-model","displayName":"New Model","sortOrder":2,"replacedBy":null}],"routes":[{"model":"old-model","upstreamModel":"vendor/old","providerType":"built-in","concreteProviderType":"vendor","enabled":false,"priority":1,"efforts":[]}]}
        """.utf8))
    let usage = try JSONDecoder().decode(
      ChatRunUsage.self,
      from: Data(
        """
        {"version":1,"totalCredits":12345,"settledAt":"now","breakdown":[{"kind":"model","credits":7,"providers":[{"provider":"old-model","credits":3},{"provider":"vendor/old","credits":4}]},{"kind":"social","credits":5,"providers":[{"provider":"socialkit","credits":2},{"provider":"monid/instagram","credits":3}]},{"kind":"image","credits":6,"providers":[{"provider":"flux-pro-1.1","credits":6}]},{"kind":"video","credits":7,"providers":[{"provider":"fal-ai/veo3.1/fast","credits":7}]},{"kind":"future-kind","credits":2,"providers":[{"provider":"future_ai/API-tool","credits":2}]}]}
        """.utf8))
    let rows = CreditUsageDisplay.rows(usage, catalog: catalog)
    XCTAssertEqual(
      rows.map(\.label),
      ["Historical Model", "Social Search", "Flux Pro v1.1", "Veo 3.1 Fast", "Future AI API Tool"])
    XCTAssertEqual(rows.map(\.credits), [7, 5, 6, 7, 2])
    XCTAssertEqual(CreditUsageDisplay.credits(12345, locale: Locale(identifier: "en_US")), "12,345")
    XCTAssertEqual(CreditUsageDisplay.credits(12345, locale: Locale(identifier: "de_DE")), "12.345")
    XCTAssertEqual(CreditUsageDisplay.credits(0), "0")
  }

  func testNativeDetailsLayoutAtStandardAndAccessibilityTextSizes() async throws {
    let usage = try JSONDecoder().decode(
      ChatRunUsage.self,
      from: Data(
        """
        {"version":1,"totalCredits":1234,"settledAt":"2026-10-20T00:00:00Z","breakdown":[{"kind":"model","credits":1000,"providers":[{"provider":"gpt-5.6-sol","credits":1000}]},{"kind":"web-search","credits":34,"providers":[{"provider":"search","credits":34}]},{"kind":"image","credits":100,"providers":[{"provider":"gpt-image-2.5-flare","credits":100}]},{"kind":"video","credits":100,"providers":[{"provider":"fal-ai/veo3.1/fast","credits":100}]}]}
        """.utf8))
    let catalog = try JSONDecoder().decode(
      ModelCatalog.self, from: Data(modelCatalogResponse().body.utf8))
    for size in [DynamicTypeSize.large, .accessibility3] {
      let host = UIHostingController(
        rootView: ConversationRunUsageDetails(state: .available(usage), catalog: catalog, retry: {})
          .environment(\.dynamicTypeSize, size))
      let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
      let window = UIWindow(windowScene: scene)
      window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
      window.rootViewController = host
      window.makeKeyAndVisible()
      try await eventually {
        guard let list = self.detailsList(in: host.view) else { return false }
        return !list.visibleCells.isEmpty
          && (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) } == 5
      }
      let list = try XCTUnwrap(detailsList(in: host.view))
      XCTAssertEqual(
        (0..<list.numberOfSections).reduce(0) { $0 + list.numberOfItems(inSection: $1) }, 5)
      XCTAssertEqual(host.view.bounds.width, 390, accuracy: 1)
      let last = IndexPath(item: 4, section: 0)
      list.scrollToItem(at: last, at: .bottom, animated: false)
      try await eventually { list.indexPathsForVisibleItems.contains(last) }
      let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
        window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
      }
      let attachment = XCTAttachment(image: screenshot)
      attachment.name = "Credit usage - \(size)"
      attachment.lifetime = .keepAlways
      add(attachment)
      unmount(window)
    }
  }

  nonisolated private static let runID = "10000000-0000-4000-8000-000000000001"
  private func detailsList(in view: UIView) -> UICollectionView? {
    if let list = view as? UICollectionView { return list }
    return view.subviews.lazy.compactMap { self.detailsList(in: $0) }.first
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
  private struct UsageBody: Decodable { let runIds: [String] }
}

private actor UsageResponseGate {
  private var blocked: CheckedContinuation<Void, Never>?
  private var ready: CheckedContinuation<Void, Never>?
  func wait() async {
    await withCheckedContinuation { continuation in
      blocked = continuation
      ready?.resume()
      ready = nil
    }
  }
  func started() async {
    if blocked != nil { return }
    await withCheckedContinuation { ready = $0 }
  }
  func release() {
    blocked?.resume()
    blocked = nil
  }
}
