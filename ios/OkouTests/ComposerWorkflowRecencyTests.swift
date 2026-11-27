import CCState
import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

/// The slash menu ranks by the member's server history, which accepted uses update.
@MainActor
final class ComposerWorkflowRecencyTests: XCTestCase {
  func testServerHistoryRanksSlashMenuAndReplacesDeviceCache() async throws {
    let fixture = recencyFixture()
    fixture.state.value.withLock { $0.recentWorkflowIDs = ["morning"] }
    let storage = try deviceStorage(fixture, history: ["release"])
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { source.close() }

    let order = try await slashMenu(source)
    XCTAssertEqual(order, ["morning", "release"])
    XCTAssertEqual(fixture.state.value.withLock { $0.recentWorkflowIDs }, ["morning"])
    let reopened = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { reopened.close() }
    XCTAssertEqual(reopened.recentIDs(), ["morning"])
  }

  func testDeviceHistoryInitializesOnlyAnUninitializedServerHistory() async throws {
    let fixture = recencyFixture()
    let storage = try deviceStorage(fixture, history: ["release"])
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { source.close() }

    let imported = try await slashMenu(source)
    XCTAssertEqual(imported, ["release", "morning"])
    XCTAssertEqual(fixture.state.value.withLock { $0.recentWorkflowIDs }, ["release"])
    // An initialized empty history is canonical; device history never replaces it.
    fixture.state.value.withLock { $0.recentWorkflowIDs = [] }
    let canonical = try await slashMenu(source)
    XCTAssertEqual(canonical, ["morning", "release"])
    XCTAssertEqual(fixture.state.value.withLock { $0.recentWorkflowIDs }, [])
    XCTAssertEqual(source.recentIDs(), [])
  }

  func testFailedHistoryReadKeepsDeviceOrder() async throws {
    let fixture = recencyFixture(recentWorkflows: { request in
      request.httpMethod == "GET"
        ? ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#) : nil
    })
    let storage = try deviceStorage(fixture, history: ["release"])
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { source.close() }

    let order = try await slashMenu(source)
    XCTAssertEqual(order, ["release", "morning"])
    XCTAssertEqual(source.recentIDs(), ["release"])
  }

  func testMenuReadWhileUseIsUnconfirmedKeepsDevicePromotion() async throws {
    let gate = HTTPResponseGate()
    addTeardownBlock { gate.open() }
    let started = expectation(description: "Accepted use reached HTTP")
    let fixture = recencyFixture(recentWorkflows: { request in
      if request.url?.path == "/api/workflows/recent/use" {
        started.fulfill()
        await gate.wait()
      }
      return nil
    })
    fixture.state.value.withLock { $0.recentWorkflowIDs = ["morning"] }
    let storage = try deviceStorage(fixture, history: ["morning"])
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { source.close() }

    source.recordUse(["release"])
    await fulfillment(of: [started], timeout: 3)
    let order = try await slashMenu(source)
    XCTAssertEqual(order, ["release", "morning"])
    XCTAssertEqual(source.recentIDs(), ["release", "morning"])
    gate.open()
    try await eventually {
      fixture.state.value.withLock { $0.recentWorkflowIDs } == ["release", "morning"]
    }
    let canonical = try await fixture.http.client.recentComposerWorkflowIDs()
    XCTAssertEqual(canonical, ["release", "morning"])
  }

  func testLateHistoryReadCannotReplaceAConfirmedUse() async throws {
    let use = HTTPResponseGate()
    let read = HTTPResponseGate()
    addTeardownBlock {
      use.open()
      read.open()
    }
    let writing = Mutex(false)
    let useStarted = expectation(description: "Accepted use reached HTTP")
    let readStarted = expectation(description: "Menu read captured history before the use")
    let fixture = recencyFixture(recentWorkflows: { request in
      if request.url?.path == "/api/workflows/recent/use" {
        writing.withLock { $0 = true }
        useStarted.fulfill()
        await use.wait()
      } else if request.httpMethod == "GET", writing.withLock({ $0 }) {
        readStarted.fulfill()
        await read.wait()
        return ChatHTTPResponse(body: #"{"workflowIds":["morning"]}"#)
      }
      return nil
    })
    fixture.state.value.withLock { $0.recentWorkflowIDs = ["morning"] }
    let storage = try deviceStorage(fixture, history: [])
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { source.close() }

    source.recordUse(["release"])
    await fulfillment(of: [useStarted], timeout: 3)
    let menu = Task { try await self.slashMenu(source) }
    addTeardownBlock {
      menu.cancel()
      read.open()
      _ = await menu.result
    }
    await fulfillment(of: [readStarted], timeout: 3)
    use.open()
    // Only the confirmed write can add the server's existing history to this device.
    try await eventually { source.recentIDs() == ["release", "morning"] }
    read.open()
    let order = try await menu.value
    XCTAssertEqual(order, ["release", "morning"])
    XCTAssertEqual(source.recentIDs(), ["release", "morning"])
  }

  func testFirstAcceptedUseImportsDeviceHistoryBeforeInitializingServer() async throws {
    let fixture = recencyFixture()
    let storage = try deviceStorage(fixture, history: ["morning"])
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: storage, didFail: { _ in })
    defer { source.close() }

    // A restored draft can send without ever opening the slash menu.
    source.recordUse(["release"])
    try await eventually {
      fixture.state.value.withLock { $0.recentWorkflowIDs } == ["release", "morning"]
    }
    let canonical = try await fixture.http.client.recentComposerWorkflowIDs()
    XCTAssertEqual(canonical, ["release", "morning"])
    XCTAssertEqual(source.recentIDs(), ["release", "morning"])
  }

  func testAcceptedUsesReachServerInOrderAfterAFailedWrite() async throws {
    let writes = RecencyWriteCount()
    let fixture = recencyFixture(recentWorkflows: { request in
      guard request.url?.path == "/api/workflows/recent/use" else { return nil }
      let attempt = writes.value.withLock {
        $0 += 1
        return $0
      }
      return attempt == 1
        ? ChatHTTPResponse(status: 503, body: #"{"error":{"message":"Try again"}}"#) : nil
    })
    let source = ComposerWorkflowSource(
      client: fixture.http.client, storage: nil, didFail: { _ in })
    defer { source.close() }

    source.recordUse(["release"])
    source.recordUse(["morning"])
    source.recordUse(["release"])
    XCTAssertEqual(source.recentIDs(), ["release", "morning"])
    try await eventually {
      fixture.state.value.withLock { $0.recentWorkflowIDs } == ["release", "morning"]
    }
    XCTAssertEqual(writes.value.withLock { $0 }, 3)
  }
}

@MainActor
extension ComposerWorkflowRecencyTests {
  private func recencyFixture(
    recentWorkflows: @escaping @Sendable (URLRequest) async throws -> ChatHTTPResponse? = { _ in
      nil
    }
  ) -> AttachmentFlowFixture {
    AttachmentFlowFixture(
      workflows: { _ in ChatHTTPResponse(body: recencyCatalog) }, recentWorkflows: recentWorkflows)
  }

  /// Device history as the device-only app version persisted it, before any synchronization.
  private func deviceStorage(_ fixture: AttachmentFlowFixture, history: [String]) throws
    -> ChatDraftStorage
  {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let storage = ChatDraftStorage(
      scope: ChatCacheScope(apiBaseURL: fixture.http.baseURL, userID: "user", workspaceID: "one"),
      directory: directory)
    try storage.save(history, key: "recent-workflows")
    return storage
  }

  /// Opens the slash menu once and returns its Workflow order for an empty query.
  private func slashMenu(_ source: ComposerWorkflowSource) async throws -> [String] {
    let resources = ComposerWorkflowResources(graph: makeTestWorkspaceGraph())
    defer { resources.dismiss() }
    resources.update(query: "")
    resources.reload(source: source)
    return try await resources.store.get(resources.matches).value.values.map(\.id)
  }
}

private let recencyCatalog =
  #"[{"id":"release","name":"release","displayName":null,"description":null},{"id":"morning","name":"morning-brief","displayName":null,"description":null}]"#

private final class RecencyWriteCount: Sendable { let value = Mutex(0) }
