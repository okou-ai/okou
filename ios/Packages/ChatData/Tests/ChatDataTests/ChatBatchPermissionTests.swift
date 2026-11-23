import ChatDataTestSupport
import ChatDomain
import Foundation
import XCTest

@testable import ChatData

final class ChatBatchPermissionTests: XCTestCase {
  private typealias FixtureData = PermissionBatchHTTPFixture

  func testTrustedBatchLinkNormalizesDuplicatesAndPreservesCallbackEncoding() throws {
    let source = FixtureData.actionURL(
      items: FixtureData.items + [FixtureData.items[0]], duration: "24h"
    )
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
          threadID: FixtureData.threadID))
    }
  }

  func testForeignMalformedAndMismatchedBatchLinksCannotBecomeActions() {
    let valid = FixtureData.actionURL()
    let rejected = [
      "https://evil.invalid" + valid,
      valid.replacingOccurrences(
        of: "/connectors/permissions", with: "/connectors/unsupported"),
      "https://app.okou.ai.evil.invalid" + valid,
      "https://user@app.okou.ai" + valid,
      valid + "#extra", valid + "&action=allow", valid + "&ref=gmail",
      valid + "&expiresIn=invalid", valid + "&expiresIn", valid + "&extra=%FF",
      valid.replacingOccurrences(of: "action=allow", with: "action=deny"),
      valid.replacingOccurrences(of: "orgId=", with: "unrecognized="),
      valid.replacingOccurrences(of: ChatHTTPFixture.userID, with: "%20"),
      valid + "&userId=another",
      valid.replacingOccurrences(of: FixtureData.threadID, with: UUID().uuidString),
      valid.replacingOccurrences(of: "callbackPrompt=", with: "unexpected="),
      " " + valid, valid + "\n"
    ]
    for value in rejected {
      XCTAssertNil(
        ChatPermissionBatchAction(
          value: value, webURL: URL(string: "https://app.okou.ai")!,
          threadID: FixtureData.threadID), value)
    }
  }

  func testEveryOriginalItemIsValidatedAndTwentyIsTheBatchLimit() throws {
    let twenty = (0..<20).map { ["connectorSlug": "gmail", "permission": "scope.\($0)"] }
    XCTAssertEqual(try action(FixtureData.actionURL(items: twenty)).items.count, 20)
    for rows in [
      [], twenty + [["connectorSlug": "gmail", "permission": "extra"]],
      [["connectorSlug": "gmail", "permission": ""]],
      [["connectorSlug": "gmail", "permission": String(repeating: "x", count: 129)]],
      [["connectorSlug": "Gmail", "permission": "mail.send"]],
      FixtureData.items + [
        ["connectorSlug": "gmail", "permission": "mail.read", "extra": "invalid"]
      ]
    ] {
      XCTAssertNil(
        ChatPermissionBatchAction(
          value: FixtureData.actionURL(items: rows), webURL: URL(string: "https://app.okou.ai")!,
          threadID: FixtureData.threadID))
    }
    XCTAssertNil(
      ChatPermissionBatchAction(
        value: FixtureData.actionURL() + "&callbackPrompt=" + String(repeating: "x", count: 8192),
        webURL: URL(string: "https://app.okou.ai")!, threadID: FixtureData.threadID))
  }

  func testBatchApplyUsesWriteReceiptsAndPreservesGrantsMadeAfterReview() async throws {
    var state = FixtureData.State()
    let originalExpiry = "2098-01-01T00:00:00Z"
    state.failReadbackAfterWrite = true
    let fixture = fixture(state)
    let service = ChatBatchPermissions(client: fixture.http.client)
    let action = try action()
    let reviewed = try await service.load(action)
    fixture.state.withLock { $0.grants = [FixtureData.Grant(expiresAt: originalExpiry)] }
    let result = try await service.apply(action, duration: .week, reviewing: reviewed)
    XCTAssertTrue(result.allAllowed)
    XCTAssertEqual(result.allowedCount, 4)
    XCTAssertEqual(
      result.groups.first?.grant(for: action.items[0])?.expiresAt?.formatted(.iso8601),
      originalExpiry)
    let requests = fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" } }
    XCTAssertEqual(requests.count, 2)
    let request = try XCTUnwrap(requests.first)
    XCTAssertTrue(requests.allSatisfy { $0.url?.path == "/api/connector-permissions" })
    let bodies = try requests.map {
      try JSONSerialization.jsonObject(with: chatRequestBody($0)) as! [String: Any]
    }
    let targets = bodies.map { $0["target"] as? [String: String] }
    XCTAssertEqual(
      targets,
      [
        ["kind": "builtin", "connectorSlug": "gmail"],
        ["kind": "builtin", "connectorSlug": "google-drive"]
      ])
    let grants = bodies.flatMap { $0["grants"] as! [[String: String]] }
    XCTAssertEqual(grants.count, 3)
    XCTAssertTrue(grants.allSatisfy { $0["action"] == "allow" && $0["expiresIn"] == "7d" })
    XCTAssertEqual(request.value(forHTTPHeaderField: "X-Client-Type"), "iOS")
    fixture.state.withLock { $0.grantReadStatus = 200 }
    let saved = try await service.load(action)
    XCTAssertTrue(saved.allAllowed)
    XCTAssertEqual(
      saved.groups.first?.grant(for: action.items[0])?.expiresAt?.formatted(.iso8601),
      originalExpiry)
    _ = try await service.apply(action, duration: .always, reviewing: saved)
    XCTAssertEqual(
      fixture.state.withLock { $0.requests.filter { $0.httpMethod == "PUT" }.count }, 2)
  }

  func testMissingOrMismatchedRequestsCannotWrite() async throws {
    for missingMetadata in [true, false] {
      var state = FixtureData.State()
      if missingMetadata { state.metadataStatus["google-drive"] = 404 }
      let fixture = fixture(state)
      let service = ChatBatchPermissions(client: fixture.http.client)
      let action = try action()
      let reviewed = try await service.load(action)
      fixture.state.withLock {
        if !missingMetadata { $0.metadataThreadID = UUID().uuidString }
      }
      do {
        _ = try await service.apply(action, duration: .hour, reviewing: reviewed)
        XCTFail("Unavailable requests cannot grant permissions")
      } catch {}
      XCTAssertTrue(fixture.state.withLock { $0.requests.allSatisfy { $0.httpMethod == "GET" } })
    }
  }

  func testBatchOwnerMustMatchBeforeReviewAndAgainAtConfirmation() async throws {
    let fixture = fixture()
    let service = ChatBatchPermissions(client: fixture.http.client)
    let own = try action()
    let reviewed = try await service.load(own)
    let count = fixture.state.withLock { $0.requests.count }
    for id in [ChatHTTPFixture.workspaceID, ChatHTTPFixture.userID] {
      let other = try action(
        FixtureData.actionURL().replacingOccurrences(of: id, with: id + "_other"))
      do {
        _ = try await service.load(other)
        XCTFail("A foreign batch cannot be reviewed")
      } catch ChatError.invalidContract {}
      do {
        _ = try await service.apply(other, duration: .hour, reviewing: reviewed)
        XCTFail("A foreign batch cannot be confirmed")
      } catch ChatError.invalidContract {}
    }
    XCTAssertEqual(fixture.state.withLock { $0.requests.count }, count)
  }

  func testCatalogAuthorizationAndServiceFailuresAreNotMissingMetadata() async throws {
    for status in [403, 503] {
      var state = FixtureData.State()
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

  private func fixture(_ state: FixtureData.State = .init()) -> FixtureData {
    FixtureData(initial: state, onUnhandledRequest: { XCTFail($0) })
  }

  private func action(_ source: String = FixtureData.actionURL()) throws
    -> ChatPermissionBatchAction
  {
    try XCTUnwrap(
      ChatPermissionBatchAction(
        value: source, webURL: URL(string: "https://app.okou.ai")!,
        threadID: FixtureData.threadID))
  }
}
