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
      case "/api/feature-switches":
        return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsBilling":true}}"#)
      case "/api/billing/status":
        let state = server.withLock { $0 }
        if state.fails {
          return ChatHTTPResponse(status: 403, body: #"{"error":{"message":"Access denied"}}"#)
        }
        return ChatHTTPResponse(body: "{\"tier\":\"\(state.tier)\"}")
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

  func testDisabledRolloutDoesNotReadBilling() async throws {
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/feature-switches" else {
        throw URLError(.unsupportedURL)
      }
      return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsBilling":false}}"#)
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    workspace.prepareSettings()
    await workspace.loadSettingsBilling()
    let resources = workspace.settingsResources
    let features = try await resources.store.get(resources.settingsFeatures).value
    XCTAssertEqual(features.effectiveSwitches["iosSettingsBilling"], false)
  }

  func testBillingReadPreservesTheRequiredAppUpdateBoundary() async {
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/feature-switches":
        return ChatHTTPResponse(body: #"{"effectiveSwitches":{"iosSettingsBilling":true}}"#)
      case "/api/billing/status":
        return ChatHTTPResponse(
          status: 426,
          body:
            #"{"error":{"code":"IOS_UPDATE_REQUIRED","message":"Update Okou"},"minimumSupportedVersion":"99.0.0"}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let workspace = WorkspaceStore(client: fixture.client, webURL: fixture.baseURL)
    defer { workspace.close() }
    await workspace.loadSettingsBilling()
    XCTAssertTrue(workspace.needsUpgrade)
  }
}
