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
  private typealias FixtureData = ConnectorHTTPFixtures

  func testClosingManagementCancelsCatalogAndDisconnectImpactHTTP() async throws {
    for impact in [false, true] {
      let gate = ModelResponseGate()
      let started = expectation(description: "Management HTTP started")
      let cancelled = expectation(description: "Original management HTTP cancelled")
      let path =
        impact
        ? "/api/connector-accounts/\(FixtureData.accountID)/deletion-impact"
        : "/api/connector-catalog/slack"
      let fixture = AccountPageFixture { request in
        guard request.url?.path == path else { return }
        await withTaskCancellationHandler {
          started.fulfill()
          await gate.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
      let composer = await makeComposer(fixture)
      let resources = try open(composer, defaults: true)
      if impact { resources.prepareDisconnect(FixtureData.accountID) }
      let pending = Task<Void, Error> {
        if impact {
          _ = try await resources.store.get(resources.deletionImpact).value
        } else {
          _ = try await resources.store.get(resources.catalog).value
        }
      }
      addTeardownBlock {
        pending.cancel()
        gate.open()
        _ = await pending.result
      }
      defer {
        composer.close()
        gate.open()
      }
      await fulfillment(of: [started], timeout: 3)
      resources.close()
      await fulfillment(of: [cancelled], timeout: 3)
      gate.open()
      if case .success = await pending.result { XCTFail("A retired read published metadata") }
    }
  }

  func testSharedReadsPaginationTerminalCursorAndSearchReset() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture)
    defer { composer.close() }
    let resources = try open(composer)
    let first = try resources.store.get(resources.page)
    let second = try resources.store.get(resources.page)
    let values = try await (first.value, second.value)
    XCTAssertEqual(values.0.accounts.map(\.id), [FixtureData.accountID])
    XCTAssertEqual(values.1.access.accounts.first(where: \.isDefault)?.id, FixtureData.accountID)
    XCTAssertEqual(fixture.pageRequests.count, 1)
    await resources.loadMore()
    let all = try await resources.store.get(resources.page).value
    XCTAssertEqual(all.accounts.map(\.id), [FixtureData.accountID, FixtureData.siblingID])
    XCTAssertNil(all.nextCursor)
    await resources.loadMore()
    XCTAssertEqual(fixture.pageRequests.count, 2)
    resources.update(search: "Personal")
    let filtered = try await resources.store.get(resources.page).value
    XCTAssertEqual(filtered.accounts.map(\.id), [FixtureData.siblingID])
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
    XCTAssertEqual(retained.accounts.map(\.id), [FixtureData.accountID])
    XCTAssertEqual(retained.nextCursor, "second")
    fixture.state.withLock { $0.failMore = false }
    await resources.loadMore()
    try await resources.store.get(resources.pagination).value
    let recovered = try await resources.store.get(resources.page).value
    XCTAssertEqual(recovered.accounts.map(\.id), [FixtureData.accountID, FixtureData.siblingID])
    XCTAssertNil(recovered.nextCursor)
    XCTAssertEqual(
      fixture.pageRequests.suffix(2).map { AccountPageFixture.query("cursor", $0) },
      ["second", "second"])
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
      } onCancel: {
        cancelled.fulfill()
      }
    }
    let composer = await makeComposer(fixture)
    defer {
      composer.close()
      gate.open()
    }
    let resources = try open(composer)
    _ = try await resources.store.get(resources.page).value
    let pending = Task { await resources.loadMore() }
    addTeardownBlock {
      pending.cancel()
      gate.open()
      await pending.value
    }
    await fulfillment(of: [started], timeout: 3)
    resources.update(search: "Personal")
    await fulfillment(of: [cancelled], timeout: 3)
    let current = try await resources.store.get(resources.page).value
    XCTAssertEqual(current.accounts.map(\.id), [FixtureData.siblingID])
    gate.open()
    await pending.value
    let after = try await resources.store.get(resources.page).value
    XCTAssertEqual(after.accounts.map(\.id), [FixtureData.siblingID])
    XCTAssertNil(after.nextCursor)
  }

  func testClosingReadOwnerCancelsHTTPAndCannotActForTheNextEditor() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Search reached HTTP")
    let cancelled = expectation(description: "Search HTTP cancelled")
    let fixture = AccountPageFixture { request in
      guard AccountPageFixture.query("search", request) == "hold" else { return }
      await withTaskCancellationHandler {
        started.fulfill()
        await gate.wait()
      } onCancel: {
        cancelled.fulfill()
      }
    }
    let composer = await makeComposer(fixture)
    defer {
      composer.close()
      gate.open()
    }
    let old = try open(composer)
    old.update(search: "hold")
    let pending = try old.store.get(old.page)
    addTeardownBlock {
      pending.cancel()
      gate.open()
      _ = await pending.result
    }
    await fulfillment(of: [started], timeout: 3)
    composer.closeAccounts()
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    if case .success = await pending.result { XCTFail("A retired owner returned account data") }
    await old.apply(.access(FixtureData.accountID, false))
    await composer.refresh()
    let current = try open(composer)
    let page = try await current.store.get(current.page).value
    XCTAssertEqual(page.access.currentConnectionId, FixtureData.accountID)
    XCTAssertTrue(fixture.writes.isEmpty)
  }

  func testDraftAccountOverrideSurvivesClosingAndReturnsToItsInheritedDefault() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.access(FixtureData.accountID, false))
    resources.close()
    let reopened = try open(composer)
    let disabled = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(disabled.access.currentConnectionId, FixtureData.siblingID)
    let account = try XCTUnwrap(disabled.access.accounts.first { $0.id == FixtureData.accountID })
    XCTAssertTrue(account.defaultEnabled)
    XCTAssertEqual(account.overrideEnabled, false)
    await reopened.apply(.access(FixtureData.accountID, nil))
    let inherited = try await reopened.store.get(reopened.page).value
    let restored = try XCTUnwrap(inherited.access.accounts.first { $0.id == FixtureData.accountID })
    XCTAssertNil(restored.overrideEnabled)
    XCTAssertTrue(restored.enabled)
    XCTAssertTrue(fixture.writes.isEmpty)
  }

  func testDefaultManagementDoesNotReplaceTheChatsExplicitCurrentAccount() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let chat = try open(composer)
    try await composer.service.setCurrentAccount(
      target: .builtin("slack"), connectionID: FixtureData.accountID, threadID: FixtureData.threadID
    )
    await composer.refresh()
    let management = try open(composer, defaults: true)
    await management.apply(.defaultAccount(FixtureData.siblingID))
    let value = try await management.store.get(management.page).value
    XCTAssertEqual(value.defaults.first(where: \.isDefault)?.connectionId, FixtureData.siblingID)
    let current = try await chat.store.get(chat.page).value
    XCTAssertEqual(current.access.currentConnectionId, FixtureData.accountID)
    await management.apply(.defaultEnabled(FixtureData.siblingID, false))
    let disabled = try await management.store.get(management.page).value
    XCTAssertEqual(
      disabled.defaults.first { $0.connectionId == FixtureData.siblingID }?.defaultEnabled, false)
  }

  func testDismissedAccessChangeCompletesAndRefreshesAReopenedDestination() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Account access change reached HTTP")
    let fixture = AccountPageFixture { request in
      guard request.httpMethod == "PUT", request.url?.path.contains("/connector-access/") == true
      else { return }
      started.fulfill()
      await gate.wait()
    }
    let composer = await makeComposer(fixture, thread: true)
    defer {
      composer.close()
      gate.open()
    }
    let resources = try open(composer)
    let write = Task { await resources.apply(.access(FixtureData.accountID, false)) }
    addTeardownBlock {
      write.cancel()
      gate.open()
      await write.value
    }
    await fulfillment(of: [started], timeout: 3)
    composer.closeAccounts()
    let reopened = try open(composer)
    let before = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(before.access.currentConnectionId, FixtureData.accountID)
    gate.open()
    await write.value
    let after = try await reopened.store.get(reopened.page).value
    XCTAssertEqual(after.access.currentConnectionId, FixtureData.siblingID)
    XCTAssertTrue(composer.canSend)
    XCTAssertEqual(fixture.writes.count, 1)
  }

  func testRejectedAccessChangeRequiresReadbackAndNeverReplaysTheWrite() async throws {
    let fixture = AccountPageFixture()
    fixture.backend.state.withLock { $0.rejectOverrideOnce = true }
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.apply(.access(FixtureData.accountID, false))
    XCTAssertFalse(composer.canSend)
    await resources.apply(.access(FixtureData.accountID, false))
    XCTAssertEqual(fixture.writes.count, 1)
    await resources.retry()
    let confirmed = try await resources.store.get(resources.page).value
    XCTAssertEqual(confirmed.access.currentConnectionId, FixtureData.accountID)
    XCTAssertTrue(composer.canSend)
    XCTAssertEqual(fixture.writes.count, 1)
  }

  func testCustomAccountsKeepTheirOwnTargetAcrossPaginationAndAccessChanges() async throws {
    let fixture = AccountPageFixture(custom: true)
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    let resources = try open(composer)
    await resources.loadMore()
    let value = try await resources.store.get(resources.page).value
    XCTAssertEqual(value.accounts.map(\.id), [FixtureData.accountID, FixtureData.siblingID])
    await resources.apply(.access(FixtureData.accountID, false))
    let selected = try await resources.store.get(resources.page).value
    XCTAssertEqual(selected.access.currentConnectionId, FixtureData.siblingID)
    XCTAssertTrue(
      fixture.pageRequests.allSatisfy {
        AccountPageFixture.query("customConnectorId", $0) == FixtureData.customID
      })
    let request = try XCTUnwrap(fixture.writes.last)
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
    let target = try XCTUnwrap(body["target"] as? [String: String])
    XCTAssertEqual(target["customConnectorId"], FixtureData.customID)
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
    XCTAssertEqual(recovered.accounts.map(\.id), [FixtureData.accountID])
    XCTAssertEqual(fixture.pageRequests.count, 2)
  }

  func testAnOffPageCurrentAccountDoesNotReplaceLoadedPaginationData() async throws {
    let fixture = AccountPageFixture()
    let composer = await makeComposer(fixture, thread: true)
    defer { composer.close() }
    try await composer.service.setCurrentAccount(
      target: .builtin("slack"), connectionID: FixtureData.siblingID, threadID: FixtureData.threadID
    )
    await composer.refresh()
    let selectedPath = "/api/connector-accounts/\(FixtureData.siblingID)"
    XCTAssertFalse(fixture.state.withLock { $0.requests.contains { $0.url?.path == selectedPath } })
    let resources = try open(composer)
    let pinned = try await resources.store.get(resources.page).value
    XCTAssertEqual(pinned.accounts.map(\.id), [FixtureData.siblingID, FixtureData.accountID])
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.url?.path == selectedPath }.count }, 1)
    await resources.loadMore()
    try await composer.service.setCurrentAccount(
      target: .builtin("slack"), connectionID: FixtureData.accountID, threadID: FixtureData.threadID
    )
    await composer.refresh()
    let loaded = try await resources.store.get(resources.page).value
    XCTAssertEqual(loaded.accounts.map(\.id), [FixtureData.accountID, FixtureData.siblingID])
    XCTAssertNil(loaded.nextCursor)
  }

  func testRapidSearchRoundTripDoesNotReuseACancelledRead() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Initial search reached HTTP")
    let first = Mutex(true)
    let fixture = AccountPageFixture { request in
      guard AccountPageFixture.query("search", request) == "Personal",
        first.withLock({ value in
          let previous = value
          value = false
          return previous
        })
      else { return }
      started.fulfill()
      await gate.wait()
    }
    let composer = await makeComposer(fixture)
    defer {
      composer.close()
      gate.open()
    }
    let resources = try open(composer)
    resources.update(search: "Personal")
    let old = try resources.store.get(resources.page)
    addTeardownBlock {
      old.cancel()
      gate.open()
      _ = await old.result
    }
    await fulfillment(of: [started], timeout: 3)
    resources.update(search: "Personalx")
    resources.update(search: "Personal")
    let current = try await resources.store.get(resources.page).value
    XCTAssertEqual(current.accounts.map(\.id), [FixtureData.siblingID])
    gate.open()
    if case .success = await old.result { XCTFail("A cancelled account search returned data") }
    XCTAssertEqual(fixture.pageRequests.count, 2)
  }

  private func makeComposer(_ fixture: AccountPageFixture, thread: Bool = false) async
    -> ComposerConnectorStore
  {
    let composer = ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.http.client),
      authorizationService: ChatConnectorService(client: fixture.http.client),
      webURL: fixture.http.baseURL, graph: makeTestWorkspaceGraph(),
      threadID: thread ? FixtureData.threadID : nil, didFail: { _ in })
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
  private typealias FixtureData = ConnectorHTTPFixtures
  struct State: Sendable {
    var failMore = false
    var failFirst = false
    var requests: [URLRequest] = []
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
    state.withLock {
      $0.requests.filter { ["PUT", "POST", "DELETE"].contains($0.httpMethod ?? "") }
    }
  }

  init(
    custom: Bool = false,
    before: @escaping @Sendable (URLRequest) async -> Void = { _ in }
  ) {
    var initial = ConnectorAccessHTTPFixture.State()
    initial.custom = custom
    initial.enabled[FixtureData.siblingID] = true
    let backend = ConnectorAccessHTTPFixture(initial: initial, onUnhandledRequest: { XCTFail($0) })
    self.backend = backend
    let state = state
    http = ChatHTTPFixture { request in
      var request = request
      request.httpBody = chatRequestBody(request)
      state.withLock { $0.requests.append(request) }
      await before(request)
      let path = request.url!.path
      if path == "/api/connector-accounts/\(FixtureData.accountID)/deletion-impact" {
        return ChatHTTPResponse(
          body: """
            {"connectionId":"\(FixtureData.accountID)","explicitSelectionCount":0,"hasSibling":true}
            """)
      }
      if path == "/api/connector-accounts/connections" {
        let cursor = Self.query("cursor", request)
        let search = Self.query("search", request) ?? ""
        if state.withLock({ cursor == nil ? $0.failFirst : $0.failMore }) {
          return ChatHTTPResponse(
            status: 503, body: #"{"error":{"message":"Accounts temporarily unavailable"}}"#)
        }
        let defaultID = backend.state.withLock { $0.defaultID }
        let first = FixtureData.account(
          custom: custom, isDefault: defaultID == FixtureData.accountID)
        let second = FixtureData.account(
          id: FixtureData.siblingID, custom: custom, isDefault: defaultID == FixtureData.siblingID,
          label: "Personal account")
        let defaultAccount =
          defaultID.map { $0 == FixtureData.accountID ? first : second } ?? "null"
        let values: [String]
        if !search.isEmpty {
          values = [("Work account", first), ("Personal account", second)].filter {
            $0.0.localizedCaseInsensitiveContains(search)
          }.map(\.1)
        } else {
          values = cursor == nil ? [first] : [second]
        }
        let next = search.isEmpty && cursor == nil ? #""second""# : "null"
        return ChatHTTPResponse(
          body:
            "{\"connections\":[\(values.joined(separator: ","))],\"defaultConnection\":\(defaultAccount),\"nextCursor\":\(next)}"
        )
      }
      var forwarded = request
      forwarded.url = URL(
        string: request.url!.path + (request.url!.query.map { "?" + $0 } ?? ""),
        relativeTo: backend.http.baseURL)!
      let (data, response) = try await backend.http.session.data(for: forwarded)
      return ChatHTTPResponse(
        status: (response as! HTTPURLResponse).statusCode,
        body: try XCTUnwrap(String(data: data, encoding: .utf8)))
    }
  }

  static func query(_ name: String, _ request: URLRequest) -> String? {
    URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
      $0.name == name
    }?.value
  }
}
