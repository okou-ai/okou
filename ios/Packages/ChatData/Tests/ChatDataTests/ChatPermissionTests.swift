import ChatDataTestSupport
import ChatDomain
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
    let unsupported = relative.replacingOccurrences(
      of: "/connectors/permissions", with: "/connectors/unsupported")
    XCTAssertNil(ChatPermissionAction.trustedURL(unsupported, webURL: webURL))
    for prefix in [
      "", "https://app.okou.ai", "https://api.okou.ai", "https://dev-platform.vm7.ai"
    ] {
      XCTAssertNotNil(ChatPermissionAction.trustedURL(prefix + relative, webURL: webURL))
    }
    for prefix in [
      "https://evil.invalid", "https://app.okou.ai.evil.invalid",
      "https://app.okou.ai@evil.invalid", "https://files.vm7.ai"
    ] {
      XCTAssertNil(ChatPermissionAction.trustedURL(prefix + relative, webURL: webURL))
    }
    for suffix in [
      "&threadId=\(PermissionHTTPFixture.threadID)", "&callbackPrompt=Continue",
      "&callbackPrompt=%20&threadId=\(PermissionHTTPFixture.threadID)", "&permission=another",
      "&orgId=another", "&userId=another", "&callbackPrompt", "&threadId"
    ] {
      let source = PermissionHTTPFixture.actionURL(callback: false) + suffix
      let url = try XCTUnwrap(ChatPermissionAction.trustedURL(source, webURL: webURL))
      XCTAssertNil(
        ChatPermissionAction(
          url: url, threadID: PermissionHTTPFixture.threadID
        ))
    }
  }

  func testApplyUsesCurrentUserScopePatchAndExactDurationThenReadsBack() async throws {
    for duration in ChatPermissionAction.Duration.allCases {
      let fixture = PermissionHTTPFixture()
      let service = ChatPermissions(client: fixture.http.client)
      let action = try action()
      let reviewed = try await service.load(action)
      let receipt = try await service.apply(action, duration: duration, reviewing: reviewed)
      let saved = try await service.load(action)
      XCTAssertEqual(saved.grants.first?.action, .allow)
      XCTAssertEqual(saved.metadata?.label, "Gmail")
      XCTAssertEqual(receipt.grants, saved.grants)
      let request = try XCTUnwrap(
        fixture.state.withLock { $0.requests.first { $0.httpMethod == "PUT" } })
      let body = try body(request)
      XCTAssertEqual(request.url?.path, "/api/connector-permissions")
      XCTAssertEqual(
        body["target"] as? [String: String], ["kind": "builtin", "connectorSlug": "gmail"])
      XCTAssertEqual(body["mode"] as? String, "patch")
      let grant = try XCTUnwrap((body["grants"] as? [[String: String]])?.first)
      XCTAssertEqual(
        grant, ["permission": "mail.send", "action": "allow", "expiresIn": duration.rawValue])
      XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
    }
  }

  func testOnlyTheAddressedMemberCanReviewOrConfirmAnOrdinaryRequest() async throws {
    let fixture = PermissionHTTPFixture()
    let service = ChatPermissions(client: fixture.http.client)
    let origin = fixture.http.baseURL
    let link = PermissionHTTPFixture.actionURL(callback: false)
    func parsed(_ link: String) throws -> ChatPermissionAction {
      let url = try XCTUnwrap(ChatPermissionAction.trustedURL(link, webURL: origin))
      return try XCTUnwrap(ChatPermissionAction(url: url, threadID: PermissionHTTPFixture.threadID))
    }
    let own = try parsed(link)
    let reviewed = try await service.load(own)
    let count = fixture.state.withLock { $0.requests.count }
    for other in [
      link.replacingOccurrences(of: ChatHTTPFixture.workspaceID, with: "org_other"),
      link.replacingOccurrences(of: ChatHTTPFixture.userID, with: "user_other")
    ] {
      let foreign = try parsed(other)
      do {
        _ = try await service.load(foreign)
        XCTFail("A different member cannot review the request")
      } catch ChatError.invalidContract {}
      do {
        _ = try await service.apply(foreign, duration: .hour, reviewing: reviewed)
        XCTFail("A previous review cannot authorize a different member")
      } catch ChatError.invalidContract {}
    }
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, count)
    _ = try await service.apply(own, duration: .hour, reviewing: reviewed)
    XCTAssertFalse(
      fixture.state.withLock {
        $0.requests.contains { $0.url!.path.hasPrefix("/api/chat-threads/") }
      })
  }

  func testDenyHasNoExpirationAndAlreadyAppliedGrantDoesNotWriteAgain() async throws {
    let fixture = PermissionHTTPFixture()
    let service = ChatPermissions(client: fixture.http.client)
    let action = try action("deny")
    let reviewed = try await service.load(action)
    let receipt = try await service.apply(action, duration: .week, reviewing: reviewed)
    _ = try await service.apply(action, duration: .day, reviewing: receipt)
    let requests = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    XCTAssertEqual(requests.count, 1)
    let grant = try XCTUnwrap(
      (try body(XCTUnwrap(requests.first))["grants"] as? [[String: String]])?.first)
    XCTAssertEqual(grant, ["permission": "mail.send", "action": "deny"])
    let saved = try await service.load(action)
    XCTAssertEqual(saved.grants.first?.action, .deny)
    XCTAssertNil(saved.grants.first?.expiresAt)
  }

  func testMissingMetadataOrMismatchedThreadCannotWrite() async throws {
    for missingMetadata in [false, true] {
      var state = PermissionHTTPFixture.State()
      state.missingMetadata = missingMetadata
      if !missingMetadata { state.metadataThreadID = UUID().uuidString }
      let fixture = PermissionHTTPFixture(initial: state)
      do {
        let service = ChatPermissions(client: fixture.http.client)
        let action = try action()
        let reviewed = try await service.load(action)
        _ = try await service.apply(action, duration: .hour, reviewing: reviewed)
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
      of: "connectorSlug=", with: "ref="
    ).replacingOccurrences(of: "Continue%20after%20permission", with: "Continue+after%2Bpermission")
    let url = try XCTUnwrap(URL(string: source, relativeTo: URL(string: "https://app.okou.ai")!))
    let parsed = try XCTUnwrap(
      ChatPermissionAction(
        url: url, threadID: PermissionHTTPFixture.threadID))
    XCTAssertEqual(parsed.action, .deny)
    XCTAssertEqual(parsed.connectorSlug, "gmail")
    XCTAssertEqual(parsed.callbackPrompt, "Continue after+permission")
    XCTAssertEqual(
      parsed.member,
      WorkspaceMemberID(userID: ChatHTTPFixture.userID, workspaceID: ChatHTTPFixture.workspaceID))
    XCTAssertNil(
      ChatPermissionAction(url: url, threadID: UUID().uuidString))
  }

  private func action(_ value: String = "allow") throws -> ChatPermissionAction {
    let url = try XCTUnwrap(
      URL(
        string: PermissionHTTPFixture.actionURL(action: value),
        relativeTo: URL(string: "https://app.okou.ai")!))
    return try XCTUnwrap(
      ChatPermissionAction(
        url: url, threadID: PermissionHTTPFixture.threadID))
  }

  private func body(_ request: URLRequest) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
  }
}
