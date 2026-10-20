import ChatDataTestSupport
import Foundation
import XCTest

@testable import ChatData

final class ChatPermissionTests: XCTestCase {
  func testMetadataServiceAndAuthorizationFailuresRemainErrors() async throws {
    for status in [403, 503] {
      var state = PermissionHTTPFixture.State()
      state.metadataStatus = status
      let fixture = PermissionHTTPFixture(initial: state)
      do {
        _ = try await ChatPermissions(client: fixture.http.client).load(try action())
        XCTFail("Required metadata failure cannot become an unavailable permission")
      } catch let error as APIClientError { XCTAssertEqual(error.statusCode, status) }
    }
  }

  func testTrustedOriginsAndCallbackValidationCannotPromoteForeignClaims() throws {
    let webURL = URL(string: "https://app.okou.ai")!
    let relative = PermissionHTTPFixture.actionURL()
    for prefix in ["", "https://app.okou.ai", "https://api.okou.ai", "https://dev-platform.vm7.ai"]
    {
      XCTAssertNotNil(ChatPermissionAction.trustedURL(prefix + relative, webURL: webURL))
    }
    for prefix in [
      "https://evil.invalid", "https://app.okou.ai.evil.invalid",
      "https://app.okou.ai@evil.invalid", "https://files.vm7.ai",
    ] {
      XCTAssertNil(ChatPermissionAction.trustedURL(prefix + relative, webURL: webURL))
    }
    for suffix in [
      "&threadId=\(PermissionHTTPFixture.threadID)", "&callbackPrompt=Continue",
      "&callbackPrompt=%20&threadId=\(PermissionHTTPFixture.threadID)", "&permission=another",
    ] {
      let source = PermissionHTTPFixture.actionURL(callback: false) + suffix
      let url = try XCTUnwrap(ChatPermissionAction.trustedURL(source, webURL: webURL))
      XCTAssertNil(
        ChatPermissionAction(
          url: url, agentID: PermissionHTTPFixture.agentID, threadID: PermissionHTTPFixture.threadID
        ))
    }
  }

  func testApplyUsesCurrentUserScopePatchAndExactDurationThenReadsBack() async throws {
    for duration in ChatPermissionAction.Duration.allCases {
      let fixture = PermissionHTTPFixture()
      let service = ChatPermissions(client: fixture.http.client)
      let action = try action()
      _ = try await service.apply(action, duration: duration)
      let saved = try await service.load(action)
      XCTAssertEqual(saved.grants.first?.action, .allow)
      XCTAssertEqual(saved.metadata?.label, "Gmail")
      let request = try XCTUnwrap(
        fixture.state.withLock { $0.requests.first { $0.httpMethod == "PUT" } })
      let body = try body(request)
      XCTAssertEqual(body["agentId"] as? String, PermissionHTTPFixture.agentID)
      XCTAssertEqual(body["connectorSlug"] as? String, "gmail")
      XCTAssertEqual(body["mode"] as? String, "patch")
      let grant = try XCTUnwrap((body["grants"] as? [[String: String]])?.first)
      XCTAssertEqual(
        grant, ["permission": "mail.send", "action": "allow", "expiresIn": duration.rawValue])
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
    }
  }

  func testDenyHasNoExpirationAndAlreadyAppliedGrantDoesNotWriteAgain() async throws {
    let fixture = PermissionHTTPFixture()
    let service = ChatPermissions(client: fixture.http.client)
    let action = try action("deny")
    _ = try await service.apply(action, duration: .week)
    _ = try await service.apply(action, duration: .day)
    let requests = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    XCTAssertEqual(requests.count, 1)
    let grant = try XCTUnwrap(
      (try body(XCTUnwrap(requests.first))["grants"] as? [[String: String]])?.first)
    XCTAssertEqual(grant, ["permission": "mail.send", "action": "deny"])
    let saved = try await service.load(action)
    XCTAssertEqual(saved.grants.first?.action, .deny)
    XCTAssertNil(saved.grants.first?.expiresAt)
  }

  func testMissingMetadataOrReassignedThreadCannotWrite() async throws {
    for missingMetadata in [false, true] {
      var state = PermissionHTTPFixture.State()
      state.missingMetadata = missingMetadata
      if !missingMetadata { state.threadAgentID = UUID().uuidString }
      let fixture = PermissionHTTPFixture(initial: state)
      do {
        _ = try await ChatPermissions(client: fixture.http.client).apply(
          try action(), duration: .hour)
        XCTFail("Invalid requests must not apply permissions")
      } catch {}
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    }
  }

  func testExpiredGrantsDoNotOverrideMetadataAndUnknownEndpointUsesItsPolicy() async throws {
    var state = PermissionHTTPFixture.State()
    state.grants = PermissionHTTPFixture.grant(expiration: "2020-01-01T00:00:00Z")
    let fixture = PermissionHTTPFixture(initial: state)
    let snapshot = try await ChatPermissions(client: fixture.http.client).load(try action())
    let metadata = try XCTUnwrap(snapshot.metadata)
    XCTAssertEqual(metadata.policy(for: "mail.send", grants: snapshot.grants, at: .now), .ask)
    XCTAssertTrue(metadata.contains("__unknown__"))
    XCTAssertFalse(metadata.contains("removed.permission"))
    XCTAssertEqual(metadata.policy(for: "__unknown__", grants: snapshot.grants, at: .now), .ask)
  }

  func testDescriptorRejectsMismatchedContextAndPreservesLegacyRefAndDeny() throws {
    let source = PermissionHTTPFixture.actionURL(action: "deny").replacingOccurrences(
      of: "connectorSlug=", with: "ref=")
    let url = try XCTUnwrap(URL(string: source, relativeTo: URL(string: "https://app.okou.ai")!))
    let parsed = try XCTUnwrap(
      ChatPermissionAction(
        url: url, agentID: PermissionHTTPFixture.agentID, threadID: PermissionHTTPFixture.threadID))
    XCTAssertEqual(parsed.action, .deny)
    XCTAssertEqual(parsed.connectorSlug, "gmail")
    XCTAssertNil(
      ChatPermissionAction(url: url, agentID: UUID().uuidString, threadID: parsed.threadID))
    XCTAssertNil(
      ChatPermissionAction(url: url, agentID: parsed.agentID, threadID: UUID().uuidString))
  }

  private func action(_ value: String = "allow") throws -> ChatPermissionAction {
    let url = try XCTUnwrap(
      URL(
        string: PermissionHTTPFixture.actionURL(action: value),
        relativeTo: URL(string: "https://app.okou.ai")!))
    return try XCTUnwrap(
      ChatPermissionAction(
        url: url, agentID: PermissionHTTPFixture.agentID, threadID: PermissionHTTPFixture.threadID))
  }

  private func body(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }
}
