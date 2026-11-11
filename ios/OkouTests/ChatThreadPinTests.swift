import ChatData
import ChatDataTestSupport
import ChatDomain
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatThreadPinTests: XCTestCase {
  func testPinQueuePreservesTheLatestChoiceAcrossDelayedWritesAndRefresh() async throws {
    let writes = (1...3).map { expectation(description: "Pin write \($0) reached HTTP") }
    let readStarted = expectation(description: "An older list read reached HTTP")
    let fixture = PinFixture(
      onWrite: { index in
        guard writes.indices.contains(index) else { return XCTFail("Unexpected pin write") }
        writes[index].fulfill()
      }, onHeldRead: { readStarted.fulfill() })
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    XCTAssertFalse(isPinned(store))

    queueToggle(in: store, fixture: fixture)
    await fulfillment(of: [writes[0]], timeout: 3)
    XCTAssertTrue(isPinned(store))
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
    addTeardownBlock { @MainActor in
      store.close()
      refreshing.cancel()
      readGate.open()
      fixture.releaseAll()
      await refreshing.value
    }
    await fulfillment(of: [readStarted], timeout: 3)
    queueToggle(in: store, fixture: fixture)
    try await waitForBusinessResult { !self.isPinned(store) }
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    XCTAssertEqual(fixture.writes.count, 1)
    readGate.open()
    await refreshing.value
    XCTAssertNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)

    fixture.confirm(0)
    fixture.gates[0].open()
    await fulfillment(of: [writes[1]], timeout: 3)
    XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin"])
    XCTAssertNil(fixture.writes.dropFirst().first?.rank)
    XCTAssertFalse(isPinned(store))
    let latest = queueToggle(in: store, fixture: fixture)
    try await waitForBusinessResult { self.isPinned(store) }
    XCTAssertEqual(fixture.writes.count, 2)
    fixture.confirm(1)
    fixture.gates[1].open()
    await fulfillment(of: [writes[2]], timeout: 3)
    XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin", "pin"])
    XCTAssertEqual(Set(fixture.writes.map(\.eventID)).count, 3)
    XCTAssertTrue(fixture.writes.allSatisfy { UUID(uuidString: $0.eventID) != nil })
    XCTAssertTrue(isPinned(store))
    fixture.confirm(2)
    fixture.gates[2].open()
    await latest.value

    // After matching IDs arrive, a subsequent remote event owns the display.
    fixture.remoteUnpin()
    await store.list.refresh(waitForCurrent: true)
    XCTAssertFalse(isPinned(store))
    XCTAssertEqual(
      store.list.threads(agentID: PinFixture.agent, archived: false).first?.id, PinFixture.peer)
  }

  func testFailedPinKeepsOptimisticDisplayAndNextSaveStillRuns() async throws {
    let writes = (1...2).map { expectation(description: "Pin write \($0) reached HTTP") }
    let fixture = PinFixture(
      statuses: [503, 204, 204],
      onWrite: { index in
        guard writes.indices.contains(index) else { return XCTFail("Unexpected pin write") }
        writes[index].fulfill()
      })
    defer { fixture.releaseAll() }
    let cacheDirectory = CacheTestDirectory(owner: self)
    var cache: ChatCache? = cacheDirectory.cache(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "workspace"))
    defer { cache = nil }
    try await exerciseFailedPinRecovery(fixture, writes: writes, cache: XCTUnwrap(cache))
  }

  func testQueuedPinChangesContinueAfterEarlierRequestsFail() async throws {
    let writes = (1...3).map { expectation(description: "Pin write \($0) reached HTTP") }
    let fixture = PinFixture(
      statuses: [503, 503, 204],
      onWrite: { index in
        guard writes.indices.contains(index) else { return XCTFail("Unexpected pin write") }
        writes[index].fulfill()
      })
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    queueToggle(in: store, fixture: fixture)
    await fulfillment(of: [writes[0]], timeout: 3)
    XCTAssertTrue(isPinned(store))
    queueToggle(in: store, fixture: fixture)
    try await waitForBusinessResult { !self.isPinned(store) }
    XCTAssertEqual(fixture.writes.count, 1)

    fixture.gates[0].open()
    await fulfillment(of: [writes[1]], timeout: 3)
    try await waitForBusinessResult { store.list.error != nil }
    XCTAssertEqual(store.list.error, "Pin save unavailable")
    XCTAssertFalse(isPinned(store))
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    let latest = queueToggle(in: store, fixture: fixture)
    try await waitForBusinessResult { self.isPinned(store) }
    XCTAssertEqual(fixture.writes.count, 2)
    fixture.gates[1].open()
    await fulfillment(of: [writes[2]], timeout: 3)
    XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin", "pin"])
    XCTAssertTrue(store.list.canPin(PinFixture.target))
    XCTAssertTrue(isPinned(store))
    fixture.gates[2].open()
    await latest.value
    XCTAssertTrue(isPinned(store))
    XCTAssertEqual(
      store.list.threads(agentID: PinFixture.agent, archived: false).first?.id, PinFixture.target)
  }

  func testClosingWorkspaceCancelsActiveAndQueuedPinsWithoutLeakingOptimism() async throws {
    let written = expectation(description: "The active pin reached HTTP")
    let fixture = PinFixture(onWrite: { _ in written.fulfill() })
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
    await fulfillment(of: [written], timeout: 3)
    let unpin = Task { await store.list.togglePinned(PinFixture.target) }
    addTeardownBlock { @MainActor in
      store.close()
      unpin.cancel()
      fixture.releaseAll()
      await unpin.value
    }
    try await waitForBusinessResult {
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
    let written = expectation(description: "The active pin reached HTTP")
    let fixture = PinFixture(statuses: [426, 204, 204], onWrite: { _ in written.fulfill() })
    defer { fixture.releaseAll() }
    let store = fixture.workspace()
    defer { store.close() }
    await store.refresh()
    queueToggle(in: store, fixture: fixture)
    await fulfillment(of: [written], timeout: 3)
    queueToggle(in: store, fixture: fixture)
    try await waitForBusinessResult { !self.isPinned(store) }
    fixture.gates[0].open()
    try await waitForBusinessResult { store.needsUpgrade && !store.list.canPin(PinFixture.target) }
    fixture.releaseAll()
    await store.list.togglePinned(PinFixture.target)
    XCTAssertEqual(fixture.writes.count, 1)
  }
  private func exerciseFailedPinRecovery(
    _ fixture: PinFixture, writes: [XCTestExpectation], cache: ChatCache
  ) async throws {
    let store = fixture.workspace(cache: cache)
    defer { store.close() }
    try await withThrowingTaskGroup(of: Void.self) { group in
      defer { fixture.releaseAll() }
      await store.refresh()
      group.addTask { await store.list.togglePinned(PinFixture.target) }
      await fulfillment(of: [writes[0]], timeout: 3)
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
      await fulfillment(of: [writes[1]], timeout: 3)
      XCTAssertNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
      fixture.gates[1].open()
      try await group.waitForAll()
      XCTAssertEqual(fixture.writes.map(\.action), ["pin", "unpin"])
      XCTAssertNil(store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt)
    }
  }

  @discardableResult
  private func queueToggle(in store: WorkspaceStore, fixture: PinFixture) -> Task<Void, Never> {
    let task = Task { await store.list.togglePinned(PinFixture.target) }
    addTeardownBlock { @MainActor in
      store.close()
      task.cancel()
      fixture.releaseAll()
      await task.value
    }
    return task
  }

  private func isPinned(_ store: WorkspaceStore) -> Bool {
    store.list.threads.first(where: { $0.id == PinFixture.target })?.pinnedAt != nil
  }

  func testMovingAPinWritesItsNewRankAndTheSidebarKeepsTheConfirmedOrder() async throws {
    let fixture = PinOrderFixture()
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, readRetrySleep: { _ in })
    defer { store.close() }
    await store.refreshNavigation()
    await store.list.refresh()
    await store.projects.activate()
    let first = PinOrderFixture.id(1)
    let second = PinOrderFixture.id(2)
    let third = PinOrderFixture.id(3)
    XCTAssertEqual(try pinnedRows(store), [first, second, third])
    let initial = try store.sidebar.stateStore.get(store.sidebar.presentation)
    XCTAssertEqual(initial.pinNeighbors(of: second), .init(above: first, below: third))

    await store.list.movePinned(third, beside: first, placement: .before)
    XCTAssertEqual(fixture.writes.map(\.threadID), [third])
    XCTAssertEqual(fixture.writes.last?.pinOrder, "Zz")
    XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(fixture.writes.last?.eventID)))
    XCTAssertEqual(try pinnedRows(store), [third, first, second])
    XCTAssertNil(store.list.error)

    // Down from the top lands between the next two pins; refresh keeps the confirmed rank.
    await store.list.movePinned(third, beside: first, placement: .after)
    XCTAssertEqual(fixture.writes.last?.pinOrder, "a0V")
    await store.list.refresh(waitForCurrent: true)
    XCTAssertEqual(try pinnedRows(store), [first, third, second])
    XCTAssertEqual(fixture.writes.count, 2)
  }

  func testAProjectPinRanksAgainstTheProjectsPinsAcrossAgents() async throws {
    let fixture = PinOrderFixture()
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL, readRetrySleep: { _ in })
    defer { store.close() }
    await store.refreshNavigation()
    await store.list.refresh()
    await store.projects.activate()
    let own = PinOrderFixture.id(4)
    let otherAgents = PinOrderFixture.id(5)
    XCTAssertEqual(try projectRows(store), [own, otherAgents])
    let initial = try store.sidebar.stateStore.get(store.sidebar.presentation)
    let neighbors = try XCTUnwrap(initial.pinNeighbors(of: otherAgents))
    XCTAssertEqual(neighbors, .init(above: own, below: nil, projectID: PinOrderFixture.project))

    await store.list.movePinned(
      otherAgents, beside: own, placement: .before, projectID: neighbors.projectID)
    XCTAssertEqual(fixture.writes.map(\.threadID), [otherAgents])
    XCTAssertEqual(fixture.writes.last?.pinOrder, "a4")
    await store.list.refresh(waitForCurrent: true)
    XCTAssertEqual(try projectRows(store), [otherAgents, own])
    // The pins outside the project keep their order.
    XCTAssertEqual(try pinnedRows(store), (1...3).map(PinOrderFixture.id))
    XCTAssertNil(store.list.error)
  }

  private func pinnedRows(_ store: WorkspaceStore) throws -> [String] {
    try store.sidebar.stateStore.get(store.sidebar.presentation).chats.rows
      .filter(\.isPinned).map(\.id)
  }

  private func projectRows(_ store: WorkspaceStore) throws -> [String] {
    try store.sidebar.stateStore.get(store.sidebar.presentation).projects.first?.section.rows
      .map(\.id) ?? []
  }
}

/// Three pins of the default Agent outside projects, and a project pinning one chat of that
/// Agent and one of another; each rank write is confirmed in the event stream.
private final class PinOrderFixture: Sendable {
  struct Write: Decodable, Sendable {
    var threadID = ""
    let pinOrder: String
    let eventId: String
    var eventID: String { eventId }

    enum CodingKeys: CodingKey { case pinOrder, eventId }
  }
  struct Server: Sendable {
    var writes: [Write] = []
    var events: [String] = []
  }
  final class ServerBox: Sendable { let value = Mutex(Server()) }
  static let agent = "69000000-0000-4000-8000-000000000100"
  static let otherAgent = "69000000-0000-4000-8000-000000000101"
  static let project = "69000000-0000-4000-8000-000000000200"
  private let server: ServerBox
  var writes: [Write] { server.value.withLock { $0.writes } }
  let http: ChatHTTPFixture

  static func id(_ value: Int) -> String {
    "69000000-0000-4000-8000-\(String(format: "%012d", value))"
  }

  static func agentID(of threadID: String) -> String {
    threadID == id(5) ? otherAgent : agent
  }

  init() {
    let state = ServerBox()
    server = state
    http = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      switch path {
      case "/api/agents":
        return ChatHTTPResponse(
          body: "[{\"agentId\":\"\(Self.agent)\",\"displayName\":\"Okou\",\"isDefaultAgent\":true}]"
        )
      case "/api/projects":
        return ChatHTTPResponse(
          body:
            "{\"projects\":[{\"id\":\"\(Self.project)\",\"name\":\"Launch\",\"createdAt\":\"2026-11-10T00:00:00Z\",\"updatedAt\":\"2026-11-10T00:00:00Z\"}]}"
        )
      case "/api/chat-threads/snapshot":
        // Chats 4 and 5 are the project's; their ranks sit after the Agent's own pins.
        let rows = (1...5).map { index in
          let project = index > 3 ? "\"\(Self.project)\"" : "null"
          return """
            {"id":"\(Self.id(index))","agentId":"\(Self.agentID(of: Self.id(index)))",
            "title":"Pin \(index)","projectId":\(project),
            "createdAt":"2026-11-11T00:00:00Z","updatedAt":"2026-11-11T00:00:00Z",
            "sortAt":"2026-11-11T00:0\(index):00Z","pinnedAt":"2026-11-11T00:00:00Z",
            "pinOrder":"a\(index > 3 ? index + 1 : index - 1)"}
            """
        }
        return ChatHTTPResponse(
          body:
            "{\"chatThreads\":[\(rows.joined(separator: ","))],\"latestEventId\":null,\"latestSeqId\":null}"
        )
      case "/api/chat-threads/events":
        let since =
          Int(
            URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?
              .queryItems?.first { $0.name == "sinceSeqId" }?.value ?? "0") ?? 0
        let events = state.value.withLock { Array($0.events.dropFirst(since)) }
        return ChatHTTPResponse(
          body: "{\"events\":[\(events.joined(separator: ","))],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"agents\":{},\"threads\":{},\"unreadAt\":{}}")
      default:
        guard request.httpMethod == "POST", path.hasPrefix("/api/chat-threads/"),
          path.hasSuffix("/pin-order")
        else { throw URLError(.unsupportedURL) }
        var write = try JSONDecoder().decode(Write.self, from: chatRequestBody(request))
        write.threadID = String(path.split(separator: "/")[2])
        state.value.withLock { state in
          state.writes.append(write)
          state.events.append(
            """
            {"id":"\(write.eventID)","seqId":\(state.events.count + 1),"kind":"sort_touched","chatThreadId":"\(write.threadID)","agentId":"\(Self.agentID(of: write.threadID))","pinOrder":"\(write.pinOrder)","createdAt":"2026-11-11T01:00:00Z"}
            """)
        }
        return ChatHTTPResponse(status: 204, body: "")
      }
    }
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

  init(
    statuses: [Int] = [204, 204, 204],
    onWrite: @escaping @Sendable (Int) -> Void = { _ in },
    onHeldRead: @escaping @Sendable () -> Void = {}
  ) {
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
          return gate
        }
        if readGate != nil { onHeldRead() }
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
        onWrite(index)
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
