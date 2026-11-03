import ChatDataTestSupport
import Foundation
import XCTest

@testable import ChatData

final class ChatBatchPermissionTests: XCTestCase {
  private typealias F = PermissionBatchHTTPFixture

  func testTrustedBatchLinkNormalizesDuplicatesAndPreservesCallbackEncoding() throws {
    let source = F.actionURL(items: F.items + [F.items[0]], duration: "24h")
      .replacingOccurrences(
        of: "Continue%20after%20permissions", with: "Continue+after%2Bpermissions")
    let action = try action(source)
    XCTAssertEqual(action.items.count, 4)
    XCTAssertEqual(action.duration, .day)
    XCTAssertEqual(action.callbackPrompt, "Continue after+permissions")
    for origin in ["https://app.okou.ai", "https://dev-platform.vm7.ai"] {
      XCTAssertNotNil(
        ChatPermissionBatchAction(
          value: origin + source, webURL: URL(string: "https://app.okou.ai")!,
          agentID: F.agentID, threadID: F.threadID))
    }
  }

  func testForeignMalformedAndMismatchedBatchLinksCannotBecomeActions() {
    let valid = F.actionURL()
    let rejected = [
      "https://evil.invalid" + valid,
      "https://app.okou.ai.evil.invalid" + valid,
      "https://user@app.okou.ai" + valid,
      valid + "#extra", valid + "&action=allow", valid + "&ref=gmail",
      valid + "&expiresIn=invalid", valid + "&expiresIn", valid + "&extra=%FF",
      valid.replacingOccurrences(of: "action=allow", with: "action=deny"),
      valid.replacingOccurrences(of: F.agentID, with: UUID().uuidString),
      valid.replacingOccurrences(of: F.threadID, with: UUID().uuidString),
      valid.replacingOccurrences(of: "callbackPrompt=", with: "unexpected="),
      " " + valid, valid + "\n",
    ]
    for value in rejected {
      XCTAssertNil(
        ChatPermissionBatchAction(
          value: value, webURL: URL(string: "https://app.okou.ai")!,
          agentID: F.agentID, threadID: F.threadID), value)
    }
  }

  func testEveryOriginalItemIsValidatedAndTwentyIsTheBatchLimit() throws {
    let twenty = (0..<20).map { ["connectorSlug": "gmail", "permission": "scope.\($0)"] }
    XCTAssertEqual(try action(F.actionURL(items: twenty)).items.count, 20)
    for rows in [
      [], twenty + [["connectorSlug": "gmail", "permission": "extra"]],
      [["connectorSlug": "gmail", "permission": ""]],
      [["connectorSlug": "gmail", "permission": String(repeating: "x", count: 129)]],
      [["connectorSlug": "Gmail", "permission": "mail.send"]],
      F.items + [["connectorSlug": "gmail", "permission": "mail.read", "extra": "invalid"]],
    ] {
      XCTAssertNil(
        ChatPermissionBatchAction(
          value: F.actionURL(items: rows), webURL: URL(string: "https://app.okou.ai")!,
          agentID: F.agentID, threadID: F.threadID))
    }
    XCTAssertNil(
      ChatPermissionBatchAction(
        value: F.actionURL() + "&callbackPrompt=" + String(repeating: "x", count: 8192),
        webURL: URL(string: "https://app.okou.ai")!, agentID: F.agentID, threadID: F.threadID))
  }

  func testBatchApplyWritesOnlyMissingPermissionsWithSelectedDurationAndReadsBack() async throws {
    var state = F.State()
    let originalExpiry = "2098-01-01T00:00:00Z"
    state.grants = [F.Grant(expiresAt: originalExpiry)]
    let fixture = fixture(state)
    let service = ChatBatchPermissions(client: fixture.http.client)
    let action = try action()
    let result = try await service.apply(action, duration: .week, expectedConnectorScoped: false)
    XCTAssertTrue(result.allAllowed)
    XCTAssertEqual(result.allowedCount, 4)
    XCTAssertEqual(
      result.groups.first?.grant(for: action.items[0])?.expiresAt?.formatted(.iso8601),
      "2098-01-01T00:00:00Z")
    let requests = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    XCTAssertEqual(requests.count, 1)
    let request = try XCTUnwrap(requests.first)
    XCTAssertEqual(request.url!.path, "/api/user-permission-grants/apply-batch")
    let body = try JSONSerialization.jsonObject(with: chatRequestBody(request)) as! [String: Any]
    XCTAssertEqual(body["agentId"] as? String, F.agentID)
    let groups = try XCTUnwrap(body["groups"] as? [[String: Any]])
    let grants = groups.flatMap { $0["grants"] as! [[String: String]] }
    XCTAssertEqual(grants.count, 3)
    XCTAssertTrue(grants.allSatisfy { $0["action"] == "allow" && $0["expiresIn"] == "7d" })
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
    _ = try await service.apply(action, duration: .always, expectedConnectorScoped: false)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 1)
  }

  func testDisabledMissingOrReassignedRequestsCannotWrite() async throws {
    for variant in 0..<3 {
      var state = F.State()
      if variant == 0 { state.enabled = false }
      if variant == 1 { state.metadataStatus["google-drive"] = 404 }
      if variant == 2 { state.threadAgentID = UUID().uuidString }
      let fixture = fixture(state)
      do {
        _ = try await ChatBatchPermissions(client: fixture.http.client).apply(
          try action(), duration: .hour, expectedConnectorScoped: false)
        XCTFail("Unavailable requests cannot grant permissions")
      } catch {}
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    }
  }

  func testCatalogAuthorizationAndServiceFailuresAreNotMissingMetadata() async throws {
    for status in [403, 503] {
      var state = F.State()
      state.metadataStatus["google-drive"] = status
      let fixture = fixture(state)
      do {
        _ = try await ChatBatchPermissions(client: fixture.http.client).load(try action())
        XCTFail("Catalog failures must remain failures")
      } catch let error as APIClientError {
        XCTAssertEqual(error.statusCode, status)
      }
    }
  }

  func testSharedScopeUsesConnectorWritesAndRejectsScopeChangesAfterReview() async throws {
    var state = F.State()
    state.shared = true
    let fixture = fixture(state)
    let service = ChatBatchPermissions(client: fixture.http.client)
    let action = try action()
    do {
      _ = try await service.apply(action, duration: .day, expectedConnectorScoped: false)
      XCTFail("A newly broader scope needs another review")
    } catch {}
    XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    let saved = try await service.apply(action, duration: .day, expectedConnectorScoped: true)
    XCTAssertTrue(saved.connectorScoped)
    XCTAssertTrue(saved.allAllowed)
    let writes = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    XCTAssertEqual(writes.count, 2)
    XCTAssertTrue(writes.allSatisfy { $0.url!.path == "/api/connector-permissions" })
  }

  private func fixture(_ state: F.State = .init()) -> F {
    F(initial: state, onUnhandledRequest: { XCTFail($0) })
  }

  private func action(_ source: String = F.actionURL()) throws -> ChatPermissionBatchAction {
    try XCTUnwrap(
      ChatPermissionBatchAction(
        value: source, webURL: URL(string: "https://app.okou.ai")!,
        agentID: F.agentID, threadID: F.threadID))
  }
}
