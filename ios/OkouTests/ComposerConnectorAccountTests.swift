import CCState
import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerConnectorAccountTests: XCTestCase {
  private typealias F = ConnectorHTTPFixtures

  func testSharedReadsPaginationTerminalCursorAndSearchReset() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture)
    defer { composer.close() }
    let resources = try open(composer)
    async let first = resources.store.get(resources.page).value
    async let second = resources.store.get(resources.page).value
    let values = try await (first, second)
    XCTAssertEqual(values.0.accounts.map(\.id), [F.accountID])
    XCTAssertEqual(values.1.defaultAccount?.id, F.accountID)
    XCTAssertEqual(fixture.pageRequests.count, 1)
    await resources.loadMore()
    let all = try await resources.store.get(resources.page).value
    XCTAssertEqual(all.accounts.map(\.id), [F.accountID, F.siblingID])
    XCTAssertNil(all.nextCursor)
    await resources.loadMore()
    XCTAssertEqual(fixture.pageRequests.count, 2)
    resources.update(search: "Personal")
    let filtered = try await resources.store.get(resources.page).value
    XCTAssertEqual(filtered.accounts.map(\.id), [F.siblingID])
    XCTAssertNil(filtered.nextCursor)
    XCTAssertEqual(AccountPageFixture.query("limit", fixture.pageRequests.last!), "50")
  }

  func testPaginationFailureRetainsLoadedAccountsAndRetriesTheSameCursor() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture)
    defer { composer.close() }
    let resources = try open(composer)
    _ = try await resources.store.get(resources.page).value
    fixture.state.withLock { $0.failMore = true }
    await resources.loadMore()
    if case .success = await (try resources.store.get(resources.pagination)).result {
      XCTFail("A failed page became success")
    }
    let retained = try await resources.store.get(resources.page).value
    XCTAssertEqual(retained.accounts.map(\.id), [F.accountID])
    XCTAssertEqual(retained.nextCursor, "second")
    fixture.state.withLock { $0.failMore = false }
    await resources.loadMore()
    try await resources.store.get(resources.pagination).value
    let recovered = try await resources.store.get(resources.page).value
    XCTAssertEqual(recovered.accounts.map(\.id), [F.accountID, F.siblingID])
    XCTAssertNil(recovered.nextCursor)
    XCTAssertEqual(fixture.pageRequests.suffix(2).map { AccountPageFixture.query("cursor", $0) }, ["second", "second"])
  }

  func testChangingSearchCancelsOriginalPaginationAndRejectsItsLateResult() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Pagination reached HTTP")
    let cancelled = expectation(description: "Original pagination HTTP cancelled")
    let fixture = AccountPageFixture { request in
      guard AccountPageFixture.query("cursor", request) == "second" else { return }
      await withTaskCancellationHandler {
        started.fulfill()
        await gate.wait()
      } onCancel: { cancelled.fulfill() }
    }
    let composer = await makeComposer(fixture)
    defer { composer.close(); gate.open() }
    let resources = try open(composer)
    _ = try await resources.store.get(resources.page).value
    let pending = Task { await resources.loadMore() }
    addTeardownBlock { pending.cancel(); gate.open(); await pending.value }
    await fulfillment(of: [started], timeout: 3)
    resources.update(search: "Personal")
    await fulfillment(of: [cancelled], timeout: 3)
    let current = try await resources.store.get(resources.page).value
    XCTAssertEqual(current.accounts.map(\.id), [F.siblingID])
    gate.open()
    await pending.value
    let after = try await resources.store.get(resources.page).value
    XCTAssertEqual(after.accounts.map(\.id), [F.siblingID])
    XCTAssertNil(after.nextCursor)
  }

  func testClosingReadOwnerCancelsHTTPAndCannotActForTheNextAgent() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Search reached HTTP")
    let cancelled = expectation(description: "Search HTTP cancelled")
    let fixture = AccountPageFixture { request in
      guard AccountPageFixture.query("search", request) == "hold" else { return }
      await withTaskCancellationHandler {
        started.fulfill(); await gate.wait()
      } onCancel: { cancelled.fulfill() }
    }
    let composer = await makeComposer(fixture)
    defer { composer.close(); gate.open() }
    let old = try open(composer)
    old.update(search: "hold")
    let pending = try old.store.get(old.page)
    addTeardownBlock { pending.cancel(); gate.open(); _ = await pending.result }
    await fulfillment(of: [started], timeout: 3)
    composer.configure(agentID: F.attemptID)
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    if case .success = await pending.result { XCTFail("A retired owner returned account data") }
    await old.apply(.select(F.siblingID))
    await composer.refresh()
    let current = try open(composer)
    let page = try await current.store.get(current.page).value
    XCTAssertEqual(page.selectedID, F.accountID)
    XCTAssertTrue(fixture.writes.isEmpty)
  }

  func testLegacyDraftSelectionAndUseDefaultSurviveClosingWithoutChangingDefaults() async throws {
    let fixture = AccountPageFixture(modern: false)
    let composer = await makeComposer(fixture)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.select(F.siblingID))
    resources.close()
    let reopened = try open(composer)
    let selected = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(selected.selectedID, F.siblingID)
    XCTAssertEqual(selected.defaultAccount?.id, F.accountID)
    await reopened.apply(.select(nil))
    let inherited = try await reopened.store.get(reopened.page).value
    XCTAssertNil(inherited.selectedID)
    XCTAssertEqual(inherited.defaultAccount?.id, F.accountID)
  }

  func testDefaultManagementDoesNotReplaceTheChatsExplicitCurrentAccount() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let chat = try open(composer)
    await chat.apply(.select(F.accountID))
    let management = try open(composer, defaults: true)
    await management.apply(.defaultAccount(F.siblingID))
    let value = try await management.store.get(management.page).value
    XCTAssertEqual(value.defaults.first(where: \.isDefault)?.connectionId, F.siblingID)
    let current = try await chat.store.get(chat.page).value
    XCTAssertEqual(current.selectedID, F.accountID)
    await management.apply(.defaultEnabled(F.siblingID, false))
    let disabled = try await management.store.get(management.page).value
    XCTAssertEqual(disabled.defaults.first { $0.connectionId == F.siblingID }?.defaultEnabled, false)
  }

  func testDismissedSelectionCompletesAndRefreshesAReopenedDestination() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Selection reached HTTP")
    let fixture = AccountPageFixture { request in
      guard request.url?.path.hasSuffix("/connector-current") == true else { return }
      started.fulfill(); await gate.wait()
    }
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close(); gate.open() }
    let resources = try open(composer)
    let write = Task { await resources.apply(.select(F.siblingID)) }
    addTeardownBlock { write.cancel(); gate.open(); await write.value }
    await fulfillment(of: [started], timeout: 3)
    composer.closeAccounts()
    let reopened = try open(composer)
    let before = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(before.selectedID, F.accountID)
    gate.open()
    await write.value
    let after = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(after.selectedID, F.siblingID)
    XCTAssertTrue(composer.canSend)
    XCTAssertEqual(fixture.writes.count, 1)
  }

  func testRejectedSelectionRequiresReadbackAndNeverReplaysTheWrite() async throws {
    let fixture = AccountPageFixture()
    fixture.backend.state.withLock { $0.rejectCurrentOnce = true }
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.select(F.siblingID))
    XCTAssertFalse(composer.canSend)
    await resources.apply(.select(F.siblingID))
    XCTAssertEqual(fixture.writes.count, 1)
    await resources.retry()
    let confirmed = try await resources.store.get(resources.page).value
    XCTAssertEqual(confirmed.selectedID, F.accountID)
    XCTAssertTrue(composer.canSend)
    XCTAssertEqual(fixture.writes.count, 1)
  }

  func testCustomAccountsKeepTheirOwnTargetAcrossPaginationAndSelection() async throws {
    let fixture = AccountPageFixture(custom: true)
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.loadMore()
    let value = try await resources.store.get(resources.page).value
    XCTAssertEqual(value.accounts.map(\.id), [F.accountID, F.siblingID])
    await resources.apply(.select(F.siblingID))
    let selected = try await resources.store.get(resources.page).value
    XCTAssertEqual(selected.selectedID, F.siblingID)
    XCTAssertTrue(fixture.pageRequests.allSatisfy {
      AccountPageFixture.query("customConnectorId", $0) == F.customID
    })
    let request = try XCTUnwrap(fixture.writes.last)
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
    let target = try XCTUnwrap(body["target"] as? [String: String])
    XCTAssertEqual(target["customConnectorId"], F.customID)
  }

  func testLegacyThreadSelectionReadbackIncludesAnOffPageSelectedAccount() async throws {
    let fixture = AccountPageFixture(modern: false)
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.select(F.siblingID))
    resources.update(search: "Work")
    let selected = try await resources.store.get(resources.page).value
    XCTAssertEqual(selected.selectedID, F.siblingID)
    XCTAssertEqual(selected.accounts.map(\.id), [F.siblingID, F.accountID])
    await resources.apply(.select(nil))
    let inherited = try await resources.store.get(resources.page).value
    XCTAssertNil(inherited.selectedID)
    XCTAssertEqual(inherited.accounts.map(\.id), [F.accountID])
  }

  func testFirstPageErrorStaysCachedUntilExplicitRetry() async throws {
    let fixture = AccountPageFixture()
    fixture.state.withLock { $0.failFirst = true }
    let composer = await makeComposer(fixture)
    defer { composer.close() }
    let resources = try open(composer)
    let first = try resources.store.get(resources.page)
    if case .success = await first.result { XCTFail("Failed account read became data") }
    fixture.state.withLock { $0.failFirst = false }
    let again = try resources.store.get(resources.page)
    if case .success = await again.result { XCTFail("Observation silently retried the read") }
    XCTAssertEqual(fixture.pageRequests.count, 1)
    await resources.retry()
    let recovered = try await resources.store.get(resources.page).value
    XCTAssertEqual(recovered.accounts.map(\.id), [F.accountID])
    XCTAssertEqual(fixture.pageRequests.count, 2)
  }

  private func makeComposer(_ fixture: AccountPageFixture, thread: Bool = false) async
    -> ComposerConnectorStore
  {
    let value = thread ? ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Accounts", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil) : nil
    let composer = ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.http.client),
      authorizationService: ChatConnectorService(client: fixture.http.client),
      webURL: fixture.http.baseURL, thread: value, didFail: { _ in })
    if !thread { composer.configure(agentID: F.agentID) }
    await composer.refresh()
    return composer
  }

  private func open(_ composer: ComposerConnectorStore, defaults: Bool = false) throws
    -> ComposerConnectorAccountResources
  {
    let connector = try XCTUnwrap(composer.connectors.first)
    return try XCTUnwrap(composer.openAccounts(connector, managesDefaults: defaults))
  }
}

/// Paginated HTTP in front of the existing stateful external account contract fixture.
final class AccountPageFixture: Sendable {
  private typealias F = ConnectorHTTPFixtures
  struct State: Sendable {
    var failMore = false
    var failFirst = false
    var requests: [URLRequest] = []
    var selections: [String: String] = [:]
  }
  final class ServerState: Sendable {
    private let value = Mutex(State())
    func withLock<T>(_ operation: (inout State) throws -> T) rethrows -> T {
      try value.withLock { try operation(&$0) }
    }
  }
  let state = ServerState()
  let backend: ConnectorAccessHTTPFixture
  let http: ChatHTTPFixture
  var pageRequests: [URLRequest] {
    state.withLock { $0.requests.filter { $0.url?.path == "/api/connector-accounts/connections" } }
  }
  var writes: [URLRequest] {
    state.withLock { $0.requests.filter { ["PUT", "POST", "DELETE"].contains($0.httpMethod ?? "") } }
  }

  init(modern: Bool = true, custom: Bool = false,
       before: @escaping @Sendable (URLRequest) async -> Void = { _ in }) {
    var initial = ConnectorAccessHTTPFixture.State()
    initial.custom = custom
    initial.enabled[F.siblingID] = true
    let backend = ConnectorAccessHTTPFixture(initial: initial, onUnhandledRequest: { XCTFail($0) })
    self.backend = backend
    let state = state
    http = ChatHTTPFixture { request in
      var request = request
      request.httpBody = chatRequestBody(request)
      state.withLock { $0.requests.append(request) }
      await before(request)
      let path = request.url!.path
      if !modern, path == "/api/feature-switches" { return ChatHTTPResponse(body: #"{"effectiveSwitches":{}}"#) }
      if path.hasPrefix("/api/agents/"), path.hasSuffix("/connector-access") {
        return ChatHTTPResponse(body: #"{"enabledConnectorSlugs":["slack"],"customConnectorIds":[]}"#)
      }
      if path.hasSuffix("/connector-selections") {
        let thread = request.url!.deletingLastPathComponent().lastPathComponent
        let method = request.httpMethod ?? "GET"
        if method != "GET" {
          let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as! [String: Any]
          state.withLock { $0.selections[thread] = method == "DELETE" ? nil : body["connectionId"] as? String }
          return ChatHTTPResponse(status: method == "DELETE" ? 204 : 200, body: "{}")
        }
        let selected = state.withLock { $0.selections[thread] }
        let target = custom ? "{\"kind\":\"custom\",\"customConnectorId\":\"\(F.customID)\"}"
          : #"{"kind":"builtin","connectorSlug":"slack"}"#
        let selections = selected.map { "[{\"target\":\(target),\"connectionId\":\"\($0)\"}]" } ?? "[]"
        let connections = selected.map { "[" + F.account(id: $0, custom: custom, isDefault: false, label: "Personal account") + "]" } ?? "[]"
        return ChatHTTPResponse(body: "{\"selections\":\(selections),\"selectedConnections\":\(connections)}")
      }
      if path == "/api/connector-accounts/connections" {
        let cursor = Self.query("cursor", request)
        let search = Self.query("search", request) ?? ""
        if state.withLock({ cursor == nil ? $0.failFirst : $0.failMore }) {
          return ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Accounts temporarily unavailable"}}"#)
        }
        let first = F.account(custom: custom)
        let second = F.account(id: F.siblingID, custom: custom, isDefault: false, label: "Personal account")
        let values: [String]
        if !search.isEmpty { values = [first, second].filter { $0.localizedCaseInsensitiveContains(search) } }
        else { values = cursor == nil ? [first] : [second] }
        let next = search.isEmpty && cursor == nil ? #""second""# : "null"
        return ChatHTTPResponse(body: "{\"connections\":[\(values.joined(separator: ","))],\"defaultConnection\":\(first),\"nextCursor\":\(next)}")
      }
      var forwarded = request
      forwarded.url = URL(string: request.url!.path + (request.url!.query.map { "?" + $0 } ?? ""), relativeTo: backend.http.baseURL)!
      let (data, response) = try await backend.http.session.data(for: forwarded)
      return ChatHTTPResponse(status: (response as! HTTPURLResponse).statusCode, body: String(decoding: data, as: UTF8.self))
    }
  }

  static func query(_ name: String, _ request: URLRequest) -> String? {
    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
  }
}
