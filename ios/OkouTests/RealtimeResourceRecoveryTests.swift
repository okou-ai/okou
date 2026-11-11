import Ably
import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class RealtimeResourceRecoveryTests: XCTestCase {
  func testInitialSubscriptionsCatchUpOnceAndReadChangesMissedBeforeAttachment() async throws {
    let fixture = try await makeFixture()
    await fixture.models.load()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "codex-model")
    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    try await attach(fixture)
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    let requests = fixture.metadata.requests.withLock { $0 }
    XCTAssertEqual(requests, fixture.expectedRequests(rounds: 2))
  }

  func testAttachedContinuityGapReadsFreshModelSettings() async throws {
    let fixture = try await makeFixture()
    await fixture.models.load()
    try await attach(fixture)
    let published = expectation(description: "Settings changed during a channel continuity gap")
    fixture.publication = ("claude-model", published)
    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    try fixture.server.attached(fixture.workspaceChannel)
    await fulfillment(of: [published], timeout: 3)
    await fixture.drain()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 3))
  }

  func testFailedChannelDoesNotStrandCatchupForTheOtherSubscription() async throws {
    let fixture = try await makeFixture()
    await fixture.models.load()
    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    let published = expectation(description: "Settings recover despite a failed subscription")
    fixture.publication = ("claude-model", published)
    fixture.service.start()
    await fulfillment(of: [fixture.attachRequests], timeout: 3)
    try fixture.server.fail(fixture.workspaceChannel)
    await fulfillment(of: [published], timeout: 3)
    await fixture.drain()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    try fixture.server.attached(fixture.userChannel)
  }

  func testSingleChannelReattachmentReadsChangesMadeWhileDetached() async throws {
    let fixture = try await makeFixture()
    await fixture.models.load()
    try await attach(fixture)
    let channel = try XCTUnwrap(fixture.sdk).channels.get(fixture.workspaceChannel)
    let detached = expectation(description: "The SDK confirms this channel is detached")
    channel.once(.detached) { _ in detached.fulfill() }
    channel.detach()
    await fulfillment(of: [detached], timeout: 3)
    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    let published = expectation(description: "Reattached subscription publishes canonical settings")
    fixture.publication = ("claude-model", published)
    fixture.server.attachAutomatically()
    channel.attach()
    await fulfillment(of: [published], timeout: 3)
    await fixture.drain()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 3))
  }

  func testTransportReconnectionRecoversChangesWithoutAnotherNotification() async throws {
    let fixture = try await makeFixture()
    await fixture.models.load()
    try await attach(fixture)
    let disconnected = expectation(description: "SDK reports the fixture transport is unavailable")
    fixture.unavailable = disconnected
    try fixture.server.disconnect()
    await fulfillment(of: [disconnected], timeout: 3)
    XCTAssertEqual(fixture.sdk?.connection.state, .disconnected)
    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    let published = expectation(description: "Resumed transport reads the missed server change")
    fixture.publication = ("claude-model", published)
    fixture.server.attachAutomatically()
    fixture.service.retry()
    await fulfillment(of: [published], timeout: 3)
    await fixture.drain()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 3))
  }

  func testRetryRestoresFailedSubscriptionAndReadsMissedChanges() async throws {
    let fixture = try await makeFixture()
    await fixture.models.load()
    try await attach(fixture)
    let unavailable = expectation(description: "The failed subscription is reported")
    fixture.unavailable = unavailable
    try fixture.server.fail(fixture.workspaceChannel)
    await fulfillment(of: [unavailable], timeout: 3)

    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    let published = expectation(description: "Retry restores canonical settings")
    fixture.publication = ("claude-model", published)
    let connected = expectation(description: "Both subscriptions recover")
    fixture.connected = connected
    fixture.server.attachAutomatically()
    fixture.service.retry()

    await fulfillment(of: [connected, published], timeout: 3)
    await fixture.drain()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 3))
  }

  private func makeFixture() async throws -> RealtimeResourceHarness {
    let fixture = try RealtimeResourceHarness(owner: self)
    addTeardownBlock { @MainActor in
      await fixture.close()
      XCTAssertEqual(fixture.server.errors, [])
    }
    try await fixture.prepare()
    return fixture
  }

  private func attach(_ fixture: RealtimeResourceHarness) async throws {
    let connected = expectation(description: "Both durable subscriptions are connected")
    fixture.connected = connected
    fixture.service.start()
    await fulfillment(of: [fixture.attachRequests], timeout: 3)
    try fixture.server.attached(fixture.workspaceChannel)
    try fixture.server.attached(fixture.userChannel)
    await fulfillment(of: [connected], timeout: 3)
    await fixture.drain()
  }
}

@MainActor
private final class RealtimeResourceHarness {
  let server: RealtimeHTTPFixture
  let attachRequests: XCTestExpectation
  let models: ChatModelStore
  let http: ChatHTTPFixture
  let metadata: RealtimeMetadataFixture
  let userID: String
  let workspaceID: String
  var workspaceChannel: String { "user-org:\(userID):\(workspaceID)" }
  var userChannel: String { "user:\(userID)" }
  private var port: UInt16 = 0
  private var tasks: [Task<Void, Never>] = []
  var sdk: ARTRealtime?
  var connected: XCTestExpectation?
  var unavailable: XCTestExpectation?
  var publication: (String, XCTestExpectation)?

  lazy var service = RealtimeService(
    userID: userID, workspaceID: workspaceID,
    tokenProvider: { [userID] in
      let timestamp = Int64(Date().timeIntervalSince1970 * 1000)
      return try JSONSerialization.data(withJSONObject: [
        "keyName": "fixture.key", "timestamp": timestamp, "ttl": 3_600_000,
        "nonce": "fixture-nonce", "mac": "ZmFrZQ==", "clientId": userID,
        "capability": "{\"*\":[\"subscribe\"]}",
      ])
    },
    onChange: { [weak self] change in
      guard let self else { return }
      tasks.append(
        Task.immediate { @MainActor [self] in
          await models.refresh([change])
          if let (model, expectation) = publication,
            models.configuration?.defaultSelection.model == model
          {
            publication = nil
            expectation.fulfill()
          }
        })
    },
    onConnection: { [weak self] status in
      guard let self else { return }
      if status == .connected {
        let expectation = connected
        connected = nil
        expectation?.fulfill()
      } else if status == .unavailable {
        let expectation = unavailable
        unavailable = nil
        expectation?.fulfill()
      }
    },
    createRealtime: { [unowned self] options in
      options.realtimeHost = "127.0.0.1"
      options.restHost = "127.0.0.1"
      options.port = Int(port)
      options.tls = false
      options.useBinaryProtocol = false
      options.fallbackHosts = []
      // The test explicitly reconnects through the public SDK API.
      options.disconnectedRetryTimeout = 60
      let realtime = ARTRealtime(options: options)
      sdk = realtime
      return realtime
    })

  init(owner: XCTestCase) throws {
    let userID = "realtime-user-\(UUID().uuidString)"
    self.userID = userID
    workspaceID = "realtime-workspace-\(UUID().uuidString)"
    let metadata = RealtimeMetadataFixture()
    self.metadata = metadata
    http = ChatHTTPFixture(
      onUnhandledRequest: { XCTFail($0) },
      handler: { request in
        let path = request.url!.path
        metadata.requests.withLock { $0[path, default: 0] += 1 }
        guard var result = ModelHTTPFixtures.response(path) else { throw URLError(.unsupportedURL) }
        if path == "/api/user-model-preference" {
          result.body = result.body.replacingOccurrences(
            of: "\"selectedModel\":\"codex-model\"",
            with: "\"selectedModel\":\"\(metadata.remoteModel.withLock { $0 })\"")
        }
        return result
      })
    models = ChatModelStore(
      client: http.client, webURL: http.baseURL, didFail: { XCTFail("\($0)") })
    let attachRequests = owner.expectation(
      description: "Both SDK channel attach requests reach loopback")
    attachRequests.expectedFulfillmentCount = 2
    self.attachRequests = attachRequests
    let count = Mutex(0)
    server = try RealtimeHTTPFixture(clientID: userID) { action, channel in
      guard action == 10, !channel.hasPrefix("user-org-foreground:") else { return }
      let total = count.withLock {
        $0 += 1
        return $0
      }
      if total <= 2 { attachRequests.fulfill() }
    }
  }

  func prepare() async throws { port = try await server.start() }

  func drain() async {
    while !tasks.isEmpty {
      let pending = tasks
      tasks.removeAll()
      for task in pending { await task.value }
    }
  }

  func close() async {
    service.stop()
    models.close()
    await drain()
    server.stop()
    sdk = nil
  }

  func expectedRequests(rounds: Int) -> [String: Int] {
    [
      "/api/user-model-preference": rounds, "/api/run-models": rounds,
      "/api/model-catalog": rounds, "/api/feature-switches": rounds,
    ]
  }
}

private final class RealtimeMetadataFixture: Sendable {
  let requests = Mutex<[String: Int]>([:])
  let remoteModel = Mutex("codex-model")
}
