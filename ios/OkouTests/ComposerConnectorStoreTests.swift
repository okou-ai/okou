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
  }

  func testUnknownRemoteWriteRequiresReadbackBeforeSendingAndIsNeverReplayed() async throws {
    struct Server: Sendable { var enabled = true; var writes = 0 }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/remote-access/ssh/\(F.accountID)"), request.httpMethod == "PUT" {
        server.withLock { $0.enabled = false; $0.writes += 1 }
        throw URLError(.networkConnectionLost)
      }
      if request.url!.path.hasSuffix("/remote-access") {
        let enabled = server.withLock { $0.enabled }
        return ChatHTTPResponse(body: """
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
    await store.setRemote(host, protocol: .ssh, enabled: false)
    XCTAssertFalse(store.canSend)
    await store.refresh()
    XCTAssertTrue(store.canSend)
    XCTAssertEqual(store.hosts(.ssh).first?.overrideEnabled, false)
    XCTAssertEqual(server.withLock { $0.writes }, 1)
  }

  private func makeStore(_ fixture: ChatHTTPFixture, thread: ChatThread? = nil) -> ComposerConnectorStore {
    ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.client),
      authorizationService: ChatConnectorService(client: fixture.client),
      webURL: URL(string: "https://app.example.invalid")!, thread: thread, didFail: { _ in })
  }
}

private func composerResponse(_ request: URLRequest) throws -> ChatHTTPResponse {
  typealias F = ConnectorHTTPFixtures
  switch request.url!.path {
  case "/api/agents/\(F.agentID)":
    return ChatHTTPResponse(body: "{\"agentId\":\"\(F.agentID)\"}")
  case "/api/connectors/connected":
    return ChatHTTPResponse(body: "{\"builtinConnectors\":[],\"customConnectors\":[]}")
  case "/api/agents/\(F.agentID)/connector-access":
    return ChatHTTPResponse(body: "{\"enabledConnectorSlugs\":[],\"customConnectorIds\":[]}")
  case "/api/remotes/overview":
    return ChatHTTPResponse(body: """
      {"computerUseHosts":[],"cloudBrowserAvailable":true,"cloudBrowserEnabledByDefault":false,"sshHosts":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":false}],"vncHosts":[]}
      """)
  case "/api/chat-threads/\(F.threadID)/metadata":
    return ChatHTTPResponse(body: F.metadata)
  default: throw URLError(.unsupportedURL)
  }
}
