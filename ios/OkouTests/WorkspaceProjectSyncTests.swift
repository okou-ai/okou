import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class WorkspaceProjectSyncTests: XCTestCase {
  func testStartupAndHealthyForegroundCyclesShareTheSubscribedProjectBaseline() async throws {
    let fixture = try makeFixture()
    try await fixture.start()
    XCTAssertEqual(fixture.reads, 1)

    for _ in 0..<3 {
      fixture.workspace.setPhase(.background)
      fixture.workspace.setPhase(.active)
      await fixture.workspace.resumePendingRefresh()?.value
      XCTAssertEqual(fixture.workspace.projects.projects.first?.name, "Launch")
      XCTAssertEqual(fixture.reads, 1)
    }
  }

  func testSharedListNotificationsAndManualRetryStillReadProjectEvents() async throws {
    let fixture = try makeFixture()
    try await fixture.start()
    fixture.setRemoteVersion(1)
    try fixture.server.notify("threadListChanged", channel: fixture.channel)
    try await waitForBusinessResult {
      fixture.workspace.projects.projects.first?.name == "Release"
    }
    await fixture.workspace.resumePendingRefresh()?.value
    XCTAssertEqual(fixture.reads, 2)

    await fixture.workspace.refresh()
    XCTAssertEqual(fixture.reads, 3)
    fixture.setRemoteVersion(2)
    try fixture.server.notify("threadListChanged", channel: fixture.channel)
    try await waitForBusinessResult { fixture.workspace.projects.projects.isEmpty }
    await fixture.workspace.resumePendingRefresh()?.value
    XCTAssertEqual(fixture.reads, 4)
  }

  func testARealGapWhileBackgroundedSurvivesTheHealthyConnectionCallback() async throws {
    let fixture = try makeFixture()
    try await fixture.start()
    fixture.workspace.setPhase(.background)
    try fixture.realtime.detach(fixture.channel)
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .unavailable }
    fixture.setRemoteVersion(1)
    try fixture.realtime.attach(fixture.channel)
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .connected }

    fixture.workspace.setPhase(.active)
    await fixture.workspace.resumePendingRefresh()?.value

    XCTAssertEqual(fixture.workspace.projects.projects.first?.name, "Release")
    XCTAssertEqual(fixture.reads, 2)
  }

  func testEarlyHTTPFallbackCatchesUpAgainAfterSubscriptionsAreRestored() async throws {
    let fixture = try makeFixture()
    try await fixture.start()
    let disconnected = expectation(description: "The real SDK observes transport loss")
    fixture.workspace.setPhase(.background)
    try fixture.realtime.disconnectTransport(observed: disconnected)
    await fulfillment(of: [disconnected], timeout: 3)
    fixture.workspace.setPhase(.active)
    let refresh = try XCTUnwrap(fixture.workspace.resumePendingRefresh())
    fixture.allowHTTP()
    await refresh.value
    XCTAssertEqual(fixture.reads, 2)

    fixture.setRemoteVersion(1)
    try fixture.realtime.reconnectTransport()
    try await waitForBusinessResult {
      fixture.workspace.projects.projects.first?.name == "Release"
    }
    await fixture.workspace.resumePendingRefresh()?.value
    XCTAssertEqual(fixture.reads, 3)
  }

  func testInitialHTTPFallbackStillReadsChangesMissedBeforeTheFirstSubscription() async throws {
    let fixture = try makeFixture()
    fixture.allowHTTP()
    await fixture.workspace.projects.activate()
    XCTAssertEqual(fixture.reads, 1)
    fixture.setRemoteVersion(1)

    try await fixture.start()

    XCTAssertEqual(fixture.workspace.projects.projects.first?.name, "Release")
    XCTAssertEqual(fixture.reads, 2)
  }

  func testContinuousTransportResumeBeforeTheDeadlineKeepsTheExistingProjectRead() async throws {
    let fixture = try makeFixture()
    try await fixture.start()
    let disconnected = expectation(description: "The SDK observes a recoverable transport loss")
    fixture.workspace.setPhase(.background)
    try fixture.realtime.disconnectTransport(observed: disconnected)
    await fulfillment(of: [disconnected], timeout: 3)
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .unavailable }
    fixture.workspace.setPhase(.active)
    let refresh = try XCTUnwrap(fixture.workspace.resumePendingRefresh())

    fixture.server.attachAutomatically(resumed: true)
    try fixture.realtime.reconnectTransport()
    await refresh.value
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .connected }
    await fixture.workspace.resumePendingRefresh()?.value

    XCTAssertEqual(fixture.workspace.projects.projects.first?.name, "Launch")
    XCTAssertEqual(fixture.reads, 1)
  }

  func testFirstSubscriptionWhileBackgroundedRetainsTheEarlyHTTPReadDebt() async throws {
    let fixture = try makeFixture()
    fixture.allowHTTP()
    await fixture.workspace.projects.activate()
    XCTAssertEqual(fixture.reads, 1)
    fixture.workspace.setPhase(.background)
    fixture.setRemoteVersion(1)
    try await fixture.start(backgrounded: true)

    fixture.workspace.setPhase(.active)
    await fixture.workspace.resumePendingRefresh()?.value

    XCTAssertEqual(fixture.workspace.projects.projects.first?.name, "Release")
    XCTAssertEqual(fixture.reads, 2)
  }

  func testClosingWhileWaitingForSubscriptionsCancelsWithoutProjectHTTP() async throws {
    let waiting = expectation(description: "Project activation awaits subscription readiness")
    let fixture = try makeFixture(waiting: waiting)
    let activation = Task { await fixture.workspace.projects.activate() }
    await fulfillment(of: [waiting], timeout: 3)

    await fixture.workspace.close().value
    await activation.value

    XCTAssertEqual(fixture.reads, 0)
    XCTAssertTrue(fixture.workspace.projects.projects.isEmpty)
  }

  private func makeFixture(waiting: XCTestExpectation? = nil) throws -> ProjectSyncFixture {
    let directory = CacheTestDirectory(owner: self)
    let fixture = try ProjectSyncFixture(owner: self, directory: directory, waiting: waiting)
    addTeardownBlock { @MainActor in await fixture.close() }
    return fixture
  }
}

@MainActor
private final class ProjectSyncFixture {
  private unowned let owner: XCTestCase
  private let initialDeadline = ModelResponseGate()
  private let recoveryDeadline = ModelResponseGate()
  private let state = ProjectSyncFixtureState()
  let realtime: LoopbackRealtimeFixture
  private let http: ChatHTTPFixture
  private let bootstrap: WorkspaceReadBootstrap
  private let cache: ChatCache
  private let userID = "project-user-\(UUID().uuidString)"
  private let workspaceID = "project-workspace-\(UUID().uuidString)"
  var channel: String { "user-org:\(userID):\(workspaceID)" }
  var server: RealtimeHTTPFixture { realtime.server }
  var reads: Int { state.projectReads.withLock { $0 } }

  lazy var workspace = WorkspaceStore(
    client: http.client, webURL: http.baseURL, cache: cache,
    projectBootstrap: bootstrap, createRealtime: realtime.factory)

  init(owner: XCTestCase, directory: CacheTestDirectory, waiting: XCTestExpectation?) throws {
    self.owner = owner
    let initialDeadline = initialDeadline
    let recoveryDeadline = recoveryDeadline
    let state = state
    bootstrap = WorkspaceReadBootstrap {
      waiting?.fulfill()
      if state.recovering.withLock({ $0 }) {
        await recoveryDeadline.wait()
      } else {
        await initialDeadline.wait()
      }
    }
    realtime = try LoopbackRealtimeFixture(clientID: userID)
    let token = try JSONSerialization.data(withJSONObject: [
      "keyName": "fixture.key", "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
      "ttl": 3_600_000, "nonce": "fixture-nonce", "mac": "ZmFrZQ==",
      "clientId": userID, "capability": "{\"*\":[\"subscribe\"]}"
    ])
    http = ChatHTTPFixture(
      onUnhandledRequest: { XCTFail($0) },
      handler: { request in
        switch (request.httpMethod, request.url?.path) {
        case ("POST", "/api/realtime/token"):
          return ChatHTTPResponse(body: String(data: token, encoding: .utf8)!)
        case ("GET", "/api/chat-threads/snapshot"):
          return ChatHTTPResponse(
            body: #"{"chatThreads":[],"latestEventId":null,"latestSeqId":null}"#)
        case ("GET", "/api/chat-threads/events"):
          return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
        case ("GET", "/api/indicators"):
          return ChatHTTPResponse(body: #"{"threads":{},"unreadAt":{}}"#)
        case ("GET", "/api/projects/snapshot"):
          return ChatHTTPResponse(
            body: """
              {"latestEventId":null,"latestSeqId":0,"projects":[{
              "id":"30000000-0000-4000-8000-000000000071","name":"Launch",
              "createdAt":"2026-11-09T01:00:00Z","updatedAt":"2026-11-09T01:00:00Z"}]}
              """)
        case ("GET", "/api/projects/events"):
          state.projectReads.withLock { $0 += 1 }
          let components = request.url.flatMap {
            URLComponents(url: $0, resolvingAgainstBaseURL: false)
          }
          let cursor = components?.queryItems?.first { $0.name == "sinceSeqId" }?.value
          let since = Int(cursor ?? "0") ?? 0
          let version = state.remote.withLock { $0 }
          let events = (1...2).filter { $0 > since && $0 <= version }.map { sequence in
            """
            {"id":"30000000-0000-4000-8000-00000000008\(sequence)","seqId":\(sequence),
            "projectId":"30000000-0000-4000-8000-000000000071",
            "kind":"\(sequence == 1 ? "renamed" : "deleted")","name":"Release",
            "createdAt":"2026-11-09T02:00:00Z"}
            """
          }.joined(separator: ",")
          return ChatHTTPResponse(body: "{\"events\":[\(events)],\"hasMore\":false}")
        default: throw URLError(.unsupportedURL)
        }
      })
    cache = directory.cache(
      scope: ChatCacheScope(apiBaseURL: http.baseURL, userID: userID, workspaceID: workspaceID))
  }

  func start(backgrounded: Bool = false) async throws {
    try await realtime.start()
    server.attachAutomatically()
    if !backgrounded { workspace.setPhase(.active) }
    async let projects: Void = workspace.projects.activate()
    await workspace.start(userID: userID, workspaceID: workspaceID)
    await projects
    try await owner.waitForBusinessResult { self.workspace.connectionStatus == .connected }
    await workspace.resumePendingRefresh()?.value
    XCTAssertEqual(workspace.connectionStatus, .connected)
    state.recovering.withLock { $0 = true }
  }

  func setRemoteVersion(_ version: Int) { state.remote.withLock { $0 = version } }

  func allowHTTP() {
    initialDeadline.open()
    recoveryDeadline.open()
  }

  func close() async {
    allowHTTP()
    await workspace.close().value
    realtime.stop()
  }
}

private final class ProjectSyncFixtureState: Sendable {
  let remote = Mutex(0)
  let projectReads = Mutex(0)
  let recovering = Mutex(false)
}
