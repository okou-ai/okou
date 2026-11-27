import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

final class ChatConnectorManagementTests: XCTestCase {
  private typealias Fixture = ConnectorHTTPFixtures

  func testSettingsOverviewKeepsBuiltinRowsAndRespectsBothAccessModes() async throws {
    let fixture = managementFixture()
    let service = ChatComposerAccess(client: fixture.client)
    let entries = try await service.managedConnectorOverview(memberAccess: true)
    XCTAssertEqual(entries.map(\.target), [.builtin("slack")])
    let connector = try XCTUnwrap(entries.first)
    XCTAssertEqual(connector.label, "Slack")
    XCTAssertEqual(connector.icon?.url.lastPathComponent, "slack.svg")
    XCTAssertTrue(connector.hasPermissions)
    XCTAssertEqual(connector.access.accounts.count, 2)
    XCTAssertFalse(connector.access.available)
    XCTAssertTrue(connector.access.accounts.allSatisfy { !$0.enabled })
    let reconnect = try await service.reconnectAccountIDs(for: entries)
    XCTAssertEqual(reconnect, [Fixture.siblingID])

    let legacy = try await service.managedConnectorOverview(memberAccess: false)
    let access = try XCTUnwrap(legacy.first?.access)
    XCTAssertEqual(access.currentConnectionId, Fixture.accountID)
    XCTAssertEqual(access.accounts.filter(\.enabled).map(\.id), [Fixture.accountID])
  }

  func testLargeSettingsListUsesOneOverviewAndBoundedInspectionBatches() async throws {
    struct Body: Decodable { let selections: [ChatConnectorSelection] }
    let selections = (0..<257).map { index in
      ChatConnectorSelection(
        target: .builtin("connector-\(index)"), connectionId: UUID().uuidString)
    }
    let rows = selections.enumerated().map { index, selection in
      """
      {"target":{"kind":"builtin","connectorSlug":"connector-\(index)"},"label":"Connector \(index)",
       "hasPermissions":false,"accounts":[{"connectionId":"\(selection.connectionId)",
       "defaultEnabled":false,"isDefault":true,"enabled":false}],"currentConnectionId":null}
      """
    }
    let sizes = Mutex<[Int]>([])
    let fixture = ChatHTTPFixture { request in
      switch request.url!.path {
      case "/api/chat-connector-overview":
        sizes.withLock { $0.append(0) }
        return ChatHTTPResponse(body: "[" + rows.joined(separator: ",") + "]")
      case "/api/connector-accounts/inspect":
        let batch = try JSONDecoder().decode(Body.self, from: chatRequestBody(request)).selections
        sizes.withLock { $0.append(batch.count) }
        let results = try batch.map { selection in
          let target = try JSONEncoder().encodeString(selection.target)
          return """
            {"kind":"available","connectionId":"\(selection.connectionId)","target":\(target),
             "connectionStatus":"reconnect-required"}
            """
        }
        return ChatHTTPResponse(body: #"{"results":["# + results.joined(separator: ",") + "]}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatComposerAccess(client: fixture.client)
    let entries = try await service.managedConnectorOverview(memberAccess: true)
    XCTAssertEqual(entries.map(\.target), selections.map(\.target))
    let reconnect = try await service.reconnectAccountIDs(for: entries)
    XCTAssertEqual(reconnect, Set(selections.map(\.connectionId)))
    XCTAssertEqual(sizes.withLock { $0 }, [0, 256, 1])
  }

  func testUnavailableInspectionDoesNotTurnAnAccountIntoAReconnectTarget() async throws {
    let fixture = managementFixture(kind: "unavailable")
    let service = ChatComposerAccess(client: fixture.client)
    let entries = try await service.managedConnectorOverview(memberAccess: false)
    let reconnect = try await service.reconnectAccountIDs(for: entries)
    XCTAssertTrue(reconnect.isEmpty)
  }

  func testInspectionRejectsAnAccountReturnedForAnotherConnector() async throws {
    let fixture = managementFixture(slug: "gmail")
    let service = ChatComposerAccess(client: fixture.client)
    let entries = try await service.managedConnectorOverview(memberAccess: false)
    do {
      _ = try await service.reconnectAccountIDs(for: entries)
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
      case "/api/chat-connector-overview":
        return ChatHTTPResponse(body: Fixture.managedOverview)
      case "/api/connector-accounts/inspect":
        return ChatHTTPResponse(body: Fixture.managedInspection(kind: kind, slug: slug))
      default: throw URLError(.unsupportedURL)
      }
    }
  }
}
