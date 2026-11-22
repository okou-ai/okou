import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

private typealias FixtureData = ConnectorHTTPFixtures

@MainActor
final class ManagedConnectorActionTests: XCTestCase {
  func testManagedAddAndReconnectUseTheAccountOnTheConnector() async throws {
    try await verify(brand: "feishu", initiallyConnected: false, receiptID: FixtureData.accountID)
    try await verify(brand: "lark", initiallyConnected: true, receiptID: FixtureData.accountID)
  }

  func testManagedAddRejectsAReceiptForAnotherAccount() async throws {
    try await verify(brand: "feishu", initiallyConnected: false, receiptID: FixtureData.siblingID)
  }

  private func verify(brand: String, initiallyConnected: Bool, receiptID: String) async throws {
    let connected = Mutex(initiallyConnected)
    let starts = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      let path = try XCTUnwrap(request.url?.path)
      switch path {
      case "/api/custom-connectors", "/api/custom-connectors/\(FixtureData.customID)":
        let isConnected = connected.withLock { $0 }
        let identifier = isConnected ? "\"\(FixtureData.accountID)\"" : "null"
        let connector = """
          {"id":"\(FixtureData.customID)","slug":"_\(brand)","displayName":"Managed workspace",
           "authMode":"oauth","oauthConfig":{"providerAdapter":"feishu"},"fields":[],
           "connected":\(isConnected),"connectedAccountId":\(identifier)}
          """
        let body = path == "/api/custom-connectors" ? "{\"connectors\":[\(connector)]}" : connector
        return ChatHTTPResponse(body: body)
      case "/api/custom-connectors/\(FixtureData.customID)/oauth2/start":
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? NSDictionary
        let intent =
          initiallyConnected
          ? ["intent": "reconnect", "connectionId": FixtureData.accountID] : ["intent": "add"]
        XCTAssertEqual(body, ["account": intent])
        starts.withLock { $0 += 1 }
        connected.withLock { $0 = true }
        return ChatHTTPResponse(
          body: "{\"result\":\"connected\",\"connectionId\":\"\(receiptID)\"}")
      case "/api/chat-threads/\(FixtureData.threadID)/metadata":
        return ChatHTTPResponse(body: FixtureData.metadata)
      default:
        XCTFail("Unexpected managed connector request: \(path)")
        return ChatHTTPResponse(status: 404, body: "{}")
      }
    }
    let store = ConnectorActionStore(
      service: ChatConnectorService(client: fixture.client), didContinue: {}, didFail: { _ in })
    defer { store.close() }
    let action: ChatConnectorAction
    if initiallyConnected {
      action = .configuration(
        target: .custom(FixtureData.customID),
        threadID: FixtureData.threadID, connectionID: FixtureData.accountID)
    } else {
      action = try XCTUnwrap(
        ChatConnectorAction.parse(
          "/connectors/_\(brand)/connect", webURL: fixture.baseURL,
          threadID: FixtureData.threadID))
    }
    store.activate(action)
    try await waitForBusinessResult { store.active != nil || store.activationError != nil }
    let flow = try XCTUnwrap(store.active)
    store.submit()
    try await waitForBusinessResult { !flow.busy }
    XCTAssertEqual(starts.withLock { $0 }, 1)
    if receiptID == FixtureData.accountID {
      XCTAssertNil(flow.error)
      XCTAssertNil(store.active)
    } else {
      XCTAssertNotNil(flow.error)
      XCTAssertNotNil(store.active)
    }
  }
}
