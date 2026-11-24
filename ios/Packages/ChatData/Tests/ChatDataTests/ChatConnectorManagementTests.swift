import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

final class ChatConnectorManagementTests: XCTestCase {
  private typealias Fixture = ConnectorHTTPFixtures

  func testManagementInspectsDisabledAccountsAndNeverReadsRemoteSettings() async throws {
    let fixture = managementFixture()
    let entries = try await ChatComposerAccess(client: fixture.client).managedConnectors()
    let connector = try XCTUnwrap(entries.first)
    XCTAssertEqual(connector.target, .builtin("slack"))
    XCTAssertEqual(connector.reconnectAccountIDs, [Fixture.siblingID])
    XCTAssertTrue(connector.needsAttention)
    XCTAssertFalse(try XCTUnwrap(connector.access.accounts.last).enabled)
  }

  func testUnavailableInspectionDoesNotTurnAnAccountIntoAReconnectTarget() async throws {
    let fixture = managementFixture(kind: "unavailable")
    let entries = try await ChatComposerAccess(client: fixture.client).managedConnectors()
    XCTAssertFalse(try XCTUnwrap(entries.first).needsAttention)
  }

  func testInspectionRejectsAnAccountReturnedForAnotherConnector() async throws {
    let fixture = managementFixture(slug: "gmail")
    do {
      _ = try await ChatComposerAccess(client: fixture.client).managedConnectors()
      XCTFail("A mismatched inspection was accepted")
    } catch let error as APIClientError {
      guard case .invalidResponse = error else { return XCTFail("Unexpected error: \(error)") }
    }
  }

  func testRenameResetAndDisconnectUseExactAccountTargetAndImpact() async throws {
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      var request = request
      request.httpBody = chatRequestBody(request)
      requests.withLock { $0.append(request) }
      switch (request.httpMethod, request.url?.path) {
      case ("PATCH", "/api/connector-accounts/\(Fixture.accountID)"):
        return ChatHTTPResponse(body: Fixture.account())
      case ("GET", "/api/connector-accounts/\(Fixture.accountID)/deletion-impact"):
        return ChatHTTPResponse(
          body: """
            {"connectionId":"\(Fixture.accountID)","explicitSelectionCount":3,"hasSibling":true}
            """)
      case ("DELETE", "/api/connector-accounts/\(Fixture.accountID)"):
        return ChatHTTPResponse(body: "{\"deletedConnectionId\":\"\(Fixture.accountID)\"}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatComposerAccess(client: fixture.client)
    try await service.renameAccount(
      target: .builtin("slack"), connectionID: Fixture.accountID,
      displayName: nil)
    let impact = try await service.deletionImpact(
      target: .builtin("slack"),
      connectionID: Fixture.accountID)
    XCTAssertEqual(impact.explicitSelectionCount, 3)
    try await service.disconnectAccount(target: .builtin("slack"), connectionID: Fixture.accountID)
    let saved = requests.withLock { $0 }
    let rename = try JSONSerialization.jsonObject(with: chatRequestBody(saved[0])) as? [String: Any]
    XCTAssertTrue(rename?["displayName"] is NSNull)
    let deletion =
      try JSONSerialization.jsonObject(with: chatRequestBody(saved[2])) as? [String: Any]
    let target = deletion?["target"] as? [String: String]
    XCTAssertEqual(target, ["kind": "builtin", "connectorSlug": "slack"])
  }

  private func managementFixture(kind: String = "available", slug: String = "slack")
    -> ChatHTTPFixture
  {
    ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/connectors/connected":
        return ChatHTTPResponse(
          body:
            #"{"builtinConnectors":[{"slug":"slack","label":"Slack","hasPermissions":true}],"customConnectors":[]}"#
        )
      case "/api/connector-account-access/defaults":
        return ChatHTTPResponse(
          body: """
            [{"connectionId":"\(Fixture.accountID)","defaultEnabled":true,"isDefault":true},
             {"connectionId":"\(Fixture.siblingID)","defaultEnabled":false,"isDefault":false}]
            """)
      case "/api/connector-accounts/\(Fixture.accountID)":
        return ChatHTTPResponse(body: Fixture.account())
      case "/api/connector-accounts/inspect":
        let status = kind == "available" ? ",\"connectionStatus\":\"reconnect-required\"" : ""
        return ChatHTTPResponse(
          body: """
            {"results":[
              {"kind":"available","connectionId":"\(Fixture.accountID)",
               "target":{"kind":"builtin","connectorSlug":"slack"},"connectionStatus":"connected"},
              {"kind":"\(kind)","connectionId":"\(Fixture.siblingID)",
               "target":{"kind":"builtin","connectorSlug":"\(slug)"}\(status)}]}
            """)
      default: throw URLError(.unsupportedURL)
      }
    }
  }
}
