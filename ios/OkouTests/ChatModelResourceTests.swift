import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatModelResourceTests: XCTestCase {
  func testOverlappingComposersStartupAndUsageShareModelReads() async throws {
    for (reconnects, cancelsWaiter) in [(false, false), (true, false), (false, true)] {
      let gate = ModelResponseGate()
      defer { gate.open() }
      let began = expectation(
        description: "Initial model requests started, reconnect: \(reconnects)")
      began.expectedFulfillmentCount = 4
      let requests = Mutex<[String: Int]>([:])
      let fixture = ChatHTTPFixture { request in
        let path = request.url!.path
        let count = requests.withLock { counts in
          counts[path, default: 0] += 1
          return counts[path, default: 0]
        }
        if count == 1 { began.fulfill() }
        if path == "/api/model-catalog" { await gate.wait() }
        var result = try XCTUnwrap(ModelHTTPFixtures.response(path))
        if reconnects && path == "/api/user-model-preference" && count > 1 {
          // This change happened before subscription restoration, so no notification arrives.
          result.body = result.body.replacingOccurrences(
            of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"claude-model\"")
        }
        return result
      }
      let models = ChatModelStore(
        client: fixture.client, webURL: fixture.baseURL, didFail: { _ in })
      let first = ChatModelSelectionStore(models: models)
      let second = ChatModelSelectionStore(models: models)
      defer {
        first.close()
        second.close()
        models.close()
      }
      let initial = Task.immediate { await first.open() }
      defer { initial.cancel() }
      await fulfillment(of: [began], timeout: 3)
      let anotherComposer = Task.immediate { await second.open() }
      let readiness: Task<Void, Never>? =
        reconnects ? Task.immediate { await models.refresh() } : nil
      let usage = Task.immediate { await models.loadUsageCatalog() }
      defer {
        anotherComposer.cancel()
        readiness?.cancel()
        usage.cancel()
      }
      if cancelsWaiter { anotherComposer.cancel() }
      gate.open()
      await initial.value
      await anotherComposer.value
      await readiness?.value
      await usage.value
      XCTAssertEqual(first.selection.model, reconnects ? "claude-model" : "codex-model")
      XCTAssertEqual(second.selection.model, reconnects ? "claude-model" : "codex-model")
      XCTAssertEqual(models.usageCatalog?.name("codex-model"), "Codex Example")
      let observed = requests.withLock { $0 }
      XCTAssertEqual(observed, initialRequests.mapValues { $0 * (reconnects ? 2 : 1) })
    }
  }

  func testRealtimeChangesReloadOnlyTheirModelResources() async throws {
    let requests = Mutex<[String: Int]>([:])
    let changed = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      requests.withLock { $0[path, default: 0] += 1 }
      var result = try XCTUnwrap(ModelHTTPFixtures.response(path))
      if changed.withLock({ $0 }) && path == "/api/user-model-preference" {
        result.body = result.body.replacingOccurrences(
          of: "\"selectedModel\":\"codex-model\"", with: "\"selectedModel\":\"claude-model\"")
      }
      return result
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.newModelSelection.open()
    changed.withLock { $0 = true }
    await workspace.refresh([.modelPreference])
    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
    var expected = initialRequests
    expected["/api/user-model-preference"] = 2
    XCTAssertEqual(requests.withLock { $0 }, expected)
    await workspace.refresh([.runModels])
    XCTAssertEqual(workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertEqual(
      workspace.modelStore.configuration?.catalog.name("claude-model"), "Claude Example")
    expected["/api/run-models"] = 2
    expected["/api/model-catalog"] = 2
    let observed = requests.withLock { $0 }
    XCTAssertEqual(observed, expected)
  }

  func testTransientPreferenceFailureRetriesWithoutReloadingSuccessfulMetadata() async throws {
    let requests = Mutex<[String: Int]>([:])
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      let count = requests.withLock { counts in
        counts[path, default: 0] += 1
        return counts[path, default: 0]
      }
      if path == "/api/user-model-preference" && count == 1 {
        return ChatHTTPResponse(status: 503, body: "{\"error\":{\"message\":\"Try again\"}}")
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(path))
    }
    let models = ChatModelStore(
      client: fixture.client, webURL: fixture.baseURL, readRetrySleep: { _ in }, didFail: { _ in })
    let selection = ChatModelSelectionStore(models: models)
    defer {
      selection.close()
      models.close()
    }
    await selection.open()
    XCTAssertEqual(selection.selection.model, "codex-model")
    XCTAssertTrue(selection.canSend)
    var expected = initialRequests
    expected["/api/user-model-preference"] = 2
    let observed = requests.withLock { $0 }
    XCTAssertEqual(observed, expected)
  }

  func testNavigationAndModelsStartIndependentWorkspaceReadsTogether() async throws {
    let gate = ModelResponseGate()
    let began = expectation(description: "Independent workspace reads have all started")
    began.expectedFulfillmentCount = 6
    let requests = Mutex<[String: Int]>([:])
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      let count = requests.withLock { counts in
        counts[path, default: 0] += 1
        return counts[path, default: 0]
      }
      if count == 1 { began.fulfill() }
      await gate.wait()
      if path == "/api/agents" {
        return ChatHTTPResponse(
          body:
            "[{\"agentId\":\"\(ModelHTTPFixtures.agentID)\",\"displayName\":\"Shared agent\",\"isDefaultAgent\":true}]"
        )
      }
      if path == "/api/user-preferences" {
        return ChatHTTPResponse(status: 409, body: #"{"error":{"message":"No preferences"}}"#)
      }
      return try XCTUnwrap(ModelHTTPFixtures.response(path))
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    let navigation = Task { await workspace.refreshNavigation() }
    let models = Task { await workspace.modelStore.load() }
    addTeardownBlock { @MainActor in
      workspace.close()
      navigation.cancel()
      models.cancel()
      gate.open()
      await navigation.value
      await models.value
    }
    await fulfillment(of: [began], timeout: 3)
    gate.open()
    await navigation.value
    await models.value
    XCTAssertEqual(workspace.currentAgentName, "Shared agent")
    XCTAssertEqual(workspace.newModelSelection.selection.model, "codex-model")
    XCTAssertNil(workspace.list.navigationError)
    var expected = initialRequests
    expected["/api/agents"] = 1
    expected["/api/user-preferences"] = 1
    XCTAssertEqual(requests.withLock { $0 }, expected)
  }

  private var initialRequests: [String: Int] {
    [
      "/api/user-model-preference": 1, "/api/run-models": 1,
      "/api/model-catalog": 1, "/api/feature-switches": 1,
    ]
  }
}
