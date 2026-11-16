import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class SettingsBillingTests: XCTestCase {
  func testSettingsRefreshesThePlanAfterWebManagementAndRecoversFromAReadFailure() async throws {
    struct Server: Sendable {
      var tier = "limited-free-1"
      var fails = false
    }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/billing/status":
        let state = server.withLock { $0 }
        if state.fails {
          return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Access denied"}}"#)
        }
        return ChatHTTPResponse(body: "{\"tier\":\"\(state.tier)\",\"credits\":1200}")
      case "/api/feature-switches":
        return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsCredits":false}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    workspace.prepareSettings()
    await workspace.loadSettingsBilling()
    let resources = workspace.settingsResources
    let initial = try await resources.store.get(resources.billingValue).value
    XCTAssertEqual(initial.tier, "limited-free-1")
    let credits = try await resources.store.get(resources.billingCreditsValue).value
    XCTAssertNil(credits)
    XCTAssertEqual(workspace.billingURL, fixture.baseURL.appending(path: "settings/billing"))

    server.withLock { $0.fails = true }
    await workspace.refreshSettingsBilling()
    let failed = try resources.store.get(resources.billingValue)
    guard case .failure(let error) = await failed.result else {
      return XCTFail("A billing read failure must not display a stale plan as current")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 403)

    server.withLock {
      $0.fails = false
      $0.tier = "pro"
    }
    await workspace.refreshSettingsBilling()
    let upgraded = try await resources.store.get(resources.billingValue).value
    XCTAssertEqual(upgraded.tier, "pro")
  }

  func testBillingReadPreservesTheRequiredAppUpdateBoundary() async {
    for rejectedPath in ["/api/billing/status", "/api/billing/usage-pack-credits"] {
      let fixture = ChatHTTPFixture { request in
        if request.url?.path == rejectedPath {
          return ChatHTTPResponse(
            status: 426,
            body:
              #"{"error":{"code":"IOS_UPDATE_REQUIRED","message":"Update Okou"},"minimumSupportedVersion":"99.0.0"}"#
          )
        }
        switch request.url?.path {
        case "/api/billing/status":
          return ChatHTTPResponse(body: #"{"tier":"pro","credits":1200}"#)
        case "/api/org":
          return ChatHTTPResponse(body: #"{"role":"admin"}"#)
        case "/api/billing/usage-pack-credits":
          return ChatHTTPResponse(body: #"{"totalCredits":350}"#)
        case "/api/feature-switches":
          return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsCredits":true}}"#)
        default: throw URLError(.unsupportedURL)
        }
      }
      let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { workspace.close() }
      await workspace.loadSettingsBilling()
      XCTAssertTrue(workspace.needsUpgrade)
    }
  }

  func testCreditBalanceMatchesTheWebAccountMenuForAdminsAndMembers() async throws {
    for (role, organizationCredits, personalCredits, expected) in [
      ("admin", 1200.5, 350, 1550.5),
      ("admin", -1200, 350, 350),
      ("member", 1200, 350, 350),
      ("member", 1200, 0, 0),
    ] {
      let fixture = ChatHTTPFixture { request in
        switch request.url?.path {
        case "/api/billing/status":
          return ChatHTTPResponse(body: "{\"tier\":\"pro\",\"credits\":\(organizationCredits)}")
        case "/api/org":
          return ChatHTTPResponse(body: "{\"role\":\"\(role)\"}")
        case "/api/billing/usage-pack-credits":
          return ChatHTTPResponse(body: "{\"totalCredits\":\(personalCredits)}")
        case "/api/feature-switches":
          return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsCredits":true}}"#)
        default: throw URLError(.unsupportedURL)
        }
      }
      let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
      defer { workspace.close() }
      await workspace.loadSettingsBilling()
      let resources = workspace.settingsResources
      let balance = try await resources.store.get(resources.billingCreditsValue).value
      XCTAssertEqual(balance, expected, "Role: \(role), organization balance: \(organizationCredits)")
    }
  }

  func testCreditsRefreshAfterWebManagementAndReadFailureDoesNotReplaceThePlan() async throws {
    struct Server: Sendable {
      var personalCredits = 350
      var fails = false
    }
    let server = Mutex(Server())
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/billing/status":
        return ChatHTTPResponse(body: #"{"tier":"pro","credits":1200}"#)
      case "/api/org":
        return ChatHTTPResponse(body: #"{"role":"admin"}"#)
      case "/api/billing/usage-pack-credits":
        let state = server.withLock { $0 }
        if state.fails {
          return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Access denied"}}"#)
        }
        return ChatHTTPResponse(body: "{\"totalCredits\":\(state.personalCredits)}")
      case "/api/feature-switches":
        return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsCredits":true}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.loadSettingsBilling()
    let resources = workspace.settingsResources
    let initial = try await resources.store.get(resources.billingCreditsValue).value
    XCTAssertEqual(initial, 1550)

    server.withLock { $0.fails = true }
    await workspace.refreshSettingsBilling()
    let failed = try resources.store.get(resources.billingCreditsValue)
    guard case .failure(let error) = await failed.result else {
      return XCTFail("A failed credit read must not display a stale or zero balance")
    }
    XCTAssertEqual((error as? APIClientError)?.statusCode, 403)
    let plan = try await resources.store.get(resources.billingValue).value
    XCTAssertEqual(plan.tier, "pro")

    server.withLock {
      $0.fails = false
      $0.personalCredits = 800
    }
    await workspace.refreshSettingsBilling()
    let refreshed = try await resources.store.get(resources.billingCreditsValue).value
    XCTAssertEqual(refreshed, 2000)
  }
}
