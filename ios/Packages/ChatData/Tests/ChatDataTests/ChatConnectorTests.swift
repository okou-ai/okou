import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

private typealias F = ConnectorHTTPFixtures

@MainActor
final class ChatConnectorTests: XCTestCase {
  private let webURL = URL(string: "https://app.example.invalid")!
  private func action(_ path: String = "/connectors/slack/connect") throws -> ChatConnectorAction {
    try XCTUnwrap(
      ChatConnectorAction.parse(
        path + "?agentId=\(F.agentID)&threadId=\(F.threadID)&callbackPrompt=Continue",
        webURL: webURL, agentID: F.agentID, threadID: F.threadID))
  }
  func testTrustedReferencesFenceOriginAgentThreadAndMalformedCallbacks() throws {
    XCTAssertEqual(try action().kind, .connect(slug: "slack"))
    XCTAssertEqual(try action("/connectors/_internal/connect").kind, .connect(slug: "_internal"))
    XCTAssertEqual(
      try action("/connectors/slack/reconnect/\(F.accountID)").kind,
      .reconnect(slug: "slack", connectionID: F.accountID))
    for origin in [
      "https://evil.invalid", "https://app.example.invalid.evil.invalid",
      "http://app.example.invalid", "https://user@app.example.invalid",
      "https://app.example.invalid:8443",
    ] {
      XCTAssertNil(
        ChatConnectorAction.parse(
          origin + "/connectors/slack/connect?agentId=\(F.agentID)", webURL: webURL,
          agentID: F.agentID, threadID: F.threadID))
    }
    for value in [
      "/connectors/slack/connect?agentId=\(F.siblingID)",
      "/connectors/slack/connect?agentId=\(F.agentID)&threadId=\(F.siblingID)&callbackPrompt=Continue",
      "/connectors/slack/connect?agentId=\(F.agentID)&threadId=\(F.threadID)",
      "/connectors/slack/connect?agentId=\(F.agentID)&callbackPrompt=Continue",
      "/connectors/slack/connect?agentId=\(F.agentID)&agentId=\(F.siblingID)",
      "/connectors/_internal/authorize?agentId=\(F.agentID)",
      "/connectors/slack/reconnect/not-an-id?agentId=\(F.agentID)",
    ] {
      XCTAssertEqual(
        ChatConnectorAction.parse(value, webURL: webURL, agentID: F.agentID, threadID: F.threadID)?
          .kind, .unavailable, value)
    }
  }
  func testCallbackUsesFormQueryDecodingAndPreservesItsOriginalReference() throws {
    let value =
      "/connectors/slack/connect?agentId=\(F.agentID)&threadId=\(F.threadID)"
      + "&callbackPrompt=I+connected+Slack%2BChat+%26+Docs%2E"
    let action = try XCTUnwrap(
      ChatConnectorAction.parse(value, webURL: webURL, agentID: F.agentID, threadID: F.threadID))
    XCTAssertEqual(action.kind, .connect(slug: "slack"))
    XCTAssertEqual(action.callbackPrompt, "I connected Slack+Chat & Docs.")
    XCTAssertEqual(action.id, value)
  }
  func testAccountConfirmationValidatesExactTargetAndRequiresCallback() throws {
    let path = "/agents/\(F.agentID)/connector-accounts/\(F.accountID)/select"
    let valid =
      path
      + "?kind=custom&customConnectorId=\(F.customID)&threadId=\(F.threadID)&callbackPrompt=Continue"
    XCTAssertEqual(
      ChatConnectorAction.parse(valid, webURL: webURL, agentID: F.agentID, threadID: F.threadID)?
        .kind, .select(target: .custom(F.customID), connectionID: F.accountID))
    for suffix in [
      "?kind=builtin&connectorSlug=slack",
      "?kind=custom&customConnectorId=\(F.customID)&connectorSlug=slack&threadId=\(F.threadID)&callbackPrompt=Continue",
    ] {
      XCTAssertEqual(
        ChatConnectorAction.parse(
          path + suffix, webURL: webURL, agentID: F.agentID, threadID: F.threadID)?.kind,
        .unavailable)
    }
  }
  func testExactReconnectUsesOwnedAccountAndTargetNotDefaultAccount() async throws {
    let fixture = ChatHTTPFixture { request in
      if request.url?.path == "/api/connector-accounts/\(F.accountID)" {
        XCTAssertEqual(connectorQuery("kind", in: request), "builtin")
        XCTAssertEqual(connectorQuery("connectorSlug", in: request), "slack")
        return ChatHTTPResponse(body: F.account(connected: false))
      }
      return try XCTUnwrap(F.response(request))
    }
    let status = try await ChatConnectorService(client: fixture.client).status(
      action("/connectors/slack/reconnect/\(F.accountID)"))
    XCTAssertEqual(status?.account?.id, F.accountID)
    XCTAssertFalse(try XCTUnwrap(status).connected)
  }
  func testWrongAccountIdentityNeverGrantsReadiness() async throws {
    for body in [
      F.account(id: F.siblingID), F.account().replacingOccurrences(of: "slack", with: "github"),
    ] {
      let fixture = ChatHTTPFixture { _ in ChatHTTPResponse(body: body) }
      do {
        _ = try await ChatConnectorService(client: fixture.client).account(
          id: F.accountID, target: .builtin("slack"))
        XCTFail("Expected account identity rejection")
      } catch APIClientError.invalidResponse {}
    }
  }
  func testConfigurationAttentionPreservesTheExactAccountAndReason() async throws {
    for reason in ["configuration_incomplete", "configuration_invalid"] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/\(F.accountID)" {
          return ChatHTTPResponse(body: F.account(connected: false, reconnectReason: reason))
        }
        return try XCTUnwrap(F.response(request))
      }
      let loaded = try await ChatConnectorService(client: fixture.client).status(
        action("/connectors/slack/reconnect/\(F.accountID)"))
      let status = try XCTUnwrap(loaded)
      XCTAssertEqual(status.account?.id, F.accountID)
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
            custom ? F.customID : "slack")
          XCTAssertEqual(connectorQuery("limit", in: request), "1")
          return ChatHTTPResponse(
            body: """
              {"connections":[\(F.account(id: F.siblingID, custom: custom, isDefault: false))],"nextCursor":"next-page","defaultConnection":\(F.account(custom: custom))}
              """)
        }
        return try XCTUnwrap(F.response(request))
      }
      let status = try await ChatConnectorService(client: fixture.client).status(
        action(custom ? "/connectors/_internal/connect" : "/connectors/slack/connect"))
      XCTAssertEqual(status?.account?.id, F.accountID)
      XCTAssertTrue(try XCTUnwrap(status).connected)
    }
  }
  func testSavedAccountsWithoutDefaultRemainAnActionableFailure() async throws {
    for custom in [false, true] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(
            body: """
              {"connections":[\(F.account(custom: custom, isDefault: false))],"nextCursor":null,"defaultConnection":null}
              """)
        }
        return try XCTUnwrap(F.response(request))
      }
      do {
        _ = try await ChatConnectorService(client: fixture.client).status(
          action(custom ? "/connectors/_internal/connect" : "/connectors/slack/connect"))
        XCTFail("Expected an explicit default-account choice")
      } catch let error as APIClientError {
        XCTAssertEqual(error.statusCode, 409)
      }
    }
  }
  func testMalformedAccountInventoryCannotBecomeAnAddIntent() async throws {
    let responses = [
      "{\"connections\":[],\"nextCursor\":null}",
      "{\"connections\":[],\"defaultConnection\":null}",
    ]
    for body in responses {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(body: body)
        }
        return try XCTUnwrap(F.response(request))
      }
      do {
        _ = try await ChatConnectorService(client: fixture.client).status(action())
        XCTFail("Expected incomplete account inventory rejection")
      } catch APIClientError.incompatibleData {}
    }
  }
  func testAccountPageRejectsForeignTargetsAndMalformedDefaultIdentity() async throws {
    let responses = [
      "{\"connections\":[],\"nextCursor\":null,\"defaultConnection\":\(F.account(custom: true))}",
      "{\"connections\":[],\"nextCursor\":null,\"defaultConnection\":\(F.account(id: "not-an-id"))}",
      "{\"connections\":[\(F.account(custom: true))],\"nextCursor\":null,\"defaultConnection\":null}",
    ]
    for body in responses {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == "/api/connector-accounts/connections" {
          return ChatHTTPResponse(body: body)
        }
        return try XCTUnwrap(F.response(request))
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
        return try XCTUnwrap(F.response(request))
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
        return try XCTUnwrap(F.response(request))
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
      return ChatHTTPResponse(body: "{\"agentId\":\"\(F.siblingID)\"}")
    }
    let status = try await ChatConnectorService(client: fixture.client).status(action())
    XCTAssertNil(status)
  }
  func testBuiltinGrantKindsUseExistingRoutesAndExactReconnectIntent() async throws {
    let routes = [
      "none": "no-auth", "manual": "manual-grant", "auth-code": "oauth/start",
      "automatic": "automatic/start", "openid-auth": "openid/start",
      "device-auth": "oauth/device/sessions", "external-code": "external-code/sessions",
    ]
    for (kind, route) in routes {
      let fixture = ChatHTTPFixture { request in
        if request.httpMethod == "POST" {
          XCTAssertEqual(request.url!.path, "/api/connectors/slack/\(route)")
          let body = String(decoding: chatRequestBody(request), as: UTF8.self)
          XCTAssertTrue(body.contains("\"authorizeAgent\":true"))
          XCTAssertTrue(body.contains(F.accountID))
          XCTAssertTrue(body.contains("\"intent\":\"reconnect\""))
          return ChatHTTPResponse(body: "{\"connectionId\":\"\(F.accountID)\"}")
        }
        return try XCTUnwrap(F.response(request, grantKind: kind))
      }
      let service = ChatConnectorService(client: fixture.client)
      let descriptor = try action("/connectors/slack/reconnect/\(F.accountID)")
      let response = try await service.status(descriptor)
      let status = try XCTUnwrap(response)
      let receipt = try await service.start(
        descriptor, status: status, method: status.builtin?.authMethods.first,
        values: ["key": "synthetic-key"], options: [:])
      XCTAssertEqual(try receipt.operatedID, F.accountID)
    }
  }
  func testCustomManualNoAuthAndOAuthUseOwnedCustomTarget() async throws {
    for mode in ["manual", "none", "oauth", "automatic"] {
      let fixture = ChatHTTPFixture { request in
        if request.httpMethod == "POST" || request.httpMethod == "PUT" {
          XCTAssertEqual(
            request.url!.path,
            "/api/custom-connectors/\(F.customID)/\(["oauth", "automatic"].contains(mode) ? "oauth2/start" : "values")"
          )
          let body = String(decoding: chatRequestBody(request), as: UTF8.self)
          XCTAssertTrue(body.contains(F.agentID) || body.contains("\"values\":[]"))
          XCTAssertFalse(body.contains("authorizeAgent"))
          XCTAssertTrue(body.contains("\"intent\":\"add\""))
          return ChatHTTPResponse(
            body: ["oauth", "automatic"].contains(mode)
              ? "{\"result\":\"connected\",\"connector\":\(F.custom(mode: mode)),\"connectionId\":\"\(F.accountID)\"}"
              : String(F.custom(mode: mode).dropLast()) + ",\"connectionId\":\"\(F.accountID)\"}")
        }
        return try XCTUnwrap(F.response(request, connected: false, customMode: mode))
      }
      let service = ChatConnectorService(client: fixture.client)
      let descriptor = try action("/connectors/_internal/connect")
      let response = try await service.status(descriptor)
      let status = try XCTUnwrap(response)
      let receipt = try await service.start(
        descriptor, status: status, method: nil, values: [:], options: [:])
      XCTAssertEqual(try receipt.operatedID, F.accountID)
    }
  }
  func testContinuationRejectsThreadReassignmentBeforeMutatingSettingsOrSending() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.httpMethod, "GET")
      XCTAssertTrue(request.url!.path.hasSuffix("/metadata"))
      return ChatHTTPResponse(
        body: F.metadata.replacingOccurrences(of: F.agentID, with: F.siblingID))
    }
    let sync = ChatSync(client: fixture.client)
    let commands = ChatCommands(client: fixture.client, sync: sync)
    let thread = ChatThread(
      id: F.threadID, agentID: F.agentID, title: "Test", createdAt: .distantPast,
      updatedAt: .distantPast, sortAt: .distantPast, pinnedAt: nil, pinOrder: nil)
    do {
      _ = try await commands.send(thread: thread, text: "Continue", expectedAgentID: F.agentID)
      XCTFail("Expected reassigned Agent rejection")
    } catch ChatError.agentUnavailable {}
  }
  func testOAuthCompletionAndOperationReceiptDoNotBorrowDefaultIdentity() async throws {
    let fixture = ChatHTTPFixture { request in
      XCTAssertEqual(request.url!.path, "/api/connector-accounts/oauth-completions/\(F.attemptID)")
      XCTAssertEqual(connectorQuery("kind", in: request), "custom")
      XCTAssertEqual(connectorQuery("customConnectorId", in: request), F.customID)
      return ChatHTTPResponse(status: 404, body: "{\"error\":{\"message\":\"Pending\"}}")
    }
    let result = try await ChatConnectorService(client: fixture.client).oauthCompletion(
      attemptID: F.attemptID, target: .custom(F.customID))
    XCTAssertNil(result)
    for body in [
      "{}", "{\"connectionId\":\"not-an-id\"}",
    ] {
      let receipt = try JSONDecoder().decode(ChatConnectorReceipt.self, from: Data(body.utf8))
      XCTAssertThrowsError(try receipt.operatedID)
    }
  }
}

private func connectorQuery(_ name: String, in request: URLRequest) -> String? {
  request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?.queryItems?.first
  { $0.name == name }?.value
}
