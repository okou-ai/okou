import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ComposerConnectorStoreTests: XCTestCase {

  func testTransportCancellationRecoversConnectorAndRemoteReadsWithoutManualRefresh() async throws {
    let cancelledPaths = Mutex(Set(["/api/chat-connector-overview", "/api/vnc/connections"]))
    let fixture = ChatHTTPFixture { request in
      if cancelledPaths.withLock({ $0.remove(request.url!.path) != nil }) {
        throw URLError(.cancelled)
      }
      if request.url!.path == "/api/chat-connector-overview" {
        return ChatHTTPResponse(body: FixtureData.composerOverview())
      }
      if request.url!.path == "/api/remotes/overview" {
        return ChatHTTPResponse(
          body: """
            {"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[{"connectionId":"\(FixtureData.accountID)","displayName":"Build Mac","defaultEnabled":false}]}
            """)
      }
      if request.url!.path == "/api/vnc/connections" {
        return ChatHTTPResponse(
          body: "{\"connections\":[{\"id\":\"\(FixtureData.accountID)\",\"security\":{}}]}")
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }

    await store.refresh()

    _ = try await connectedValue(store)
    _ = try await remoteValue(store)
    XCTAssertEqual(store.connectors.first?.label, "Slack")
    XCTAssertEqual(store.connectors.first?.access.currentConnectionId, FixtureData.accountID)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, FixtureData.accountID)
    XCTAssertEqual(store.vncConnections.first?.id, FixtureData.accountID)
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
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, FixtureData.accountID)
  }

  func testNewChatOffersOnlineComputersAndRetainsItsSelectionWhenItGoesOffline() async throws {
    let status = Mutex("online")
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        return ChatHTTPResponse(
          body: """
            {"computerUseHosts":[{"id":"\(FixtureData.accountID)","displayName":"Studio Mac","status":"\(status.withLock { $0 })"},{"id":"\(FixtureData.siblingID)","displayName":"Travel Mac","status":"offline"},{"id":"\(FixtureData.customID)","displayName":"Travel Mac","status":"offline"}],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[]}
            """)
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.visibleComputerUseHosts.map(\.id), [FixtureData.accountID])

    await store.setComputerAccess(ChatComputerAccess(computerUseHostId: FixtureData.accountID))
    status.withLock { $0 = "offline" }
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.visibleComputerUseHosts.map(\.id), [FixtureData.accountID])
    XCTAssertEqual(store.pendingOptions.computerAccess?.computerUseHostId, FixtureData.accountID)

    await store.setComputerAccess(ChatComputerAccess())
    XCTAssertTrue(store.visibleComputerUseHosts.isEmpty)
    XCTAssertNil(store.pendingOptions.computerAccess?.computerUseHostId)
  }

  func testConversationKeepsItsSelectedOfflineComputerAvailableToDisable() async throws {
    let selection = Mutex<String?>(FixtureData.accountID)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/remotes/overview" {
        return ChatHTTPResponse(
          body: """
            {"computerUseHosts":[{"id":"\(FixtureData.accountID)","displayName":"Studio Mac","status":"offline"},{"id":"\(FixtureData.siblingID)","displayName":"Travel Mac","status":"offline"}],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[],"vncHosts":[]}
            """)
      }
      if request.url!.path == "/api/chat-threads/\(FixtureData.threadID)/computer-use-host",
        request.httpMethod == "POST"
      {
        let access = try JSONDecoder().decode(
          ChatComputerAccess.self, from: chatRequestBody(request))
        selection.withLock { $0 = access.computerUseHostId }
        return ChatHTTPResponse(body: "{}")
      }
      if request.url!.path == "/api/chat-threads/\(FixtureData.threadID)/metadata" {
        let hostID = selection.withLock { $0.map { "\"\($0)\"" } ?? "null" }
        return ChatHTTPResponse(
          body: """
            {"id":"\(FixtureData.threadID)","cloudBrowserEnabled":false,"computerUseHostId":\(hostID)}
            """)
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
      createdAt: .distantPast, updatedAt: .distantPast, sortAt: .distantPast,
      pinnedAt: nil, pinOrder: nil, indicator: nil)
    let store = makeStore(fixture, thread: thread)
    defer { store.close() }
    await store.refresh()
    _ = try await remoteValue(store)
    XCTAssertEqual(store.visibleComputerUseHosts.map(\.id), [FixtureData.accountID])
    XCTAssertEqual(store.computerAccess.computerUseHostId, FixtureData.accountID)

    await store.setComputerAccess(ChatComputerAccess())
    XCTAssertTrue(store.canSend)
    XCTAssertNil(store.computerAccess.computerUseHostId)
    XCTAssertTrue(store.visibleComputerUseHosts.isEmpty)
    let access = try await store.service.computerAccess(threadID: FixtureData.threadID)
    XCTAssertNil(access.computerUseHostId)
  }

  func testPendingChoicesResetAfterStartingAConversation() async throws {
    let fixture = ChatHTTPFixture { request in
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
    await store.refresh()
    let host = try XCTUnwrap(store.hosts(.ssh).first)
    await store.setRemote(host, protocol: .ssh, enabled: true)
    await store.setComputerAccess(ChatComputerAccess(cloudBrowserEnabled: true))
    XCTAssertEqual(store.pendingOptions.initialRemoteAccessOverrides.first?.enabled, true)
    store.consumeNewChatOptions()
    XCTAssertTrue(store.pendingOptions.initialRemoteAccessOverrides.isEmpty)
  }

  func testSharedOverviewReadsKeepFailuresUntilAnExplicitRefresh() async throws {
    struct Server: Sendable {
      var connectedReads = 0
      var remoteReads = 0
      var fails = true
    }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/chat-connector-overview" {
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
    let resources = try XCTUnwrap(store.resources)
    let first = try resources.store.get(resources.connected)
    let second = try resources.store.get(resources.connected)
    let values = try await (first.value, second.value)
    XCTAssertTrue(values.0.isEmpty)
    XCTAssertTrue(values.1.isEmpty)
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
    XCTAssertEqual(remote.overview.sshHosts.first?.connectionId, FixtureData.accountID)
    XCTAssertEqual(server.withLock { $0.remoteReads }, 2)
  }

  func testOverviewSectionsPublishIndependently() async throws {
    let connectedStarted = expectation(description: "Connected read started")
    let remoteStarted = expectation(description: "Remote read started")
    let connectedResponse = ConnectorResponseGate()
    let remoteResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/chat-connector-overview" {
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
    XCTAssertEqual(remote.overview.sshHosts.first?.connectionId, FixtureData.accountID)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, FixtureData.accountID)
    connectedResponse.open()
    let connected = try await pending.connected.value
    XCTAssertTrue(connected.isEmpty)
  }

  func testComposerReplacementCancelsBothOriginalReadsAndRejectsTheirLateResults() async throws {
    let old = Mutex(true)
    let started = expectation(description: "Both original HTTP reads started")
    started.expectedFulfillmentCount = 2
    let cancelled = expectation(description: "Both original HTTP reads cancelled")
    cancelled.expectedFulfillmentCount = 2
    let connectedResponse = ConnectorResponseGate()
    let remoteResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      let isOverview = ["/api/chat-connector-overview", "/api/remotes/overview"].contains(path)
      let isOld = old.withLock { $0 }
      if isOverview, isOld {
        await withTaskCancellationHandler {
          started.fulfill()
          if path == "/api/chat-connector-overview" {
            await connectedResponse.wait()
          } else {
            await remoteResponse.wait()
          }
        } onCancel: {
          cancelled.fulfill()
        }
      }
      if path == "/api/chat-connector-overview" {
        return ChatHTTPResponse(
          body: FixtureData.composerOverview(label: isOld ? "Old service" : "New service"))
      }
      return try composerResponse(request)
    }
    let store = makeStore(fixture)
    defer { store.close() }
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
    store.close()
    let replacement = makeStore(fixture)
    defer { replacement.close() }
    await fulfillment(of: [cancelled], timeout: 3)
    await replacement.refresh()
    XCTAssertEqual(replacement.connectors.first?.label, "New service")
    XCTAssertEqual(replacement.hosts(.ssh).first?.connectionId, FixtureData.accountID)
    connectedResponse.open()
    remoteResponse.open()
    if case .success = await pending.connected.result {
      XCTFail("The retired connector read returned data")
    }
    if case .success = await pending.remote.result {
      XCTFail("The retired remote read returned data")
    }
    XCTAssertEqual(replacement.connectors.first?.label, "New service")
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
    XCTAssertEqual(remote.overview.sshHosts.first?.connectionId, FixtureData.accountID)
    XCTAssertEqual(store.hosts(.ssh).first?.connectionId, FixtureData.accountID)
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
}

@MainActor
final class ComposerConnectorWritebackTests: XCTestCase {

  func testRejectedRemoteWriteKeepsItsBusinessReasonUntilExplicitReadback() async throws {
    let writes = Mutex(0)
    let holdOld = Mutex(false)
    let oldReading = expectation(description: "Old read captured before rejection")
    let oldResponse = ConnectorResponseGate()
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/remote-access/ssh/\(FixtureData.accountID)"),
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
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
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
            {"ssh":[{"connectionId":"\(FixtureData.accountID)","displayName":"Build Mac","defaultEnabled":true,"overrideEnabled":\(enabled),"enabled":\(enabled)}],"vnc":[]}
            """)
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
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
      if request.url!.path.hasSuffix("/remote-access/ssh/\(FixtureData.accountID)"),
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
            {"ssh":[{"connectionId":"\(FixtureData.accountID)","displayName":"Build Mac","defaultEnabled":true,"overrideEnabled":\(enabled),"enabled":\(enabled)}],"vnc":[]}
            """)
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
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
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
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
    store.close()
    resume.open()
    await write.value
    XCTAssertEqual(writes.withLock { $0 }, 0)
  }

  func testPartialReadbackCannotConfirmAnUnknownWriteOrReplayIt() async throws {
    struct Server: Sendable {
      var enabled = true
      var unavailable = false
      var writes = 0
    }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/remote-access/ssh/\(FixtureData.accountID)"),
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
            "{\"ssh\":[{\"connectionId\":\"\(FixtureData.accountID)\",\"displayName\":\"Build Mac\",\"defaultEnabled\":true,\"overrideEnabled\":\(enabled),\"enabled\":\(enabled)}],\"vnc\":[]}"
        )
      }
      return try composerResponse(request)
    }
    let thread = ChatThread(
      id: FixtureData.threadID, title: "Remote work",
      selectedModel: nil,
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
}

@MainActor
extension XCTestCase {
  fileprivate typealias FixtureData = ConnectorHTTPFixtures

  fileprivate func connectedValue(_ store: ComposerConnectorStore) async throws
    -> [ChatComposerConnector]
  {
    let resources = try XCTUnwrap(store.resources)
    return try await resources.store.get(resources.connected).value
  }

  fileprivate func remoteValue(_ store: ComposerConnectorStore) async throws
    -> ComposerConnectorResources.Remote
  {
    let resources = try XCTUnwrap(store.resources)
    return try await resources.store.get(resources.remote).value
  }

  fileprivate func makeStore(_ fixture: ChatHTTPFixture, thread: ChatThread? = nil)
    -> ComposerConnectorStore
  {
    ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.client),
      authorizationService: ChatConnectorService(client: fixture.client),
      webURL: URL(string: "https://app.example.invalid")!, graph: makeTestWorkspaceGraph(),
      threadID: thread?.id, didFail: { _ in })
  }
}

private func composerResponse(_ request: URLRequest) throws -> ChatHTTPResponse {
  typealias FixtureData = ConnectorHTTPFixtures
  switch request.url!.path {
  case "/api/chat-connector-overview":
    return ChatHTTPResponse(body: "[]")
  case "/api/remotes/overview":
    return ChatHTTPResponse(
      body: """
        {"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[{"connectionId":"\(FixtureData.accountID)","displayName":"Build Mac","defaultEnabled":false}],"vncHosts":[]}
        """)
  case "/api/chat-threads/\(FixtureData.threadID)/metadata":
    return ChatHTTPResponse(body: FixtureData.metadata)
  case "/api/chat-threads/\(FixtureData.threadID)/remote-access":
    return ChatHTTPResponse(
      body: """
        {"ssh":[{"connectionId":"\(FixtureData.accountID)","displayName":"Build Mac","defaultEnabled":false,"overrideEnabled":null,"enabled":false}],"vnc":[]}
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
