import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

private typealias FixtureData = ConnectorHTTPFixtures

@MainActor
final class ChatConnectorTests: XCTestCase {
  private let webURL = URL(string: "https://app.example.invalid")!
  private func action(_ path: String = "/connectors/slack/connect") throws -> ChatConnectorAction {
    try XCTUnwrap(
      ChatConnectorAction.parse(
        path
          + "?agentId=\(FixtureData.agentID)&threadId=\(FixtureData.threadID)&callbackPrompt=Continue",
        webURL: webURL, agentID: FixtureData.agentID, threadID: FixtureData.threadID))
  }
  func testTrustedReferencesFenceOriginAgentThreadAndMalformedCallbacks() throws {
    XCTAssertEqual(try action().kind, .connect(slug: "slack"))
    XCTAssertEqual(try action("/connectors/_internal/connect").kind, .connect(slug: "_internal"))
    XCTAssertEqual(
      try action("/connectors/slack/reconnect/\(FixtureData.accountID)").kind,
      .reconnect(slug: "slack", connectionID: FixtureData.accountID))
    for origin in [
      "https://evil.invalid", "https://app.example.invalid.evil.invalid",
      "http://app.example.invalid", "https://user@app.example.invalid",
      "https://app.example.invalid:8443"
    ] {
      XCTAssertNil(
        ChatConnectorAction.parse(
          origin + "/connectors/slack/connect?agentId=\(FixtureData.agentID)", webURL: webURL,
          agentID: FixtureData.agentID, threadID: FixtureData.threadID))
    }
    for value in [
      "/connectors/slack/connect?agentId=\(FixtureData.siblingID)",
      "/connectors/slack/connect?agentId=\(FixtureData.agentID)&threadId=\(FixtureData.siblingID)&callbackPrompt=Continue",
      "/connectors/slack/connect?agentId=\(FixtureData.agentID)&threadId=\(FixtureData.threadID)",
      "/connectors/slack/connect?agentId=\(FixtureData.agentID)&callbackPrompt=Continue",
      "/connectors/slack/connect?agentId=\(FixtureData.agentID)&agentId=\(FixtureData.siblingID)",
      "/connectors/_internal/authorize?agentId=\(FixtureData.agentID)",
      "/connectors/slack/reconnect/not-an-id?agentId=\(FixtureData.agentID)"
    ] {
      XCTAssertEqual(
        ChatConnectorAction.parse(
          value, webURL: webURL, agentID: FixtureData.agentID, threadID: FixtureData.threadID)?
          .kind, .unavailable, value)
    }
  }
  func testCallbackUsesFormQueryDecodingAndPreservesItsOriginalReference() throws {
    let value =
      "/connectors/slack/connect?agentId=\(FixtureData.agentID)&threadId=\(FixtureData.threadID)"
      + "&callbackPrompt=I+connected+Slack%2BChat+%26+Docs%2E"
    let action = try XCTUnwrap(
      ChatConnectorAction.parse(
        value, webURL: webURL, agentID: FixtureData.agentID, threadID: FixtureData.threadID))
    XCTAssertEqual(action.kind, .connect(slug: "slack"))
    XCTAssertEqual(action.callbackPrompt, "I connected Slack+Chat & Docs.")
    XCTAssertEqual(action.id, value)
  }
  func testAccountConfirmationValidatesExactTargetAndRequiresCallback() throws {
    let path = "/agents/\(FixtureData.agentID)/connector-accounts/\(FixtureData.accountID)/select"
    let valid =
      path
      + "?kind=custom&customConnectorId=\(FixtureData.customID)&threadId=\(FixtureData.threadID)&callbackPrompt=Continue"
    XCTAssertEqual(
      ChatConnectorAction.parse(
        valid, webURL: webURL, agentID: FixtureData.agentID, threadID: FixtureData.threadID)?
        .kind, .select(target: .custom(FixtureData.customID), connectionID: FixtureData.accountID))
    for suffix in [
      "?kind=builtin&connectorSlug=slack",
      "?kind=custom&customConnectorId=\(FixtureData.customID)&connectorSlug=slack&threadId=\(FixtureData.threadID)&callbackPrompt=Continue"
    ] {
      XCTAssertEqual(
        ChatConnectorAction.parse(
          path + suffix, webURL: webURL, agentID: FixtureData.agentID,
          threadID: FixtureData.threadID)?.kind,
        .unavailable)
    }
  }
  func testExactReconnectUsesOwnedAccountAndTargetNotDefaultAccount() async throws {
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/connector-accounts/\(FixtureData.accountID)" {
        XCTAssertEqual(connectorQuery("kind", in: request), "builtin")
        XCTAssertEqual(connectorQuery("connectorSlug", in: request), "slack")
        return ChatHTTPResponse(body: FixtureData.account(connected: false))
      }
      return try XCTUnwrap(FixtureData.response(request))
    }
    let status = try await ChatConnectorService(client: fixture.client).status(
      action("/connectors/slack/reconnect/\(FixtureData.accountID)"))
    XCTAssertEqual(status?.account?.id, FixtureData.accountID)
    XCTAssertFalse(try XCTUnwrap(status).connected)
  }
  func testWrongAccountIdentityNeverGrantsReadiness() async throws {
    for body in [
      FixtureData.account(id: FixtureData.siblingID),
      FixtureData.account().replacingOccurrences(of: "slack", with: "github")
    ] {
      let fixture = ChatHTTPFixture { _ in ChatHTTPResponse(body: body) }
      do {
        _ = try await ChatConnectorService(client: fixture.client).account(
          id: FixtureData.accountID, target: .builtin("slack"))
        XCTFail("Expected account identity rejection")
      } catch APIClientError.invalidResponse {}
    }
  }
  func testConfigurationAttentionPreservesTheExactAccountAndReason() async throws {
    for reason in ["configuration_incomplete", "configuration_invalid"] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/\(FixtureData.accountID)" {
          return ChatHTTPResponse(
            body: FixtureData.account(connected: false, reconnectReason: reason))
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      let loaded = try await ChatConnectorService(client: fixture.client).status(
        action("/connectors/slack/reconnect/\(FixtureData.accountID)"))
      let status = try XCTUnwrap(loaded)
      XCTAssertEqual(status.account?.id, FixtureData.accountID)
      XCTAssertEqual(status.account?.reconnectReason, reason)
      XCTAssertFalse(status.connected)
    }
  }
  func testTargetAccountPagePreservesAnOffPageDefault() async throws {
    for custom in [false, true] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          XCTAssertEqual(connectorQuery("kind", in: request), custom ? "custom" : "builtin")
          XCTAssertEqual(
            connectorQuery(custom ? "customConnectorId" : "connectorSlug", in: request),
            custom ? FixtureData.customID : "slack")
          XCTAssertEqual(connectorQuery("limit", in: request), "1")
          return ChatHTTPResponse(
            body: """
              {"connections":[\(FixtureData.account(id: FixtureData.siblingID, custom: custom, isDefault: false))],"nextCursor":"next-page","defaultConnection":\(FixtureData.account(custom: custom))}
              """)
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      let status = try await ChatConnectorService(client: fixture.client).status(
        action(custom ? "/connectors/_internal/connect" : "/connectors/slack/connect"))
      XCTAssertEqual(status?.account?.id, FixtureData.accountID)
      XCTAssertTrue(try XCTUnwrap(status).connected)
    }
  }
  func testSavedAccountsWithoutDefaultAllowConnectingAnotherAccount() async throws {
    for custom in [false, true] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(
            body: """
              {"connections":[\(FixtureData.account(custom: custom, isDefault: false))],"nextCursor":null,"defaultConnection":null}
              """)
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      let result = try await ChatConnectorService(client: fixture.client).status(
        action(custom ? "/connectors/_internal/connect" : "/connectors/slack/connect"))
      let status = try XCTUnwrap(result)
      XCTAssertNil(status.account)
      XCTAssertFalse(status.connected)
    }
  }
  func testMalformedAccountInventoryCannotBecomeAnAddIntent() async throws {
    let responses = [
      "{\"connections\":[],\"nextCursor\":null}",
      "{\"connections\":[],\"defaultConnection\":null}"
    ]
    for body in responses {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(body: body)
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      do {
        _ = try await ChatConnectorService(client: fixture.client).status(action())
        XCTFail("Expected incomplete account inventory rejection")
      } catch APIClientError.incompatibleData {}
    }
  }
  func testAccountPageRejectsForeignTargetsAndMalformedDefaultIdentity() async throws {
    let responses = [
      "{\"connections\":[],\"nextCursor\":null,\"defaultConnection\":\(FixtureData.account(custom: true))}",
      "{\"connections\":[],\"nextCursor\":null,\"defaultConnection\":\(FixtureData.account(id: "not-an-id"))}",
      "{\"connections\":[\(FixtureData.account(custom: true))],\"nextCursor\":null,\"defaultConnection\":null}"
    ]
    for body in responses {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(body: body)
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      do {
        _ = try await ChatConnectorService(client: fixture.client).status(action())
        XCTFail("Expected account inventory identity rejection")
      } catch APIClientError.invalidResponse {}
    }
  }
  func testAccountReadDependencyAndUpgradeErrorsRemainFailures() async throws {
    for code in [503, 426] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(
            status: code, body: "{\"error\":{\"message\":\"Unavailable\"}}")
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      do {
        _ = try await ChatConnectorService(client: fixture.client).status(action())
        XCTFail("Expected account read failure")
      } catch let error as APIClientError {
        XCTAssertEqual(error.statusCode, code)
      }
    }
  }
  func testMissingActionIsUnavailableButDependencyAndUpgradeFailuresRemainErrors() async throws {
    for code in [404, 503, 426] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-catalog/slack" {
          return ChatHTTPResponse(status: code, body: "{\"error\":{\"message\":\"Unavailable\"}}")
        }
        return try XCTUnwrap(FixtureData.response(request))
      }
      do {
        let status = try await ChatConnectorService(client: fixture.client).status(action())
        XCTAssertEqual(code, 404)
        XCTAssertNil(status)
      } catch let error as APIClientError {
        XCTAssertEqual(error.statusCode, code)
        XCTAssertNotEqual(code, 404)
      }
    }
  }
  func testThreadReassignmentRejectsAnOldActionBeforeConnectorReads() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertTrue(request.url!.path.hasSuffix("/metadata"))
      return ChatHTTPResponse(body: "{\"agentId\":\"\(FixtureData.siblingID)\"}")
    }
    let status = try await ChatConnectorService(client: fixture.client).status(action())
    XCTAssertNil(status)
  }
  func testBuiltinGrantKindsUseExistingRoutesAndExactReconnectIntent() async throws {
    let routes = [
      "none": "no-auth", "manual": "manual-grant", "auth-code": "oauth/start",
      "automatic": "automatic/start", "openid-auth": "openid/start",
      "device-auth": "oauth/device/sessions", "external-code": "external-code/sessions"
    ]
    for (kind, route) in routes {
      let fixture = ChatHTTPFixture { request in
        if request.httpMethod == "POST" {
          XCTAssertEqual(request.url!.path, "/api/connectors/slack/\(route)")
          let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
          let expectedKeys = Set(
            ["account", "authMethod"] + (kind == "manual" ? ["values"] : [])
              + (kind == "device-auth" ? ["options"] : []))
          XCTAssertEqual(Set(body.keys), expectedKeys)
          XCTAssertEqual(body["authMethod"] as? String, "oauth")
          let account = try XCTUnwrap(body["account"] as? [String: String])
          XCTAssertEqual(account["connectionId"], FixtureData.accountID)
          XCTAssertEqual(account["intent"], "reconnect")
          return ChatHTTPResponse(body: "{\"connectionId\":\"\(FixtureData.accountID)\"}")
        }
        return try XCTUnwrap(FixtureData.response(request, grantKind: kind))
      }
      let service = ChatConnectorService(client: fixture.client)
      let descriptor = try action("/connectors/slack/reconnect/\(FixtureData.accountID)")
      let response = try await service.status(descriptor)
      let status = try XCTUnwrap(response)
      let receipt = try await service.start(
        status: status, method: status.builtin?.authMethods.first,
        values: ["key": "synthetic-key"], options: [:])
      XCTAssertEqual(try receipt.operatedID, FixtureData.accountID)
    }
  }
  func testCustomManualNoAuthAndOAuthUseOwnedCustomTarget() async throws {
    for mode in ["manual", "none", "oauth", "automatic"] {
      let fixture = ChatHTTPFixture { request in
        if request.httpMethod == "POST" || request.httpMethod == "PUT" {
          XCTAssertEqual(
            request.url!.path,
            "/api/custom-connectors/\(FixtureData.customID)/\(["oauth", "automatic"].contains(mode) ? "oauth2/start" : "values")"
          )
          let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
          let keys: Set<String> =
            ["oauth", "automatic"].contains(mode)
            ? ["account"] : ["account", "values"]
          XCTAssertEqual(Set(body.keys), keys)
          XCTAssertEqual(body["account"] as? [String: String], ["intent": "add"])
          return ChatHTTPResponse(
            body: ["oauth", "automatic"].contains(mode)
              ? "{\"result\":\"connected\",\"connector\":\(FixtureData.custom(mode: mode)),\"connectionId\":\"\(FixtureData.accountID)\"}"
              : String(FixtureData.custom(mode: mode).dropLast())
                + ",\"connectionId\":\"\(FixtureData.accountID)\"}")
        }
        return try XCTUnwrap(FixtureData.response(request, connected: false, customMode: mode))
      }
      let service = ChatConnectorService(client: fixture.client)
      let descriptor = try action("/connectors/_internal/connect")
      let response = try await service.status(descriptor)
      let status = try XCTUnwrap(response)
      let receipt = try await service.start(
        status: status, method: nil, values: [:], options: [:])
      XCTAssertEqual(try receipt.operatedID, FixtureData.accountID)
    }
  }
  func testContinuationRejectsThreadReassignmentBeforeMutatingSettingsOrSending() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.httpMethod, "GET")
      XCTAssertTrue(request.url!.path.hasSuffix("/metadata"))
      return ChatHTTPResponse(
        body: FixtureData.metadata.replacingOccurrences(
          of: FixtureData.agentID, with: FixtureData.siblingID))
    }
    let sync = ChatSync(client: fixture.client)
    let commands = ChatCommands(client: fixture.client, sync: sync)
    let thread = ChatThread(
      id: FixtureData.threadID, agentID: FixtureData.agentID, title: "Test",
      createdAt: .distantPast,
      updatedAt: .distantPast, sortAt: .distantPast, pinnedAt: nil, pinOrder: nil)
    do {
      _ = try await commands.send(
        thread: thread, text: "Continue", expectedAgentID: FixtureData.agentID)
      XCTFail("Expected reassigned Agent rejection")
    } catch ChatError.agentUnavailable {}
  }
  func testOAuthCompletionAndOperationReceiptDoNotBorrowDefaultIdentity() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(
        request.url!.path, "/api/connector-accounts/oauth-completions/\(FixtureData.attemptID)")
      XCTAssertEqual(connectorQuery("kind", in: request), "custom")
      XCTAssertEqual(connectorQuery("customConnectorId", in: request), FixtureData.customID)
      return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Pending\"}}")
    }
    let result = try await ChatConnectorService(client: fixture.client).oauthCompletion(
      attemptID: FixtureData.attemptID, target: .custom(FixtureData.customID))
    XCTAssertNil(result)
    for body in [
      "{}", "{\"connectionId\":\"not-an-id\"}"
    ] {
      let receipt = try JSONDecoder().decode(ChatConnectorReceipt.self, from: Data(body.utf8))
      XCTAssertThrowsError(try receipt.operatedID)
    }
  }
}

private func connectorQuery(_ name: String, in request: URLRequest) -> String? {
  let items = request.url.flatMap {
    URLComponents(url: $0, resolvingAgainstBaseURL: false)
  }?.queryItems
  return items?.first { $0.name == name }?.value
}
