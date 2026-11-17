import Ably
import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class RealtimeResourceRecoveryTests: XCTestCase {
  func testCoordinatedStartupReadsOnceAfterSubscriptionsAndStillRecoversAContinuityGap()
    async throws
  {
    let deadline = ModelResponseGate()
    addTeardownBlock { deadline.open() }
    let waiting = expectation(description: "Model consumers are waiting for initial subscriptions")
    let bootstrap = WorkspaceReadBootstrap {
      waiting.fulfill()
      await deadline.wait()
    }
    let fixture = try await makeFixture(modelBootstrap: bootstrap)
    let startup = fixture.beginRefresh([.startup])
    await fulfillment(of: [waiting], timeout: 3)
    let changedWhileWaiting = fixture.beginRefresh([.modelPreference])
    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }

    try await attach(fixture)
    await startup.value
    await changedWhileWaiting.value
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 1))

    fixture.metadata.remoteModel.withLock { $0 = "codex-model" }
    let published = expectation(description: "A later continuity gap still revalidates models")
    fixture.publication = ("codex-model", published)
    try fixture.server.attached(fixture.workspaceChannel)
    await fulfillment(of: [published], timeout: 3)
    await fixture.drain()
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "codex-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 2))
  }

  func testSubscriptionDeadlineAllowsHTTPAndLaterAttachmentReadsTheMissedChange() async throws {
    let deadline = ModelResponseGate()
    addTeardownBlock { deadline.open() }
    let waiting = expectation(description: "The bounded subscription wait has started")
    let bootstrap = WorkspaceReadBootstrap {
      waiting.fulfill()
      await deadline.wait()
    }
    let fixture = try await makeFixture(modelBootstrap: bootstrap)
    let startup = fixture.beginRefresh([.startup])
    await fulfillment(of: [waiting], timeout: 3)
    deadline.open()
    await startup.value
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "codex-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 1))

    fixture.metadata.remoteModel.withLock { $0 = "claude-model" }
    try await attach(fixture)
    XCTAssertEqual(fixture.models.configuration?.defaultSelection.model, "claude-model")
    XCTAssertEqual(fixture.metadata.requests.withLock { $0 }, fixture.expectedRequests(rounds: 2))
  }

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

  private func makeFixture(
    modelBootstrap: WorkspaceReadBootstrap? = nil
  ) async throws -> RealtimeResourceHarness {
    let fixture = try RealtimeResourceHarness(owner: self, modelBootstrap: modelBootstrap)
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
  private let resources: WorkspaceResources
  private let modelBootstrap: WorkspaceReadBootstrap?
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
      if change == .realtimeResume || change == .realtimeGap {
        modelBootstrap?.beginRecovery()
      }
      tasks.append(
        Task { @MainActor [self] in
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
      modelBootstrap?.connectionChanged(status)
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

  init(owner: XCTestCase, modelBootstrap: WorkspaceReadBootstrap?) throws {
    self.modelBootstrap = modelBootstrap
    let userID = "realtime-user-\(UUID().uuidString)"
    self.userID = userID
    workspaceID = "realtime-workspace-\(UUID().uuidString)"
    let metadata = RealtimeMetadataFixture()
    self.metadata = metadata
    http = ChatHTTPFixture(
      onUnhandledRequest: { XCTFail($0) },
      handler: { request in
        guard request.httpMethod == "GET" else { throw URLError(.unsupportedURL) }
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
    let resources = WorkspaceResources(
      client: http.client, sync: ChatSync(client: http.client),
      sleep: { try await Task.sleep(for: $0) }, modelBootstrap: modelBootstrap)
    self.resources = resources
    models = ChatModelStore(
      client: http.client, webURL: http.baseURL, resources: resources,
      didFail: { XCTFail("\($0)") })
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

  func beginRefresh(_ changes: Set<ChatInvalidation>) -> Task<Void, Never> {
    let task = Task.immediate { await models.refresh(changes) }
    tasks.append(task)
    return task
  }

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
    resources.close()
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

@MainActor
final class WorkspaceModelRecoveryTests: XCTestCase {
  func testForegroundAndTransportRecoveryReadOneModelBaseline() async throws {
    let initialDeadline = ModelResponseGate()
    let recoveryDeadline = ModelResponseGate()
    let recovering = Mutex(false)
    let waiting = expectation(description: "Recovery model reads await subscriptions")
    let bootstrap = WorkspaceReadBootstrap {
      if recovering.withLock({ $0 }) {
        waiting.fulfill()
        await recoveryDeadline.wait()
      } else {
        await initialDeadline.wait()
      }
    }
    let fixture = try ModelRecoveryFixture(bootstrap: bootstrap)
    addTeardownBlock {
      initialDeadline.open()
      recoveryDeadline.open()
      await fixture.close()
    }
    try await fixture.start()
    let sdk = try XCTUnwrap(fixture.sdk)
    let disconnected = expectation(description: "Transport is disconnected")
    sdk.connection.once(.disconnected) { _ in disconnected.fulfill() }
    fixture.workspace.setPhase(.background)
    try fixture.server.disconnect()
    await fulfillment(of: [disconnected], timeout: 3)
    recovering.withLock { $0 = true }
    fixture.http.setRemoteModel("claude-model")

    fixture.workspace.setPhase(.active)
    let refresh = try XCTUnwrap(fixture.workspace.resumePendingRefresh())
    await fulfillment(of: [waiting], timeout: 3)
    sdk.connect()
    await refresh.value

    XCTAssertEqual(fixture.workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertTrue(fixture.workspace.newModelSelection.canSend)
    XCTAssertEqual(fixture.http.modelRequests, fixture.http.expectedModelRequests(rounds: 2))
  }

  func testEarlyHTTPReadRevalidatesAChangeMissedBeforeTransportRecovery() async throws {
    let initialDeadline = ModelResponseGate()
    let recoveryDeadline = ModelResponseGate()
    let recovering = Mutex(false)
    let waiting = expectation(description: "Recovery's bounded wait has started")
    let bootstrap = WorkspaceReadBootstrap {
      if recovering.withLock({ $0 }) {
        waiting.fulfill()
        await recoveryDeadline.wait()
      } else {
        await initialDeadline.wait()
      }
    }
    let fixture = try ModelRecoveryFixture(bootstrap: bootstrap)
    addTeardownBlock {
      initialDeadline.open()
      recoveryDeadline.open()
      await fixture.close()
    }
    try await fixture.start()
    let sdk = try XCTUnwrap(fixture.sdk)
    let disconnected = expectation(description: "Transport is unavailable")
    sdk.connection.once(.disconnected) { _ in disconnected.fulfill() }
    fixture.workspace.setPhase(.background)
    try fixture.server.disconnect()
    await fulfillment(of: [disconnected], timeout: 3)
    recovering.withLock { $0 = true }
    fixture.workspace.setPhase(.active)
    let refresh = try XCTUnwrap(fixture.workspace.resumePendingRefresh())
    await fulfillment(of: [waiting], timeout: 3)
    recoveryDeadline.open()
    await refresh.value
    XCTAssertEqual(fixture.workspace.newModelSelection.selection.model, "codex-model")
    XCTAssertEqual(fixture.http.modelRequests, fixture.http.expectedModelRequests(rounds: 2))

    fixture.http.setRemoteModel("claude-model")
    sdk.connect()
    try await waitForBusinessResult {
      fixture.workspace.newModelSelection.selection.model == "claude-model"
    }

    XCTAssertEqual(fixture.http.modelRequests, fixture.http.expectedModelRequests(rounds: 3))
  }

  func testForegroundWithHealthySubscriptionsRevalidatesOnce() async throws {
    let fixture = try ModelRecoveryFixture(bootstrap: WorkspaceReadBootstrap())
    addTeardownBlock { await fixture.close() }
    try await fixture.start()
    await fixture.workspace.resumePendingRefresh()?.value
    let listReads = fixture.http.history.requests.values.withLock {
      $0.filter { $0 == "GET /api/chat-threads/events" }.count
    }
    XCTAssertEqual(listReads, 1)
    fixture.workspace.setPhase(.background)
    fixture.http.setRemoteModel("claude-model")

    fixture.workspace.setPhase(.active)
    await fixture.workspace.resumePendingRefresh()?.value

    XCTAssertEqual(fixture.workspace.newModelSelection.selection.model, "claude-model")
    XCTAssertTrue(fixture.workspace.newModelSelection.canSend)
    XCTAssertEqual(fixture.http.modelRequests, fixture.http.expectedModelRequests(rounds: 2))
    XCTAssertEqual(
      fixture.http.history.requests.values.withLock {
        $0.filter { $0 == "GET /api/chat-threads/events" }.count
      }, listReads)
  }

  func testResumedChannelPreservesTheBaselineAndStillAppliesPreferenceNotifications() async throws {
    let deadline = ModelResponseGate()
    let registered = expectation(description: "The workspace channel is registered for injection")
    let fixture = try ModelRecoveryFixture(
      bootstrap: WorkspaceReadBootstrap { await deadline.wait() },
      onChannelAttach: { registered.fulfill() })
    addTeardownBlock {
      deadline.open()
      await fixture.close()
    }
    try await fixture.start()
    await fulfillment(of: [registered], timeout: 3)
    fixture.http.setRemoteModel("claude-model")

    try fixture.server.attached(fixture.channel, resumed: true)
    try fixture.server.notify("userPreferenceChanged", channel: fixture.channel)
    try await waitForBusinessResult {
      fixture.workspace.newModelSelection.selection.model == "claude-model"
    }

    var expected = fixture.http.expectedModelRequests(rounds: 1)
    expected["/api/user-model-preference"] = 2
    XCTAssertEqual(fixture.http.modelRequests, expected)
  }
}

@MainActor
final class WorkspaceIndicatorRecoveryTests: XCTestCase {
  func testStartupAndInitialSubscriptionsShareOneIndicatorRead() async throws {
    let deadline = ModelResponseGate()
    let releaseToken = ModelResponseGate()
    let waiting = expectation(description: "Startup indicators await the initial subscriptions")
    let fixture = try ModelRecoveryFixture(
      bootstrap: WorkspaceReadBootstrap(),
      indicatorsBootstrap: WorkspaceReadBootstrap {
        waiting.fulfill()
        await deadline.wait()
      },
      beforeRealtimeToken: { await releaseToken.wait() },
      indicators: { _ in Self.indicatorResponse("active") })
    let startup = Task { try await fixture.start(loadModels: false) }
    addTeardownBlock { @MainActor in
      startup.cancel()
      releaseToken.open()
      deadline.open()
      await fixture.close()
      _ = await startup.result
    }

    await fulfillment(of: [waiting], timeout: 3)
    releaseToken.open()
    try await startup.value
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .connected }
    await fixture.workspace.resumePendingRefresh()?.value

    XCTAssertEqual(fixture.workspace.list.threads.first?.indicator, .active)
    XCTAssertEqual(fixture.indicatorReads, 1)
  }

  func testDeadlineReadInFlightStillCatchesUpAfterLateSubscriptions() async throws {
    let releaseToken = ModelResponseGate()
    let releaseRead = ModelResponseGate()
    let reading = expectation(description: "The deadline releases indicators before attachment")
    let remote = Mutex((reads: 0, state: "active"))
    let fixture = try ModelRecoveryFixture(
      bootstrap: WorkspaceReadBootstrap(),
      indicatorsBootstrap: WorkspaceReadBootstrap(waitForTimeout: {}),
      beforeRealtimeToken: { await releaseToken.wait() },
      indicators: { _ in
        let (read, state) = remote.withLock {
          $0.reads += 1
          return ($0.reads, $0.state)
        }
        if read == 1 {
          reading.fulfill()
          await releaseRead.wait()
        }
        return Self.indicatorResponse(state)
      })
    let startup = Task { try await fixture.start(loadModels: false) }
    addTeardownBlock { @MainActor in
      startup.cancel()
      releaseToken.open()
      releaseRead.open()
      await fixture.close()
      _ = await startup.result
    }

    await fulfillment(of: [reading], timeout: 3)
    remote.withLock { $0.state = "unread" }
    releaseToken.open()
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .connected }
    releaseRead.open()
    try await startup.value
    await fixture.workspace.resumePendingRefresh()?.value

    XCTAssertTrue(fixture.workspace.list.hasUnreadThreads)
    XCTAssertEqual(fixture.workspace.list.unreadAgentIDs, [ConversationHistoryFixture.agentID])
    XCTAssertEqual(fixture.indicatorReads, 2)
  }

  func testReadCursorRefreshReleasesIndicatorsWaitingForSubscriptions() async throws {
    let deadline = ModelResponseGate()
    let waiting = expectation(description: "Startup indicators are waiting for subscriptions")
    let fixture = WorkspaceStartupFixture(indicators: { _ in Self.indicatorResponse("unread") })
    let workspace = fixture.workspace(
      indicatorsBootstrap: WorkspaceReadBootstrap {
        waiting.fulfill()
        await deadline.wait()
      })
    let startup = Task { await workspace.refresh([.startup]) }
    addTeardownBlock { @MainActor in
      startup.cancel()
      deadline.open()
      await workspace.close().value
      await startup.value
    }
    await fulfillment(of: [waiting], timeout: 3)

    await workspace.refresh([.readCursor])
    await startup.value

    XCTAssertTrue(workspace.list.hasUnreadThreads)
    XCTAssertEqual(workspace.list.unreadAgentIDs, [ConversationHistoryFixture.agentID])
  }

  func testClosingWorkspaceReleasesThePendingIndicatorBaseline() async throws {
    let deadline = ModelResponseGate()
    let waiting = expectation(description: "Startup indicators have not started HTTP")
    let fixture = WorkspaceStartupFixture()
    let workspace = fixture.workspace(
      indicatorsBootstrap: WorkspaceReadBootstrap {
        waiting.fulfill()
        await deadline.wait()
      })
    let startup = Task { await workspace.refresh([.startup]) }
    addTeardownBlock { @MainActor in
      startup.cancel()
      deadline.open()
      await workspace.close().value
      await startup.value
    }
    await fulfillment(of: [waiting], timeout: 3)

    await workspace.close().value
    await startup.value

    XCTAssertFalse(
      fixture.history.requests.values.withLock { $0.contains("GET /api/indicators") })
  }

  func testDedicatedIndicatorReadCursorAndContinuitySignalsRefreshTheirAuthoritativeState()
    async throws
  {
    let remote = Mutex("active")
    let releaseToken = ModelResponseGate()
    let tokenRequested = expectation(
      description: "Realtime token delivery is held before attachment")
    let registered = expectation(description: "The workspace channel is registered for injection")
    let fixture = try ModelRecoveryFixture(
      bootstrap: WorkspaceReadBootstrap(waitForTimeout: {}),
      indicatorsBootstrap: WorkspaceReadBootstrap(waitForTimeout: {}),
      beforeRealtimeToken: {
        tokenRequested.fulfill()
        await releaseToken.wait()
      },
      onChannelAttach: { registered.fulfill() },
      indicators: { _ in Self.indicatorResponse(remote.withLock { $0 }) })
    addTeardownBlock {
      releaseToken.open()
      await fixture.close()
    }
    try await fixture.start()
    await fulfillment(of: [tokenRequested], timeout: 3)
    XCTAssertEqual(fixture.workspace.list.threads.first?.indicator, .active)

    releaseToken.open()
    await fulfillment(of: [registered], timeout: 3)
    // Late initial subscriptions schedule a catch-up read before reporting connected.
    try await waitForBusinessResult { fixture.workspace.connectionStatus == .connected }
    await fixture.workspace.resumePendingRefresh()?.value
    XCTAssertEqual(fixture.workspace.list.threads.first?.indicator, .active)
    let initial = fixture.http.history.requests.values.withLock { $0 }
    let indicatorReads = initial.filter { $0 == "GET /api/indicators" }.count
    let listReads = initial.filter { $0 == "GET /api/chat-threads/events" }.count

    remote.withLock { $0 = "unread" }
    try fixture.server.notify("chatIndicatorsChanged", channel: fixture.channel)
    try await waitForBusinessResult { fixture.workspace.list.hasUnreadThreads }
    XCTAssertEqual(fixture.workspace.list.unreadAgentIDs, [ConversationHistoryFixture.agentID])

    remote.withLock { $0 = "none" }
    try fixture.server.notify("chatThreadReadCursorUpdated", channel: fixture.channel)
    try await waitForBusinessResult { !fixture.workspace.list.hasUnreadThreads }
    XCTAssertEqual(fixture.workspace.list.unreadAgentIDs, [])
    XCTAssertEqual(
      fixture.http.history.requests.values.withLock {
        $0.filter { $0 == "GET /api/chat-threads/events" }.count
      }, listReads)

    remote.withLock { $0 = "active" }
    try fixture.server.attached(fixture.channel)
    try await waitForBusinessResult {
      fixture.workspace.list.threads.first?.indicator == .active
    }
    XCTAssertEqual(
      fixture.http.history.requests.values.withLock {
        $0.filter { $0 == "GET /api/indicators" }.count
      }, indicatorReads + 3)
  }

  private nonisolated static func indicatorResponse(_ state: String) -> ChatHTTPResponse {
    let thread = ConversationHistoryFixture.threadID
    let agent = ConversationHistoryFixture.agentID
    let threads = state == "none" ? "{}" : "{\"\(thread)\":\"\(state)\"}"
    let unread = state == "unread"
    return ChatHTTPResponse(
      body: """
        {"threads":\(threads),"agents":\(unread ? "{\"\(agent)\":\"unread\"}" : "{}"),\
        "unreadAt":\(unread ? "{\"\(thread)\":\"2026-11-13T00:00:00Z\"}" : "{}")}
        """)
  }
}

@MainActor
private final class ModelRecoveryFixture {
  private let realtime: LoopbackRealtimeFixture
  var server: RealtimeHTTPFixture { realtime.server }
  let http: WorkspaceStartupFixture
  private let bootstrap: WorkspaceReadBootstrap
  private let indicatorsBootstrap: WorkspaceReadBootstrap?
  private let userID = "recovery-user-\(UUID().uuidString)"
  private let workspaceID = "recovery-workspace-\(UUID().uuidString)"
  var sdk: ARTRealtime? { realtime.sdk }
  var channel: String { "user-org:\(userID):\(workspaceID)" }
  var indicatorReads: Int {
    http.history.requests.values.withLock { $0.filter { $0 == "GET /api/indicators" }.count }
  }

  lazy var workspace = http.workspace(
    modelBootstrap: bootstrap, indicatorsBootstrap: indicatorsBootstrap,
    createRealtime: realtime.factory)

  init(
    bootstrap: WorkspaceReadBootstrap,
    indicatorsBootstrap: WorkspaceReadBootstrap? = nil,
    beforeRealtimeToken: (@Sendable () async throws -> Void)? = nil,
    onChannelAttach: @escaping @Sendable () -> Void = {},
    indicators: ChatHTTPFixture.Handler? = nil
  ) throws {
    self.bootstrap = bootstrap
    self.indicatorsBootstrap = indicatorsBootstrap
    let expectedChannel = "user-org:\(userID):\(workspaceID)"
    realtime = try LoopbackRealtimeFixture(clientID: userID) { action, channel in
      guard action == 10, channel == expectedChannel else { return }
      onChannelAttach()
    }
    let token = try JSONSerialization.data(withJSONObject: [
      "keyName": "fixture.key", "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
      "ttl": 3_600_000, "nonce": "fixture-nonce", "mac": "ZmFrZQ==",
      "clientId": userID, "capability": "{\"*\":[\"subscribe\"]}",
    ])
    http = WorkspaceStartupFixture(
      beforeRealtimeToken: beforeRealtimeToken,
      realtimeToken: String(decoding: token, as: UTF8.self), indicators: indicators)
  }

  func start(loadModels: Bool = true) async throws {
    try await realtime.start()
    server.attachAutomatically()
    workspace.setPhase(.active)
    guard loadModels else {
      await workspace.start(userID: userID, workspaceID: workspaceID)
      return
    }
    async let models: Void = workspace.newModelSelection.open()
    await workspace.start(userID: userID, workspaceID: workspaceID)
    await models
    XCTAssertEqual(workspace.newModelSelection.selection.model, "codex-model")
    XCTAssertEqual(http.modelRequests, http.expectedModelRequests(rounds: 1))
  }

  func close() async {
    await workspace.close().value
    realtime.stop()
  }
}

/// Owns SDK configuration and lifetime for workspace tests using the real loopback provider.
@MainActor
final class LoopbackRealtimeFixture {
  let server: RealtimeHTTPFixture
  private var port: UInt16 = 0
  private(set) var sdk: ARTRealtime?

  var factory: RealtimeService.ClientFactory {
    { [unowned self] options in
      options.realtimeHost = "127.0.0.1"
      options.restHost = "127.0.0.1"
      options.port = Int(port)
      options.tls = false
      options.useBinaryProtocol = false
      options.fallbackHosts = []
      options.disconnectedRetryTimeout = 60
      let realtime = ARTRealtime(options: options)
      sdk = realtime
      return realtime
    }
  }

  init(
    clientID: String, onProtocol: @escaping @Sendable (Int, String) -> Void = { _, _ in }
  ) throws {
    server = try RealtimeHTTPFixture(clientID: clientID, onProtocol: onProtocol)
  }

  func start() async throws { port = try await server.start() }

  func disconnectTransport(observed: XCTestExpectation) throws {
    let sdk = try XCTUnwrap(sdk)
    sdk.connection.once(.disconnected) { _ in observed.fulfill() }
    try server.disconnect()
  }

  func reconnectTransport() throws {
    try XCTUnwrap(sdk).connect()
  }

  func detach(_ channel: String) throws {
    try XCTUnwrap(sdk).channels.get(channel).detach()
  }

  func attach(_ channel: String) throws {
    try XCTUnwrap(sdk).channels.get(channel).attach()
  }

  func stop() {
    server.stop()
    sdk = nil
    XCTAssertEqual(server.errors, [])
  }
}
