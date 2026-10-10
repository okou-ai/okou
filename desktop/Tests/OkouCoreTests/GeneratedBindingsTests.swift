import Foundation
import XCTest

@testable import OkouCore

final class GeneratedBindingsTests: XCTestCase {
  private func decode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
    try APIResponse(status: 200, data: Data(json.utf8), body: .null, retryAfter: nil).decode(type)
  }

  func testConstantsMatchTheContractWireValues() {
    XCTAssertEqual(ApiConstants.clientTypeHeader, "X-Client-Type")
    XCTAssertEqual(ApiConstants.clientVersionHeader, "X-Client-Version")
    XCTAssertEqual(ApiConstants.clientSessionIdHeader, "X-Client-Session-Id")
    XCTAssertEqual(ApiConstants.clientRequestIdHeader, "X-Client-Request-Id")
    XCTAssertEqual(ApiConstants.clientTypeDesktop, "Desktop")
    XCTAssertEqual(ApiConstants.clientForceUpgradeStatus, 426)
    XCTAssertEqual(ApiConstants.desktopUpdateLineOkou, "ai-okou-desktop")
    XCTAssertEqual(ApiConstants.apiErrorCodeConflict, "CONFLICT")
  }

  func testRoutesResolveAgainstTheAPIOriginWithEncodedSegments() throws {
    let base = URL(string: "https://api.example.test")!
    XCTAssertEqual(ApiRoutes.computerUseHostRegister.method, "POST")
    XCTAssertEqual(
      try APIClient.url(for: ApiRoutes.computerUseHostRegister, baseURL: base).absoluteString,
      "https://api.example.test/api/computer-use/hosts/register")
    XCTAssertEqual(
      try APIClient.url(
        for: ApiRoutes.computerUseHostCommandComplete(hostId: "host 1", commandId: "a/b"),
        baseURL: base
      ).absoluteString,
      "https://api.example.test/api/computer-use/hosts/host%201/commands/a%2Fb/complete")
    XCTAssertEqual(ApiRoutes.desktopCompatibility.method, "GET")
    XCTAssertEqual(
      ApiRoutes.desktopProductDmgDownload(
        product: ApiConstants.desktopUpdateLineOkou, channel: "stable", platform: "darwin",
        arch: "arm64"
      ).path, "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/dmg")
    XCTAssertEqual(ApiRoutes.platformRealtimeToken.path, "/api/realtime/token")
    XCTAssertEqual(ApiRoutes.authMe.path, "/api/auth/me")
    XCTAssertEqual(ApiRoutes.org.path, "/api/org")
    XCTAssertEqual(ApiRoutes.featureSwitches.path, "/api/feature-switches")
  }

  func testRegistrationDecodesWithAndWithoutNotifications() throws {
    let full = try decode(
      ComputerUseHostRegistration.self,
      #"{"hostId":"00000000-0000-0000-0000-000000000001","connectionGeneration":3,"#
        + #""commandNotifications":{"channelName":"channel","eventName":"commandsChanged"}}"#)
    XCTAssertEqual(full.connectionGeneration, 3)
    XCTAssertEqual(full.commandNotifications?.channelName, "channel")
    let legacy = try decode(
      ComputerUseHostRegistration.self,
      #"{"hostId":"00000000-0000-0000-0000-000000000001","connectionGeneration":1}"#)
    XCTAssertNil(legacy.commandNotifications)
  }

  func testHeartbeatAndUpgradeRequiredDecode() throws {
    let heartbeat = try decode(
      ComputerUseHostHeartbeat.self, #"{"ok":true,"hostId":"host","hasPendingCommands":true}"#)
    XCTAssertTrue(heartbeat.hasPendingCommands)
    let upgrade = try decode(
      DesktopUpgradeRequired.self,
      #"{"error":{"code":"DESKTOP_UPDATE_REQUIRED","message":"Update"},"#
        + #""minimumSupportedVersion":"0.51.0"}"#)
    XCTAssertEqual(upgrade.minimumSupportedVersion, "0.51.0")
    XCTAssertEqual(upgrade.error.code, "DESKTOP_UPDATE_REQUIRED")
  }

  func testCommandClaimDecodesBothVariantsAndUnknownKinds() throws {
    XCTAssertEqual(try decode(ComputerUseCommandClaim.self, #"{"status":"idle"}"#), .idle)
    let claim = try decode(
      ComputerUseCommandClaim.self,
      #"{"status":"command","command":{"id":"c1","kind":"future.kind","status":"running","#
        + #""hostId":null,"hostName":null,"payload":{"app":"Notes","depth":2},"#
        + #""timeoutMs":null,"createdAt":"2026-10-07T00:00:00.000Z","claimedAt":null,"#
        + #""completedAt":null}}"#)
    guard case .command(let command) = claim else { return XCTFail("Expected a command") }
    XCTAssertEqual(command.id, "c1")
    XCTAssertEqual(command.kind, ComputerUseCommandClaim.Command.Kind(rawValue: "future.kind"))
    XCTAssertFalse(ComputerUseCommandClaim.Command.Kind.knownValues.contains(command.kind))
    XCTAssertEqual(command.status, .running)
    XCTAssertNil(command.timeoutMs)
    XCTAssertEqual(command.payload, ["app": .string("Notes"), "depth": .number(2)])
    XCTAssertEqual(JSONValue.object(command.payload)["app"].string, "Notes")
    XCTAssertThrowsError(try decode(ComputerUseCommandClaim.self, #"{"status":"paused"}"#)) {
      error in
      XCTAssertEqual((error as? DesktopFailure)?.code, "invalid_response")
    }
  }

  func testCompatibilityPolicyAndIdentityResponsesDecode() throws {
    XCTAssertNil(
      try decode(DesktopCompatibilityPolicy.self, #"{"minimumSupportedVersion":null}"#)
        .minimumSupportedVersion)
    XCTAssertEqual(
      try decode(DesktopCompatibilityPolicy.self, #"{"minimumSupportedVersion":"0.51.0"}"#)
        .minimumSupportedVersion, "0.51.0")
    let user = try decode(
      AuthenticatedUser.self, #"{"userId":"user_1","email":"a@b.test","orgId":null}"#)
    XCTAssertNil(user.orgId)
    XCTAssertNil(user.sessionId)
    let workspace = try decode(Organization.self, #"{"id":"org_1","name":"Okou","role":"owner"}"#)
    XCTAssertEqual(workspace.role, Organization.Role(rawValue: "owner"))
    XCTAssertNil(workspace.tier)
    let switches = try decode(
      FeatureSwitches.self, #"{"switches":{},"effectiveSwitches":{"_debug":true}}"#)
    XCTAssertEqual(switches.effectiveSwitches["_debug"], true)
    let failure = try decode(ApiError.self, #"{"error":{"code":"CONFLICT","message":"Done"}}"#)
    XCTAssertEqual(failure.error.code, ApiConstants.apiErrorCodeConflict)
  }

  func testDecodeFailuresNameTheMissingField() {
    XCTAssertThrowsError(try decode(ComputerUseHostHeartbeat.self, #"{"ok":true}"#)) { error in
      XCTAssertEqual((error as? DesktopFailure)?.code, "invalid_response")
      XCTAssertTrue((error as? DesktopFailure)?.message.contains("missing hostId") == true)
    }
  }

  func testRequiredNullableFieldsRejectAMissingKeyButAcceptNull() throws {
    XCTAssertThrowsError(try decode(DesktopCompatibilityPolicy.self, "{}")) { error in
      XCTAssertTrue(
        (error as? DesktopFailure)?.message.contains("missing minimumSupportedVersion") == true)
    }
    XCTAssertThrowsError(
      try decode(AuthenticatedUser.self, #"{"userId":"user_1","email":"a@b.test"}"#))
    let encoded = try JSONEncoder().encode(DesktopCompatibilityPolicy(minimumSupportedVersion: nil))
    XCTAssertEqual(String(decoding: encoded, as: UTF8.self), #"{"minimumSupportedVersion":null}"#)
  }
}
