import CCState
import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerConnectorDirectoryTests: XCTestCase {
  func testDiscoveryConsumersShareTheCanonicalFilteredRequest() async throws {
    let reads = Mutex(0)
    let gate = ModelResponseGate()
    let started = expectation(description: "Discovery reached HTTP")
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url?.path, "/api/connector-catalog/discovery")
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
      XCTAssertEqual(query?.first(where: { $0.name == "keyword" })?.value, "team chat")
      XCTAssertEqual(
        query?.first(where: { $0.name == "category" })?.value, "communication-collaboration")
      reads.withLock { $0 += 1 }
      started.fulfill()
      await gate.wait()
      return Self.discovery("Slack")
    }
    let resources = makeResources(fixture)
    defer {
      resources.close()
      gate.open()
    }
    resources.update(search: "team chat", category: "communication-collaboration")
    let first = try own(resources.store.get(resources.catalog))
    await fulfillment(of: [started], timeout: 3)
    let second = try own(resources.store.get(resources.catalog))
    gate.open()
    let firstValue = try await first.value
    let secondValue = try await second.value
    XCTAssertEqual(firstValue.connectors.first?.label, "Slack")
    XCTAssertEqual(secondValue.categoryConnectorCounts?["communication-collaboration"], 1)
    XCTAssertEqual(reads.withLock { $0 }, 1)
  }

  func testCustomSearchSharesItsReadAndDoesNotWaitForDiscovery() async throws {
    let gate = ModelResponseGate()
    let catalogStarted = expectation(description: "Slow discovery reached HTTP")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/connector-catalog/discovery":
        catalogStarted.fulfill()
        await gate.wait()
        return Self.discovery("Slack")
      case "/api/custom-connectors":
        reads.withLock { $0 += 1 }
        return Self.custom
      default:
        XCTFail(
          "Unhandled request: \(request.httpMethod ?? "") \(request.url?.absoluteString ?? "")")
        throw URLError(.unsupportedURL)
      }
    }
    let resources = makeResources(fixture)
    defer {
      resources.close()
      gate.open()
    }
    _ = try own(resources.store.get(resources.catalog))
    await fulfillment(of: [catalogStarted], timeout: 3)
    let custom = try own(resources.store.get(resources.customMatches))
    let all = try await custom.value
    XCTAssertEqual(all.map(\.displayName), ["Team API", "Build tools"])
    resources.update(tab: .custom, search: "TEAM")
    let filtered = try own(resources.store.get(resources.customMatches))
    let matches = try await filtered.value
    XCTAssertEqual(matches.map(\.displayName), ["Team API"])
    resources.update(tab: .custom, search: "nothing")
    let empty = try own(resources.store.get(resources.customMatches))
    let emptyValues = try await empty.value
    XCTAssertTrue(emptyValues.isEmpty)
    XCTAssertEqual(reads.withLock { $0 }, 1)
    gate.open()
  }

  func testSupersededSearchCancelsOriginalHTTPAndRejectsItsLateResult() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Old search reached HTTP")
    let cancelled = expectation(description: "Original search HTTP was cancelled")
    let fixture = ChatHTTPFixture { request in
      let keyword = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "keyword" })?.value
      if keyword == "old" {
        return await withTaskCancellationHandler {
          started.fulfill()
          await gate.wait()
          return Self.discovery("Old result")
        } onCancel: {
          cancelled.fulfill()
        }
      }
      XCTAssertEqual(keyword, "new")
      return Self.discovery("New result")
    }
    let resources = makeResources(fixture)
    defer {
      resources.close()
      gate.open()
    }
    resources.update(search: "old")
    let old = try own(resources.store.get(resources.catalog))
    await fulfillment(of: [started], timeout: 3)
    resources.update(search: "new")
    let next = try own(resources.store.get(resources.catalog))
    let current = try await next.value
    XCTAssertEqual(current.connectors.first?.label, "New result")
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    if case .success = await old.result { XCTFail("A retired search published old data") }
    let reused = try await resources.store.get(resources.catalog).value
    XCTAssertEqual(reused.connectors.first?.label, "New result")
  }

  func testRapidSearchRoundTripDoesNotReuseTheCancelledTask() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "First search reached HTTP")
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/connector-catalog/discovery"
      else { throw URLError(.unsupportedURL) }
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
      guard query?.first(where: { $0.name == "keyword" })?.value == "slack" else {
        throw URLError(.unsupportedURL)
      }
      let count = reads.withLock {
        $0 += 1
        return $0
      }
      if count == 1 {
        started.fulfill()
        await gate.wait()
      }
      return Self.discovery(count == 1 ? "Retired result" : "Fresh result")
    }
    let resources = makeResources(fixture)
    defer {
      resources.close()
      gate.open()
    }
    resources.update(search: "slack")
    let old = try own(resources.store.get(resources.catalog))
    await fulfillment(of: [started], timeout: 3)
    resources.update(search: "slackx")
    resources.update(search: "slack")
    let next = try own(resources.store.get(resources.catalog))
    let current = try await next.value
    XCTAssertEqual(current.connectors.first?.label, "Fresh result")
    gate.open()
    if case .success = await old.result { XCTFail("A cancelled query was reused") }
    XCTAssertEqual(reads.withLock { $0 }, 2)
  }

  func testRetryRefreshesOnlyTheSelectedEndpointAndKeepsFailuresUntilRetry() async throws {
    let catalogReads = Mutex(0)
    let customReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/connector-catalog/discovery":
        let count = catalogReads.withLock {
          $0 += 1
          return $0
        }
        if count == 1 {
          return ChatHTTPResponse(
            status: 503, body: #"{"error":{"message":"Catalog unavailable"}}"#)
        }
        return Self.discovery("Recovered catalog")
      case "/api/custom-connectors":
        customReads.withLock { $0 += 1 }
        return Self.custom
      default:
        XCTFail(
          "Unhandled request: \(request.httpMethod ?? "") \(request.url?.absoluteString ?? "")")
        throw URLError(.unsupportedURL)
      }
    }
    let resources = makeResources(fixture)
    defer { resources.close() }
    let first = try own(resources.store.get(resources.catalog))
    if case .success = await first.result { XCTFail("A failed read must remain an error") }
    let repeated = try own(resources.store.get(resources.catalog))
    if case .success = await repeated.result { XCTFail("Observing again is not a retry") }
    resources.update(tab: .custom)
    let custom = try own(resources.store.get(resources.customMatches))
    let customValues = try await custom.value
    XCTAssertEqual(customValues.count, 2)
    resources.update(tab: .discover)
    await resources.refresh()
    let recovered = try await resources.store.get(resources.catalog).value
    XCTAssertEqual(recovered.connectors.first?.label, "Recovered catalog")
    XCTAssertEqual(catalogReads.withLock { $0 }, 2)
    XCTAssertEqual(customReads.withLock { $0 }, 1)
  }

  func testReplacingTheComposerCancelsItsDirectoryAndIsolatesTheNewWorkspace() async throws {
    let gate = ModelResponseGate()
    let started = expectation(description: "Old workspace directory reached HTTP")
    let cancelled = expectation(description: "Old workspace HTTP was cancelled")
    let oldFixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/connector-catalog/discovery"
      else { throw URLError(.unsupportedURL) }
      return await withTaskCancellationHandler {
        started.fulfill()
        await gate.wait()
        return Self.discovery("Old workspace")
      } onCancel: {
        cancelled.fulfill()
      }
    }
    let old = makeComposer(oldFixture)
    defer {
      old.close()
      gate.open()
    }
    old.configure(agentID: "same-agent")
    old.openDirectory()
    let retired = try XCTUnwrap(old.directory)
    let pending = try own(retired.store.get(retired.catalog))
    await fulfillment(of: [started], timeout: 3)
    old.close()
    let nextFixture = ChatHTTPFixture { request in
      guard request.httpMethod == "GET", request.url?.path == "/api/connector-catalog/discovery"
      else { throw URLError(.unsupportedURL) }
      return Self.discovery("New workspace")
    }
    let next = makeComposer(nextFixture)
    defer { next.close() }
    next.configure(agentID: "same-agent")
    next.openDirectory()
    let resources = try XCTUnwrap(next.directory)
    let current = try own(resources.store.get(resources.catalog))
    let value = try await current.value
    XCTAssertEqual(value.connectors.first?.label, "New workspace")
    await fulfillment(of: [cancelled], timeout: 3)
    gate.open()
    if case .success = await pending.result { XCTFail("A retired workspace published its result") }
    let reused = try await resources.store.get(resources.catalog).value
    XCTAssertEqual(reused.connectors.first?.label, "New workspace")
    next.configure(agentID: "another-agent")
    XCTAssertThrowsError(try resources.store.get(resources.catalog))
  }

  private func makeResources(_ fixture: ChatHTTPFixture) -> ComposerConnectorDirectoryResources {
    ComposerConnectorDirectoryResources(
      service: ChatComposerAccess(client: fixture.client), didFail: { _ in })
  }

  private func makeComposer(_ fixture: ChatHTTPFixture) -> ComposerConnectorStore {
    ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.client),
      authorizationService: ChatConnectorService(client: fixture.client), webURL: fixture.baseURL,
      didFail: { _ in })
  }

  private func own<Value: Sendable>(_ task: Task<Value, Error>) -> Task<Value, Error> {
    addTeardownBlock {
      task.cancel()
      _ = await task.result
    }
    return task
  }

  nonisolated private static func discovery(_ label: String) -> ChatHTTPResponse {
    ChatHTTPResponse(
      body: """
        {"connectors":[{"slug":"slack","label":"\(label)","description":"Team communication","category":"communication-collaboration","authMethods":[],"permissionSummary":{"hasPermissions":false}}],"totalConnectorCount":1,"categoryConnectorCounts":{"communication-collaboration":1}}
        """)
  }

  nonisolated private static var custom: ChatHTTPResponse {
    ChatHTTPResponse(
      body:
        #"{"connectors":[{"id":"a","slug":"team-api","displayName":"Team API","fields":[],"authMode":"secret"},{"id":"b","slug":"build-tools","displayName":"Build tools","fields":[],"authMode":"secret"}]}"#
    )
  }
}
