import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerConnectorStoreTests: XCTestCase {
  private typealias F = ConnectorHTTPFixtures

  func testTransportCancellationRecoversConnectorAndRemoteReadsWithoutManualRefresh() async throws {
    let cancelledPaths = Mutex(Set(["/api/connectors/connected", "/api/vnc/connections"]))
    let fixture = ChatHTTPFixture { request in
      if cancelledPaths.withLock({ $0.remove(request.url!.path) != nil }) {
        throw URLError(.cancelled)
      }
      if request.url!.path == "/api/connectors/connected" {
        return ChatHTTPResponse(
          body: """
            {"builtinConnectors":[{"slug":"slack","label":"Slack","hasPermissions":false}],"customConnectors":[]}
            """)
      }
      if request.url!.path.hasSuffix("/connector-access") {
        return ChatHTTPResponse(
          body: "{\"enabledConnectorSlugs\":[\"slack\"],\"customConnectorIds\":[]}")
      }
      if request.url!.path == "/api/remotes/overview" {
        return ChatHTTPResponse(
          body: """
            {"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":false}]}
            """)
      }
      if request.url!.path == "/api/vnc/connections" {
        return ChatHTTPResponse(
          body: "{\"connections\":[{\"id\":\"\(F.accountID)\",\"security\":{}}]}")
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }

    await store.refresh()

    _ = try await connectedValue(store)
    _ = try await remoteValue(store)
    XCTAssertEqual(store.connectors.first?.label, "Slack")
    XCTAssertEqual(store.connectors.first?.authorized, true)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, F.accountID)
    XCTAssertEqual(store.vncConnections.first?.id, F.accountID)
  }

  func testRepeatedTransportCancellationStopsAndAllowsManualRecovery() async throws {
    let unavailable = Mutex(true)
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        reads.withLock { $0 += 1 }
        if unavailable.withLock({ $0 }) { throw URLError(.cancelled) }
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)

    await store.refresh()

    XCTAssertEqual(reads.withLock { $0 }, 2)
    let resources = try XCTUnwrap(store.resources)
    let failure = await (try resources.store.get(resources.remote)).result
    if case .failure(let error) = failure {
      XCTAssertEqual(
        ComposerConnectorResources.message(for: error, in: .remote),
        String(localized: "Could not load remote access. Try again."))
    } else {
      XCTFail("Repeated transport cancellation became successful data")
    }
    _ = try await connectedValue(store)

    unavailable.withLock { $0 = false }
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, F.accountID)
  }

  func testNewChatOffersOnlineComputersAndRetainsItsSelectionWhenItGoesOffline() async throws {
    let status = Mutex("online")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        return ChatHTTPResponse(
          body: """
            {"computerUseHosts":[{"id":"\(F.accountID)","displayName":"Studio Mac","status":"\(status.withLock { $0 })"},{"id":"\(F.siblingID)","displayName":"Travel Mac","status":"offline"},{"id":"\(F.customID)","displayName":"Travel Mac","status":"offline"}],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[]}
            """)
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.visibleComputerUseHosts.map(\.id), [F.accountID])

    await store.setComputerAccess(ChatComputerAccess(computerUseHostId: F.accountID))
    status.withLock { $0 = "offline" }
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.visibleComputerUseHosts.map(\.id), [F.accountID])
    XCTAssertEqual(store.pendingOptions.computerAccess?.computerUseHostId, F.accountID)

    await store.setComputerAccess(ChatComputerAccess())
    XCTAssertTrue(store.visibleComputerUseHosts.isEmpty)
    XCTAssertNil(store.pendingOptions.computerAccess?.computerUseHostId)
  }

  func testConversationKeepsItsSelectedOfflineComputerAvailableToDisable() async throws {
    let selection = Mutex<String?>(F.accountID)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        return ChatHTTPResponse(
          body: """
            {"computerUseHosts":[{"id":"\(F.accountID)","displayName":"Studio Mac","status":"offline"},{"id":"\(F.siblingID)","displayName":"Travel Mac","status":"offline"}],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[]}
            """)
      }
      if request.url!.path == "/api/chat-threads/\(F.threadID)/computer-use-host",
        request.httpMethod == "POST"
      {
        let access = try JSONDecoder().decode(
          ChatComputerAccess.self, from: chatRequestBody(request))
        selection.withLock { $0 = access.computerUseHostId }
        return ChatHTTPResponse(body: "{}")
      }
      if request.url!.path == "/api/chat-threads/\(F.threadID)/metadata" {
        let hostID = selection.withLock { $0.map { "\"\($0)\"" } ?? "null" }
        return ChatHTTPResponse(
          body: """
            {"id":"\(F.threadID)","agentId":"\(F.agentID)","cloudBrowserEnabled":false,"computerUseHostId":\(hostID)}
            """)
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.visibleComputerUseHosts.map(\.id), [F.accountID])
    XCTAssertEqual(store.computerAccess.computerUseHostId, F.accountID)

    await store.setComputerAccess(ChatComputerAccess())
    XCTAssertTrue(store.canSend)
    XCTAssertNil(store.computerAccess.computerUseHostId)
    XCTAssertTrue(store.visibleComputerUseHosts.isEmpty)
    let access = try await store.service.computerAccess(threadID: F.threadID)
    XCTAssertNil(access.computerUseHostId)
  }

  func testPendingChoicesBelongToTheirAgentWithoutCreatingAConversation() async throws {
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/agents/\(F.siblingID)" {
        return ChatHTTPResponse(body: "{\"agentId\":\"\(F.siblingID)\"}")
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    await store.setRemote(host, protocol: .ssh, enabled: true)
    await store.setComputerAccess(ChatComputerAccess(cloudBrowserEnabled: true))
    store.configure(agentID: F.siblingID)
    XCTAssertTrue(store.pendingOptions.initialRemoteAccessOverrides.isEmpty)
    await store.setRemote(host, protocol: .ssh, enabled: false)
    store.configure(agentID: F.agentID)
    XCTAssertEqual(store.pendingOptions.initialRemoteAccessOverrides.first?.enabled, true)
    XCTAssertEqual(store.pendingOptions.computerAccess?.cloudBrowserEnabled, true)
    store.configure(agentID: F.siblingID)
    store.consumeNewChatOptions(agentID: F.agentID)
    XCTAssertEqual(store.pendingOptions.initialRemoteAccessOverrides.first?.enabled, false)
    store.configure(agentID: F.agentID)
    XCTAssertTrue(store.pendingOptions.initialRemoteAccessOverrides.isEmpty)
  }

  func testRejectedRemoteWriteKeepsItsBusinessReasonUntilExplicitReadback() async throws {
    let writes = Mutex(0)
    let holdOld = Mutex(false)
    let oldReading = expectation(description: "Old read captured before rejection")
    let oldResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/remote-access/ssh/\(F.accountID)"),
        request.httpMethod == "PUT"
      {
        writes.withLock { $0 += 1 }
        return ChatHTTPResponse(
          status: 403, body: #"{"error":{"message":"Remote access is blocked"}}"#)
      }
      let response = try composerResponse(request)
      if request.url!.path.hasSuffix("/remote-access") {
        let shouldHold = holdOld.withLock { value in
          let held = value
          value = false
          return held
        }
        if shouldHold {
          oldReading.fulfill()
          await oldResponse.wait()
        }
      }
      return response
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    holdOld.withLock { $0 = true }
    let background = Task { await store.refresh() }
    addTeardownBlock {
      background.cancel()
      oldResponse.open()
      await background.value
    }
    await fulfillment(of: [oldReading], timeout: 3)
    await store.setRemote(host, protocol: .ssh, enabled: true)
    XCTAssertTrue(store.error?.contains("Remote access is blocked") == true)
    XCTAssertFalse(store.canSend)
    oldResponse.open()
    await background.value
    XCTAssertTrue(store.error?.contains("Remote access is blocked") == true)
    XCTAssertFalse(store.canSend)
    await store.setRemote(host, protocol: .ssh, enabled: true)
    XCTAssertEqual(writes.withLock { $0 }, 1)
    await store.refresh()
    XCTAssertTrue(store.canSend)
    XCTAssertEqual(store.hosts(.ssh).first?.enabled, false)
    XCTAssertEqual(writes.withLock { $0 }, 1)
  }

  func testReadStartedBeforeAWriteCannotConfirmItsUncertainResult() async throws {
    struct Server: Sendable {
      var enabled = true
      var writes = 0
    }
    let server = Mutex(Server())
    let holdOld = Mutex(false)
    let holdFresh = Mutex(false)
    let oldReading = expectation(description: "Old settings captured before the write")
    let freshReading = expectation(description: "Fresh settings read after the write")
    let oldResponse = ConnectorResponseGate()
    let freshResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.httpMethod == "PUT" {
        server.withLock {
          $0.enabled = false
          $0.writes += 1
        }
        throw URLError(.networkConnectionLost)
      }
      if request.url!.path.hasSuffix("/remote-access") {
        let enabled = server.withLock { $0.enabled }
        if holdOld.withLock({ value in
          let held = value
          value = false
          return held
        }) {
          oldReading.fulfill()
          await oldResponse.wait()
        } else if holdFresh.withLock({ value in
          let held = value
          value = false
          return held
        }) {
          freshReading.fulfill()
          await freshResponse.wait()
        }
        return ChatHTTPResponse(
          body: """
            {"ssh":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":true,"overrideEnabled":\(enabled),"enabled":\(enabled)}],"vnc":[]}
            """)
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    holdOld.withLock { $0 = true }
    let background = Task { await store.refresh() }
    addTeardownBlock {
      background.cancel()
      oldResponse.open()
      freshResponse.open()
      await background.value
    }
    await fulfillment(of: [oldReading], timeout: 3)
    holdFresh.withLock { $0 = true }
    await store.setRemote(host, protocol: .ssh, enabled: false)
    XCTAssertFalse(store.canSend)
    oldResponse.open()
    await fulfillment(of: [freshReading], timeout: 3)
    XCTAssertFalse(store.canSend)
    freshResponse.open()
    await background.value
    XCTAssertTrue(store.canSend)
    XCTAssertEqual(store.hosts(.ssh).first?.enabled, false)
    XCTAssertEqual(server.withLock { $0.writes }, 1)
  }

  func testUnknownRemoteWriteRequiresReadbackBeforeSendingAndIsNeverReplayed() async throws {
    struct Server: Sendable {
      var enabled = true
      var writes = 0
    }
    let server = Mutex(Server())
    let blocked = Mutex(false)
    let reading = expectation(description: "Settings readback started")
    let response = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview", blocked.withLock({ $0 }) {
        reading.fulfill()
        await response.wait()
      }
      if request.url!.path.hasSuffix("/remote-access/ssh/\(F.accountID)"),
        request.httpMethod == "PUT"
      {
        server.withLock {
          $0.enabled = false
          $0.writes += 1
        }
        blocked.withLock { $0 = true }
        throw URLError(.networkConnectionLost)
      }
      if request.url!.path.hasSuffix("/remote-access") {
        let enabled = server.withLock { $0.enabled }
        return ChatHTTPResponse(
          body: """
            {"ssh":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":true,"overrideEnabled":\(enabled),"enabled":\(enabled)}],"vnc":[]}
            """)
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    let saving = Task { await store.setRemote(host, protocol: .ssh, enabled: false) }
    addTeardownBlock {
      saving.cancel()
      response.open()
      await saving.value
    }
    await fulfillment(of: [reading], timeout: 3)
    XCTAssertFalse(store.canSend)
    await store.setRemote(host, protocol: .ssh, enabled: true)
    XCTAssertEqual(server.withLock { $0.writes }, 1)
    blocked.withLock { $0 = false }
    response.open()
    await saving.value
    _ = try await connectedValue(store)
    _ = try await remoteValue(store)
    XCTAssertNotNil(store.notice)
    XCTAssertTrue(store.canSend)
    XCTAssertEqual(store.hosts(.ssh).first?.overrideEnabled, false)
    XCTAssertEqual(server.withLock { $0.writes }, 1)
  }

  func testRetiredComposerCannotBeginAWriteAfterItsContextReadCompletes() async throws {
    let reading = ConnectorResponseGate()
    let resume = ConnectorResponseGate()
    let blocked = Mutex(false)
    let writes = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/metadata"), blocked.withLock({ $0 }) {
        reading.open()
        await resume.wait()
      }
      if request.httpMethod == "PUT" {
        writes.withLock { $0 += 1 }
        return ChatHTTPResponse(body: "{}")
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    blocked.withLock { $0 = true }
    let write = Task { await store.setRemote(host, protocol: .ssh, enabled: true) }
    defer {
      resume.open()
      write.cancel()
    }
    await reading.wait()
    store.configure(agentID: F.siblingID)
    resume.open()
    await write.value
    XCTAssertEqual(writes.withLock { $0 }, 0)
    XCTAssertTrue(store.canSend)
  }

  func testSharedOverviewReadsKeepFailuresUntilAnExplicitRefresh() async throws {
    struct Server: Sendable {
      var connectedReads = 0
      var remoteReads = 0
      var fails = true
    }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/connected" {
        server.withLock { $0.connectedReads += 1 }
      }
      if request.url!.path == "/api/remotes/overview" {
        let fails = server.withLock { value in
          value.remoteReads += 1
          return value.fails
        }
        if fails {
          return ChatHTTPResponse(
            status: 403, body: #"{"error":{"message":"Remote access unavailable"}}"#)
        }
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    let resources = try XCTUnwrap(store.resources)
    let first = try resources.store.get(resources.connected)
    let second = try resources.store.get(resources.connected)
    let values = try await (first.value, second.value)
    XCTAssertTrue(values.0.connectors.isEmpty)
    XCTAssertFalse(values.1.chatAccountAccess)
    let failed = try resources.store.get(resources.remote)
    if case .success = await failed.result {
      XCTFail("A failed remote read became successful data")
    }
    server.withLock { $0.fails = false }
    if case .success = await (try resources.store.get(resources.remote)).result {
      XCTFail("Observation silently retried the failed resource")
    }
    XCTAssertEqual(server.withLock { $0.connectedReads }, 1)
    XCTAssertEqual(server.withLock { $0.remoteReads }, 1)
    await store.refresh()
    let remote = try await remoteValue(store)
    XCTAssertEqual(remote.overview.sshHosts.first?.connectionId, F.accountID)
    XCTAssertEqual(server.withLock { $0.remoteReads }, 2)
  }

  func testOverviewSectionsStartIndependentlyAndPublishWithoutACombinedSuccessBarrier() async throws
  {
    let connectedStarted = expectation(description: "Connected read started")
    let remoteStarted = expectation(description: "Remote read started")
    let connectedResponse = ConnectorResponseGate()
    let remoteResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/connectors/connected" {
        connectedStarted.fulfill()
        await connectedResponse.wait()
      }
      if request.url!.path == "/api/remotes/overview" {
        remoteStarted.fulfill()
        await remoteResponse.wait()
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    let resources = try XCTUnwrap(store.resources)
    let pending = try resources.requests()
    addTeardownBlock {
      connectedResponse.open()
      remoteResponse.open()
      pending.connected.cancel()
      pending.remote.cancel()
      _ = await (pending.connected.result, pending.remote.result)
    }
    await fulfillment(of: [connectedStarted, remoteStarted], timeout: 3)
    remoteResponse.open()
    let remote = try await pending.remote.value
    XCTAssertEqual(remote.overview.sshHosts.first?.connectionId, F.accountID)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, F.accountID)
    connectedResponse.open()
    let connected = try await pending.connected.value
    XCTAssertTrue(connected.connectors.isEmpty)
  }

  func testAgentReplacementCancelsBothOriginalReadsAndRejectsTheirLateResults() async throws {
    let old = Mutex(true)
    let started = expectation(description: "Both original HTTP reads started")
    started.expectedFulfillmentCount = 2
    let cancelled = expectation(description: "Both original HTTP reads cancelled")
    cancelled.expectedFulfillmentCount = 2
    let connectedResponse = ConnectorResponseGate()
    let remoteResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      let isOverview = ["/api/connectors/connected", "/api/remotes/overview"].contains(path)
      let isOld = old.withLock { $0 }
      if isOverview, isOld {
        await withTaskCancellationHandler {
          started.fulfill()
          if path == "/api/connectors/connected" {
            await connectedResponse.wait()
          } else {
            await remoteResponse.wait()
          }
        } onCancel: {
          cancelled.fulfill()
        }
      }
      if path == "/api/agents/\(F.siblingID)" {
        return ChatHTTPResponse(body: "{\"agentId\":\"\(F.siblingID)\"}")
      }
      if path == "/api/agents/\(F.siblingID)/connector-access" {
        return ChatHTTPResponse(
          body: #"{"enabledConnectorSlugs":["slack"],"customConnectorIds":[]}"#)
      }
      if path == "/api/connectors/connected" {
        return ChatHTTPResponse(
          body:
            "{\"builtinConnectors\":[{\"slug\":\"slack\",\"label\":\"\(isOld ? "Old service" : "New service")\",\"hasPermissions\":false}],\"customConnectors\":[]}"
        )
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    let resources = try XCTUnwrap(store.resources)
    let pending = try resources.requests()
    addTeardownBlock {
      connectedResponse.open()
      remoteResponse.open()
      pending.connected.cancel()
      pending.remote.cancel()
      _ = await (pending.connected.result, pending.remote.result)
    }
    await fulfillment(of: [started], timeout: 3)
    old.withLock { $0 = false }
    store.configure(agentID: F.siblingID)
    await fulfillment(of: [cancelled], timeout: 3)
    await store.refresh()
    XCTAssertEqual(store.connectors.first?.label, "New service")
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, F.accountID)
    connectedResponse.open()
    remoteResponse.open()
    if case .success = await pending.connected.result {
      XCTFail("The retired connector read returned data")
    }
    if case .success = await pending.remote.result {
      XCTFail("The retired remote read returned data")
    }
    XCTAssertEqual(store.connectors.first?.label, "New service")
  }

  func testCancellingOneConsumerDoesNotCancelTheSharedRemoteRead() async throws {
    let started = expectation(description: "Shared remote HTTP started")
    let response = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        started.fulfill()
        await response.wait()
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    let resources = try XCTUnwrap(store.resources)
    let shared = try resources.store.get(resources.remote)
    let waiter = Task { try await shared.value }
    addTeardownBlock {
      waiter.cancel()
      shared.cancel()
      response.open()
      _ = await waiter.result
      _ = await shared.result
    }
    await fulfillment(of: [started], timeout: 3)
    waiter.cancel()
    let surviving = try resources.store.get(resources.remote)
    response.open()
    let remote = try await surviving.value
    XCTAssertEqual(remote.overview.sshHosts.first?.connectionId, F.accountID)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, F.accountID)
  }

  func testClosingComposerCancelsItsOriginalRemoteReadWithoutRetrying() async throws {
    let started = expectation(description: "Remote HTTP started")
    let cancelled = expectation(description: "Original HTTP cancelled on close")
    let response = ConnectorResponseGate()
    let reads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        reads.withLock { $0 += 1 }
        await withTaskCancellationHandler {
          started.fulfill()
          await response.wait()
        } onCancel: {
          cancelled.fulfill()
        }
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    let resources = try XCTUnwrap(store.resources)
    let pending = try resources.store.get(resources.remote)
    addTeardownBlock {
      pending.cancel()
      response.open()
      _ = await pending.result
    }
    await fulfillment(of: [started], timeout: 3)
    store.close()
    await fulfillment(of: [cancelled], timeout: 3)
    response.open()
    if case .success = await pending.result { XCTFail("The closed composer published remote data") }
    XCTAssertEqual(reads.withLock { $0 }, 1)
  }

  func testPartialReadbackCannotConfirmAnUnknownWriteOrReplayIt() async throws {
    struct Server: Sendable {
      var enabled = true
      var unavailable = false
      var writes = 0
    }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/remote-access/ssh/\(F.accountID)"),
        request.httpMethod == "PUT"
      {
        server.withLock {
          $0.enabled = false
          $0.unavailable = true
          $0.writes += 1
        }
        throw URLError(.networkConnectionLost)
      }
      if request.url!.path == "/api/remotes/overview", server.withLock({ $0.unavailable }) {
        return ChatHTTPResponse(
          status: 403, body: #"{"error":{"message":"Remote access unavailable"}}"#)
      }
      if request.url!.path.hasSuffix("/remote-access") {
        let enabled = server.withLock { $0.enabled }
        return ChatHTTPResponse(
          body:
            "{\"ssh\":[{\"connectionId\":\"\(F.accountID)\",\"displayName\":\"Build Mac\",\"defaultEnabled\":true,\"overrideEnabled\":\(enabled),\"enabled\":\(enabled)}],\"vnc\":[]}"
        )
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Remote work", selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    await store.setRemote(host, protocol: .ssh, enabled: false)
    _ = try await connectedValue(store)
    XCTAssertFalse(store.canSend)
    await store.setRemote(host, protocol: .ssh, enabled: true)
    XCTAssertEqual(server.withLock { $0.writes }, 1)
    server.withLock { $0.unavailable = false }
    await store.refresh()
    let confirmed = try await remoteValue(store)
    XCTAssertEqual(confirmed.access?.ssh.first?.enabled, false)
    XCTAssertTrue(store.canSend)
    XCTAssertEqual(server.withLock { $0.writes }, 1)
  }

  private func connectedValue(_ store: ComposerConnectorStore) async throws
    -> ComposerConnectorResources.Connected
  {
    let resources = try XCTUnwrap(store.resources)
    return try await resources.store.get(resources.connected).value
  }

  private func remoteValue(_ store: ComposerConnectorStore) async throws
    -> ComposerConnectorResources.Remote
  {
    let resources = try XCTUnwrap(store.resources)
    return try await resources.store.get(resources.remote).value
  }

  private func makeStore(_ fixture: ChatHTTPFixture, thread: ChatThread? = nil)
    -> ComposerConnectorStore
  {
    ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.client),
      authorizationService: ChatConnectorService(client: fixture.client),
      webURL: URL(string: "https://app.example.invalid")!, thread: thread, didFail: { _ in })
  }
}

private func composerResponse(_ request: URLRequest) throws -> ChatHTTPResponse {
  typealias F = ConnectorHTTPFixtures
  switch request.url!.path {
  case "/api/feature-switches":
    return ChatHTTPResponse(body: "{\"effectiveSwitches\":{\"connectorChatAccountAccess\":false}}")
  case "/api/agents/\(F.agentID)":
    return ChatHTTPResponse(body: "{\"agentId\":\"\(F.agentID)\"}")
  case "/api/connectors/connected":
    return ChatHTTPResponse(body: "{\"builtinConnectors\":[],\"customConnectors\":[]}")
  case "/api/agents/\(F.agentID)/connector-access":
    return ChatHTTPResponse(body: "{\"enabledConnectorSlugs\":[],\"customConnectorIds\":[]}")
  case "/api/remotes/overview":
    return ChatHTTPResponse(
      body: """
        {"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":false}],"vncHosts":[]}
        """)
  case "/api/chat-threads/\(F.threadID)/metadata":
    return ChatHTTPResponse(body: F.metadata)
  case "/api/chat-threads/\(F.threadID)/remote-access":
    return ChatHTTPResponse(
      body: """
        {"ssh":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":false,"overrideEnabled":null,"enabled":false}],"vnc":[]}
        """)
  default: throw URLError(.unsupportedURL)
  }
}

private final class ConnectorResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    stream = pair.stream
    continuation = pair.continuation
  }

  func wait() async { for await _ in stream { return } }
  func open() {
    continuation.yield()
    continuation.finish()
  }
}
