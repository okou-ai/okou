import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatThreadPinTests: XCTestCase {
  func testPinQueuePreservesTheLatestChoiceAcrossDelayedWritesAndRefresh() async throws {
    let fixture = PinFixture()
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    XCTAssertFalse(isPinned(store))

    queueToggle(in: store, fixture: fixture)
    try await eventually { fixture.writes.count == 1 && isPinned(store) }
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    // Other list actions retain their existing protection while Pin remains interactive.
    await store.list.rename(try XCTUnwrap(store.list.threads.first), title: "Blocked during pin")
    let target = try XCTUnwrap(store.list.threads.first(where: { $0.id == PinFixture.target }))
    await store.list.setArchived(target, archived: true)
    let marked = await store.list.setRead(target, read: false)
    XCTAssertFalse(marked)
    XCTAssertNil(store.list.error)
    XCTAssertEqual(
      store.list.threads(agentID: PinFixture.agent, archived: false).first?.id, PinFixture.target)
    XCTAssertEqual(fixture.writes.first?.rank, "Zz")

    // An older refresh was already reading before the next local click.
    let readGate = PinGate()
    fixture.state.value.withLock { $0.nextReadGate = readGate }
    let refreshing = Task { await store.refresh() }
    try await eventually { fixture.state.value.withLock { $0.readStarted } }
    queueToggle(in: store, fixture: fixture)
    try await eventually { !isPinned(store) }
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    XCTAssertEqual(fixture.writes.count, 1)
    readGate.open()
    await refreshing.value
    XCTAssertNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)

    fixture.confirm(0)
    fixture.gates[0].open()
    try await eventually { fixture.writes.count == 2 }
    XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin"])
    XCTAssertNil(fixture.writes.dropFirst().first?.rank)
    XCTAssertFalse(isPinned(store))
    queueToggle(in: store, fixture: fixture)
    try await eventually { isPinned(store) }
    XCTAssertEqual(fixture.writes.count, 2)
    fixture.confirm(1)
    fixture.gates[1].open()
    try await eventually { fixture.writes.count == 3 }
    XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin", "pin"])
    XCTAssertEqual(Set(fixture.writes.map(\.eventID)).count, 3)
    XCTAssertTrue(fixture.writes.allSatisfy { UUID(uuidString: $0.eventID) != nil })
    XCTAssertTrue(isPinned(store))
    fixture.confirm(2)
    fixture.gates[2].open()
    await store.list.refresh(waitForCurrent: true)
    try await eventually { !store.list.isLoading }

    // After matching IDs arrive, a subsequent remote event owns the display.
    fixture.remoteUnpin()
    await store.list.refresh(waitForCurrent: true)
    try await eventually { !isPinned(store) }
    XCTAssertEqual(
      store.list.threads(agentID: PinFixture.agent, archived: false).first?.id, PinFixture.peer)
  }

  func testFailedPinKeepsOptimisticDisplayAndNextSaveStillRuns() async throws {
    let fixture = PinFixture(statuses: [503, 204, 204])
    defer { fixture.releaseAll() }
    let cacheDirectory = CacheTestDirectory(owner: self)
    var cache: ChatCache? = cacheDirectory.cache(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace"))
    defer { cache = nil }
    try await exerciseFailedPinRecovery(fixture, cache: XCTUnwrap(cache))
  }

  func testQueuedPinChangesContinueAfterEarlierRequestsFail() async throws {
    let fixture = PinFixture(statuses: [503, 503, 204])
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    queueToggle(in: store, fixture: fixture)
    try await eventually { fixture.writes.count == 1 && isPinned(store) }
    queueToggle(in: store, fixture: fixture)
    try await eventually { !isPinned(store) }
    XCTAssertEqual(fixture.writes.count, 1)

    fixture.gates[0].open()
    try await eventually { fixture.writes.count == 2 && store.list.error != nil }
    XCTAssertEqual(store.list.error, "Pin save unavailable")
    XCTAssertFalse(isPinned(store))
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    queueToggle(in: store, fixture: fixture)
    try await eventually { isPinned(store) }
    XCTAssertEqual(fixture.writes.count, 2)
    fixture.gates[1].open()
    try await eventually { fixture.writes.count == 3 }
    XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin", "pin"])
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    XCTAssertTrue(isPinned(store))
    fixture.gates[2].open()
    try await eventually { store.list.updatingThreads.isEmpty }
    XCTAssertTrue(isPinned(store))
    XCTAssertEqual(
      store.list.threads(agentID: PinFixture.agent, archived: false).first?.id, PinFixture.target)
  }

  func testClosingWorkspaceCancelsActiveAndQueuedPinsWithoutLeakingOptimism() async throws {
    let fixture = PinFixture()
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    let pin = Task { await store.list.togglePinned(PinFixture.target) }
    addTeardownBlock { @MainActor in
      store.close()
      pin.cancel()
      fixture.releaseAll()
      await pin.value
    }
    try await eventually { fixture.writes.count == 1 }
    let unpin = Task { await store.list.togglePinned(PinFixture.target) }
    addTeardownBlock { @MainActor in
      store.close()
      unpin.cancel()
      fixture.releaseAll()
      await unpin.value
    }
    try await eventually {
      store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt == nil
    }
    store.close()
    fixture.gates[0].open()
    await pin.value
    await unpin.value
    XCTAssertEqual(fixture.writes.count, 1)
    XCTAssertNil(store.list.error)
    await store.list.togglePinned(PinFixture.target)
    XCTAssertEqual(fixture.writes.count, 1)

    let fresh = fixture.workspace()
    defer { fresh.close() }
    await fresh.refresh()
    XCTAssertNil(fresh.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
    XCTAssertNil(fresh.list.error)
  }

  func testUpgradeStopsQueuedPinWritesAndRejectsFurtherChanges() async throws {
    let fixture = PinFixture(statuses: [426, 204, 204])
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    queueToggle(in: store, fixture: fixture)
    try await eventually { fixture.writes.count == 1 }
    queueToggle(in: store, fixture: fixture)
    try await eventually { !isPinned(store) }
    fixture.gates[0].open()
    try await eventually { store.needsUpgrade && !store.list.canPin(PinFixture.target) }
    fixture.releaseAll()
    await store.list.togglePinned(PinFixture.target)
    XCTAssertEqual(fixture.writes.count, 1)
  }
  private func exerciseFailedPinRecovery(_ fixture: PinFixture, cache: ChatCache) async throws {
    let store = fixture.workspace(cache: cache)
    defer { store.close() }
    try await withThrowingTaskGroup(of: Void.self) { group in
      defer { fixture.releaseAll() }
      await store.refresh()
      group.addTask { await store.list.togglePinned(PinFixture.target) }
      try await eventually { fixture.writes.count == 1 }
      fixture.gates[0].open()
      try await group.waitForAll()
      XCTAssertEqual(store.list.error, "Pin save unavailable")
      XCTAssertNotNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
      await store.refresh()
      XCTAssertNotNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
      fixture.remoteUnpin()
      await store.refresh()
      XCTAssertNotNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
      let reopened = fixture.workspace(cache: cache)
      defer { reopened.close() }
      await reopened.list.restoreCached()
      XCTAssertNil(reopened.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)

      group.addTask { await store.list.togglePinned(PinFixture.target) }
      try await eventually { fixture.writes.count == 2 }
      XCTAssertNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
      fixture.gates[1].open()
      try await group.waitForAll()
      XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin"])
      XCTAssertNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
    }
  }

  private func queueToggle(in store: WorkspaceStore, fixture: PinFixture) {
    let task = Task { await store.list.togglePinned(PinFixture.target) }
    addTeardownBlock { @MainActor in
      fixture.releaseAll()
      await task.value
    }
  }

  private func isPinned(_ store: WorkspaceStore) -> Bool {
    store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt != nil
  }

}

private final class PinGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation
  init() {
    (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
  }
  func open() {
    continuation.yield(())
    continuation.finish()
  }
  func wait() async { for await _ in stream { return } }
}

private final class PinFixture: Sendable {
  static let target = "68000000-0000-4000-8000-000000000001"
  static let peer = "68000000-0000-4000-8000-000000000002"
  static let agent = "68000000-0000-4000-8000-000000000003"
  struct Write: Sendable {
    let action: String
    let eventID: String
    let rank: String?
  }
  struct State: Sendable {
    var writes: [Write] = []
    var events: [String] = []
    var nextReadGate: PinGate?
    var readStarted = false
  }
  final class StateBox: Sendable { let value = Mutex(State()) }
  let state: StateBox
  let gates: [PinGate]
  let http: ChatHTTPFixture
  var writes: [Write] { state.value.withLock { $0.writes } }
  func releaseAll() { for gate in gates { gate.open() } }

  @MainActor
  func workspace(cache: ChatCache? = nil) -> WorkspaceStore {
    WorkspaceStore(client: http.client, webURL: http.baseURL, cache: cache)
  }

  init(statuses: [Int] = [204, 204, 204]) {
    let state = StateBox()
    let gates = (0..<3).map { _ in PinGate() }
    self.state = state
    self.gates = gates
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      switch path {
      case "/api/chat-threads/snapshot":
        let readGate = state.value.withLock { state in
          let gate = state.nextReadGate
          state.nextReadGate = nil
          if gate != nil { state.readStarted = true }
          return gate
        }
        await readGate?.wait()
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[
            {"id":"\(Self.target)","agentId":"\(Self.agent)","title":"Pin interaction","createdAt":"2026-10-20T00:00:00Z","updatedAt":"2026-10-20T00:00:00Z","sortAt":"2026-10-20T00:00:00Z"},
            {"id":"\(Self.peer)","agentId":"\(Self.agent)","title":"Existing pinned chat","createdAt":"2026-10-19T00:00:00Z","updatedAt":"2026-10-19T00:00:00Z","sortAt":"2026-10-19T00:00:00Z","pinnedAt":"2026-10-19T00:00:00Z","pinOrder":"a0"}
            ],"latestEventId":null,"latestSeqId":null}
            """)
      case "/api/chat-threads/events":
        let since =
          Int(
            URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
              $0.name == "sinceSeqId"
            }?.value ?? "0") ?? 0
        return ChatHTTPResponse(
          body:
            "{\"events\":[\(state.value.withLock { Array($0.events.dropFirst(since)).joined(separator: ",") })],\"hasMore\":false}"
        )
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      case "/api/chat-threads/\(Self.target)/pin", "/api/chat-threads/\(Self.target)/unpin":
        let query =
          URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems
          ?? []
        let eventID = try XCTUnwrap(query.first { $0.name == "eventId" }?.value)
        let write = Write(
          action: String(path.split(separator: "/").last!), eventID: eventID,
          rank: query.first { $0.name == "pinOrder" }?.value)
        let index = state.value.withLock { state in
          state.writes.append(write)
          return state.writes.count - 1
        }
        guard index < gates.count else { throw URLError(.badServerResponse) }
        await gates[index].wait()
        return ChatHTTPResponse(
          status: statuses[index],
          body: statuses[index] == 204 ? "" : "{\"error\":{\"message\":\"Pin save unavailable\"}}")
      default: throw URLError(.unsupportedURL)
      }
    }
  }

  func confirm(_ index: Int) {
    state.value.withLock { state in
      guard index < state.writes.count else {
        XCTFail("Missing pin HTTP request")
        return
      }
      let write = state.writes[index]
      state.events.append(Self.event(write, sequence: state.events.count + 1))
    }
  }

  func remoteUnpin() {
    state.value.withLock { state in
      state.events.append(
        Self.event(
          Write(action: "unpin", eventID: UUID().uuidString, rank: nil),
          sequence: state.events.count + 1))
    }
  }

  private static func event(_ write: Write, sequence: Int) -> String {
    let rank = write.rank.map { "\"\($0)\"" } ?? "null"
    return """
      {"id":"\(write.eventID.lowercased())","seqId":\(sequence),"kind":"\(write.action == "pin" ? "pinned" : "unpinned")","chatThreadId":"\(target)","agentId":"\(agent)","pinOrder":\(rank),"createdAt":"2026-10-20T01:00:00Z"}
      """
  }
}
