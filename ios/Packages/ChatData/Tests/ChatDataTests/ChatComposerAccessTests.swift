import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatComposerAccessTests: XCTestCase {
  private typealias F = ConnectorHTTPFixtures

  func testExplicitOffAndInheritedRemoteDefaultHaveDifferentPersistedEffects() async throws {
    let override = Mutex<Bool?>(nil)
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      if path.hasSuffix("/remote-access/ssh/\(F.accountID)") {
        if request.httpMethod == "DELETE" {
          XCTAssertTrue(chatRequestBody(request).isEmpty)
          override.withLock { $0 = nil }
        } else {
          struct Body: Decodable { let enabled: Bool }
          let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
          override.withLock { $0 = body.enabled }
        }
        return ChatHTTPResponse(body: "{}")
      }
      if path.hasSuffix("/remote-access") {
        let value = override.withLock { $0 }
        return ChatHTTPResponse(
          body: """
            {"ssh":[{"connectionId":"\(F.accountID)","displayName":"Build Mac","defaultEnabled":true,"overrideEnabled":\(value.map { $0 ? "true" : "false" } ?? "null"),"enabled":\(value ?? true)}],"vnc":[]}
            """)
      }
      throw URLError(.unsupportedURL)
    }
    let service = ChatComposerAccess(client: fixture.client)
    try await service.setRemote(
      threadID: F.threadID, protocol: .ssh, connectionID: F.accountID, enabled: false)
    let disabled = try await service.remoteAccess(threadID: F.threadID)
    XCTAssertEqual(disabled.ssh.first?.overrideEnabled, false)
    XCTAssertEqual(disabled.ssh.first?.enabled, false)
    try await service.setRemote(
      threadID: F.threadID, protocol: .ssh, connectionID: F.accountID, enabled: nil)
    let inherited = try await service.remoteAccess(threadID: F.threadID)
    XCTAssertNil(inherited.ssh.first?.overrideEnabled)
    XCTAssertEqual(inherited.ssh.first?.enabled, true)
  }

  func testBrowserSelectionExplicitlyClearsComputerAndIsReadBack() async throws {
    let selected = Mutex<ChatComputerAccess?>(nil)
    let fixture = ChatHTTPFixture { request in
      if request.url!.path.hasSuffix("/computer-use-host") {
        struct Body: Decodable {
          let cloudBrowserEnabled: Bool
          let computerUseHostId: String?
          enum CodingKeys: String, CodingKey { case cloudBrowserEnabled, computerUseHostId }
          init(from decoder: any Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            computerUseHostId = try values.decode(String?.self, forKey: .computerUseHostId)
            cloudBrowserEnabled = try values.decode(Bool.self, forKey: .cloudBrowserEnabled)
          }
        }
        let value = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        selected.withLock {
          $0 = ChatComputerAccess(
            computerUseHostId: value.computerUseHostId,
            cloudBrowserEnabled: value.cloudBrowserEnabled)
        }
        return ChatHTTPResponse(status: 204, body: "")
      }
      if request.url!.path.hasSuffix("/metadata") {
        let value = try XCTUnwrap(selected.withLock { $0 })
        return ChatHTTPResponse(
          body: """
            {"id":"\(F.threadID)","agentId":"\(F.agentID)","computerUseHostId":null,"cloudBrowserEnabled":\(value.cloudBrowserEnabled)}
            """)
      }
      throw URLError(.unsupportedURL)
    }
    let service = ChatComposerAccess(client: fixture.client)
    try await service.setComputerAccess(
      ChatComputerAccess(cloudBrowserEnabled: true), threadID: F.threadID)
    let value = try await service.computerAccess(threadID: F.threadID)
    XCTAssertTrue(value.cloudBrowserEnabled)
    XCTAssertNil(value.computerUseHostId)
  }

  func testAccountSearchAndPaginationKeepTheirExactConnectorTarget() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url!.path, "/api/connector-accounts/connections")
      let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
      XCTAssertTrue(query.contains(URLQueryItem(name: "kind", value: "builtin")))
      XCTAssertTrue(query.contains(URLQueryItem(name: "connectorSlug", value: "slack")))
      XCTAssertTrue(query.contains(URLQueryItem(name: "search", value: "Work")))
      let isSecond = query.contains(URLQueryItem(name: "cursor", value: "page-two"))
      let account = F.account(id: isSecond ? F.siblingID : F.accountID)
      return ChatHTTPResponse(
        body: """
          {"connections":[\(account)],"nextCursor":\(isSecond ? "null" : "\"page-two\""),"defaultConnection":\(F.account())}
          """)
    }
    let service = ChatComposerAccess(client: fixture.client)
    let first = try await service.accounts(target: .builtin("slack"), search: "Work")
    let second = try await service.accounts(
      target: .builtin("slack"), search: "Work", cursor: first.nextCursor)
    XCTAssertEqual(first.connections.map(\.id), [F.accountID])
    XCTAssertEqual(second.connections.map(\.id), [F.siblingID])
    XCTAssertNil(second.nextCursor)
    XCTAssertEqual(second.defaultConnection?.id, F.accountID)
  }

  func testDirectoryConnectionBeforeFirstMessageAddsAnAccountWithoutCreatingAChat() async throws {
    let fixture = ChatHTTPFixture { request in
      switch request.url!.path {
      case "/api/agents/\(F.agentID)":
        return ChatHTTPResponse(body: "{\"agentId\":\"\(F.agentID)\"}")
      case "/api/connectors/slack/no-auth":
        struct Account: Decodable {
          let intent: String
          let connectionId: String?
        }
        struct Body: Decodable {
          let account: Account
          let agentId: String
          let authorizeAgent: Bool
        }
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        XCTAssertEqual(body.account.intent, "add")
        XCTAssertNil(body.account.connectionId)
        XCTAssertEqual(body.agentId, F.agentID)
        XCTAssertTrue(body.authorizeAgent)
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
      case "/api/connector-catalog/slack", "/api/agents/\(F.agentID)/user-connectors":
        return try XCTUnwrap(F.response(request))
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatConnectorService(client: fixture.client)
    let action = ChatConnectorAction.configuration(
      target: .builtin("slack"), agentID: F.agentID, threadID: nil)
    let loaded = try await service.status(action)
    let status = try XCTUnwrap(loaded)
    XCTAssertNil(status.account)
    let result = try await service.start(
      action, status: status, method: status.builtin?.authMethods.first, values: [:], options: [:])
    XCTAssertEqual(try result.operatedID, F.accountID)
  }

  func testNewConversationCarriesPendingAccountAndRemoteChoices() async throws {
    var options = ChatComposerOptions()
    options.connectorSelections = [
      ChatConnectorSelection(target: .builtin("slack"), connectionId: F.accountID)
    ]
    options.initialRemoteAccessOverrides = [
      ChatRemoteOverride(protocol: .vnc, connectionId: F.siblingID, enabled: true)
    ]
    let fixture = ChatHTTPFixture { request in
      if request.url!.path == "/api/agents" {
        return ChatHTTPResponse(body: "[{\"agentId\":\"\(F.agentID)\",\"isDefaultAgent\":true}]")
      }
      if request.url!.path == "/api/chat-threads" {
        struct Body: Decodable {
          let connectorSelections: [ChatConnectorSelection]
          let initialRemoteAccessOverrides: [ChatRemoteOverride]
        }
        let body = try JSONDecoder().decode(Body.self, from: chatRequestBody(request))
        XCTAssertEqual(body.connectorSelections.first?.connectionId, F.accountID)
        XCTAssertEqual(body.initialRemoteAccessOverrides.first?.protocol, .vnc)
        XCTAssertEqual(body.initialRemoteAccessOverrides.first?.enabled, true)
        return ChatHTTPResponse(
          status: 201,
          body:
            "{\"id\":\"\(F.threadID)\",\"createdAt\":\"2026-10-24T00:00:00Z\",\"selectedModel\":null}"
        )
      }
      throw URLError(.unsupportedURL)
    }
    let commands = ChatCommands(client: fixture.client, sync: ChatSync(client: fixture.client))
    let thread = try await commands.createThread(
      agentID: F.agentID, modelSelection: ChatModelSelection(), composerOptions: options)
    XCTAssertEqual(thread.id, F.threadID)
  }
}
