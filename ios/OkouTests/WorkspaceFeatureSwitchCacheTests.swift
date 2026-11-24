import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceFeatureSwitchCacheTests: XCTestCase {
  func testRelaunchUsesScopedSwitchesWhileRefreshingThenReplacesTheWholeSnapshot() async throws {
    let directory = CacheTestDirectory(owner: self)
    let reads = Mutex(0)
    let refresh = ModelResponseGate()
    let began = expectation(description: "The reopened workspace requested fresh switches")
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/feature-switches" else {
        return try XCTUnwrap(ModelHTTPFixtures.response(request.url!.path))
      }
      let read = reads.withLock {
        $0 += 1
        return $0
      }
      switch read {
      case 1:
        return ChatHTTPResponse(
          body: #"{"effectiveSwitches":{"followupPlaceholder":true,"composerVoiceMessages":true}}"#)
      case 2:
        began.fulfill()
        await refresh.wait()
        return ChatHTTPResponse(body: #"{"effectiveSwitches":{}}"#)
      default:
        throw URLError(.notConnectedToInternet)
      }
    }
    let scope = ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "org")
    func open() -> WorkspaceStore {
      WorkspaceStore(
        client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope),
        readRetrySleep: { _ in })
    }
    let first = open()
    _ = try await first.settingsResources.store.get(first.settingsResources.featureSwitches).value
    await first.close().value

    let reopened = open()
    let resources = reopened.settingsResources
    let live = try resources.store.get(resources.featureSwitches)
    let available = expectation(description: "The cached switches are usable before HTTP returns")
    let useCache = Task {
      await reopened.newModelSelection.open()
      let switches = try await resources.availableFeatureSwitches()
      XCTAssertTrue(reopened.modelStore.usesFollowupPlaceholder)
      XCTAssertEqual(switches.effectiveSwitches["composerVoiceMessages"], true)
      XCTAssertEqual(reopened.modelStore.configuration?.switches, switches.effectiveSwitches)
      XCTAssertTrue(reopened.newModelSelection.canSend)
      available.fulfill()
    }
    await fulfillment(of: [began, available], timeout: 4)
    refresh.open()
    try await useCache.value
    _ = try await live.value
    XCTAssertFalse(reopened.modelStore.usesFollowupPlaceholder)
    XCTAssertEqual(reopened.modelStore.configuration?.switches, [:])
    XCTAssertEqual(reads.withLock { $0 }, 2)
    await reopened.close().value

    let offline = open()
    defer { offline.close() }
    let pending = try offline.settingsResources.store.get(offline.settingsResources.featureSwitches)
    let beforeFailure = try await offline.settingsResources.availableFeatureSwitches()
    XCTAssertEqual(beforeFailure.effectiveSwitches, [:])
    guard case .failure = await pending.result else { return XCTFail("Expected offline refresh") }
    XCTAssertEqual(offline.modelStore.lastKnownFeatureSwitches?.effectiveSwitches, [:])
    await offline.close().value
    let saved = await ChatSync(client: fixture.client, cache: directory.cache(scope: scope))
      .cachedFeatureSwitches()
    XCTAssertEqual(saved?.effectiveSwitches, [:])
    let otherAPI = URL(string: "https://different.example.invalid")!
    for other in [
      ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "other", workspaceID: "org"),
      ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "other"),
      ChatCacheScope(apiBaseURL: otherAPI, userID: "user", workspaceID: "org")
    ] {
      let cached = await ChatSync(client: fixture.client, cache: directory.cache(scope: other))
        .cachedFeatureSwitches()
      XCTAssertNil(cached)
    }
  }
}
