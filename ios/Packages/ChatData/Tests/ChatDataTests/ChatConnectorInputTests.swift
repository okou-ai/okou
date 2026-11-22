import ChatDataTestSupport
import Foundation
import XCTest

@testable import ChatData

private typealias FixtureData = ConnectorHTTPFixtures

@MainActor
final class ChatConnectorInputTests: XCTestCase {
  func testStripeStartsWithTheAppCallbackAndAddIntent() async throws {
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/connector-catalog/stripe":
        return ChatHTTPResponse(
          body: FixtureData.catalog(grantKind: "auth-code", slug: "stripe"))
      case "/api/connectors/stripe/oauth/start":
        XCTAssertEqual(request.httpMethod, "POST")
        let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? NSDictionary
        XCTAssertEqual(
          body, ["account": ["intent": "add"], "authMethod": "oauth", "callbackTarget": "app"])
        return ChatHTTPResponse(
          body: """
            {"oauthAttemptId":"\(FixtureData.attemptID)","authorizationUrl":"https://provider.example.invalid/authorize"}
            """)
      default: return try XCTUnwrap(FixtureData.response(request))
      }
    }
    let service = ChatConnectorService(client: fixture.client)
    let loaded = try await service.status(
      .configuration(
        target: .builtin("stripe"), threadID: FixtureData.threadID))
    let status = try XCTUnwrap(loaded)
    let receipt = try await service.start(
      status: status, method: status.builtin?.authMethods.first, values: [:], options: [:])
    XCTAssertEqual(receipt.oauthAttemptId, FixtureData.attemptID)
  }

  func testDeviceAuthorizationUsesOnlyDeclaredOptionsWithSelectionOverridingTheDefault()
    async throws
  {
    for mode in ["test", "live"] {
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/connector-catalog/slack":
          let option = """
            {"id":"mode","label":"Mode","required":true,"defaultValue":"test","options":[{"value":"test","label":"Test"},{"value":"live","label":"Live"}]}
            """
          return ChatHTTPResponse(
            body: FixtureData.catalog(grantKind: "device-auth", startOptionsJSON: "[\(option)]"))
        case "/api/connectors/slack/oauth/device/sessions":
          let body =
            try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? NSDictionary
          XCTAssertEqual(
            body, ["account": ["intent": "add"], "authMethod": "oauth", "options": ["mode": mode]])
          return ChatHTTPResponse(body: "{\"sessionId\":\"\(FixtureData.attemptID)\"}")
        default: return try XCTUnwrap(FixtureData.response(request))
        }
      }
      let service = ChatConnectorService(client: fixture.client)
      let loaded = try await service.status(
        .configuration(
          target: .builtin("slack"), threadID: FixtureData.threadID))
      let status = try XCTUnwrap(loaded)
      var options = ["other-method": "unused"]
      if mode == "live" { options["mode"] = mode }
      let receipt = try await service.start(
        status: status, method: status.builtin?.authMethods.first, values: [:], options: options)
      XCTAssertEqual(receipt.sessionId, FixtureData.attemptID)
    }
  }

  func testCustomReconnectSendsOnlyEditedFieldsAndPreservesVariableSpaces() async throws {
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/custom-connectors/\(FixtureData.customID)":
        let fields = """
          [{"key":"saved","label":"Saved key","kind":"secret","required":true},
           {"key":"name","label":"Name","kind":"variable","required":true},
           {"key":"blank","label":"Optional","kind":"secret","required":false}]
          """
        return ChatHTTPResponse(
          body: FixtureData.custom(mode: "manual", fieldsJSON: fields))
      case "/api/connector-accounts/\(FixtureData.accountID)":
        return ChatHTTPResponse(
          body: FixtureData.account(
            custom: true, connected: false, missingRequiredFieldsJSON: #"["name"]"#))
      case "/api/custom-connectors/\(FixtureData.customID)/values":
        XCTAssertEqual(request.httpMethod, "PUT")
        let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as? NSDictionary
        XCTAssertEqual(
          body,
          [
            "account": ["intent": "reconnect", "connectionId": FixtureData.accountID],
            "values": [["key": "name", "kind": "variable", "value": "Desk One"]]
          ])
        return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
      default: return try XCTUnwrap(FixtureData.response(request))
      }
    }
    let service = ChatConnectorService(client: fixture.client)
    let loaded = try await service.status(
      .configuration(
        target: .custom(FixtureData.customID),
        threadID: FixtureData.threadID, connectionID: FixtureData.accountID))
    let status = try XCTUnwrap(loaded)
    let custom = try XCTUnwrap(status.custom)
    XCTAssertFalse(custom.canSubmit(values: ["name": "\u{FEFF} "], account: status.account))
    let edits = ["name": "\u{FEFF}Desk One\t", "blank": "\n", "undeclared": "unused"]
    XCTAssertFalse(custom.canSubmit(values: edits, account: nil))
    let receipt = try await service.start(status: status, method: nil, values: edits, options: [:])
    XCTAssertEqual(try receipt.operatedID, FixtureData.accountID)
  }

  func testAccountLookupPreservesPlusInSearchAndPagination() async throws {
    let fixture = ChatHTTPFixture { request in
      let url = try XCTUnwrap(request.url)
      XCTAssertEqual(url.path, "/api/connector-accounts/connections")
      let encoded = try XCTUnwrap(
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery)
      XCTAssertTrue(encoded.contains("search=user%2Bteam"))
      XCTAssertTrue(encoded.contains("cursor=next%2Bpage"))
      return ChatHTTPResponse(
        body: #"{"connections":[],"nextCursor":null,"defaultConnection":null}"#)
    }
    let page = try await ChatComposerAccess(client: fixture.client).accounts(
      target: .builtin("stripe"), search: "  user+team", cursor: "next+page")
    XCTAssertTrue(page.connections.isEmpty)
  }
}
