import Foundation
import XCTest

@testable import Okou

final class ModelSelectionTests: XCTestCase {
  func testCatalogResolvesRetiredSubscriptionSelectionsAndRejectsUnknownModels() throws {
    let catalog = try decodeCatalog(routes: [])
    XCTAssertEqual(catalog.resolve("retired"), "active")
    XCTAssertEqual(catalog.resolve("active"), "active")
    XCTAssertNil(catalog.resolve("unknown"))
  }

  func testSavedPersonalPreferencePreservesReconnect() throws {
    let catalog = try decodeCatalog(routes: [])
    for availability in ["available", "reconnect_required"] {
      let option = try decodeModel(availability: availability)
      XCTAssertTrue(option.hasUsableRoute(catalog: catalog), availability)
    }
    let unavailable = try decodeModel(availability: "unavailable")
    XCTAssertFalse(unavailable.hasUsableRoute(catalog: catalog))
  }

  func testUnavailableSubscriptionRequiresMatchingEnabledCatalogRoute() throws {
    let catalog = try decodeCatalog(routes: [
      #"{"model":"active","providerType":"codex-oauth-token","enabled":true,"serviceTiers":[]}"#,
      #"{"model":"active","providerType":"claude-code-oauth-token","enabled":false,"serviceTiers":[]}"#,
    ])
    let subscription = try decodeModel(availability: "unavailable")
    XCTAssertTrue(subscription.hasUsableRoute(catalog: catalog))
    let disabled = try decodeModel(
      availability: "unavailable", providerType: "claude-code-oauth-token")
    XCTAssertFalse(disabled.hasUsableRoute(catalog: catalog))
    let organization = try decodeModel(availability: "unavailable", credentialScope: "org")
    XCTAssertFalse(organization.hasUsableRoute(catalog: catalog))
    let unknown = try decodeModel(availability: "unavailable", model: "unknown")
    XCTAssertFalse(unknown.hasUsableRoute(catalog: catalog))
  }

  func testResolvedSubscriptionSelectionPreservesSupportedTierThroughReconnect() throws {
    let catalog = try decodeCatalog(routes: [
      #"{"model":"active","providerType":"codex-oauth-token","enabled":true,"serviceTiers":["priority"]}"#
    ])
    let resolved = try XCTUnwrap(catalog.resolve("retired"))
    let option = try decodeModel(
      availability: "reconnect_required", model: resolved, routeStatus: "missing_provider")
    XCTAssertTrue(option.supportsServiceTier("priority", catalog: catalog))
    XCTAssertFalse(option.supportsServiceTier("ultrafast", catalog: catalog))
    XCTAssertFalse(option.supportsServiceTier("unsupported", catalog: catalog))
  }

  func testSubscriptionPriorityUsesItsOwnCapability() throws {
    let catalog = try decodeCatalog(routes: [])
    let offered = try decodeModel(
      availability: "unavailable", model: "active", subscriptionTier: #""priority""#)
    let absent = try decodeModel(
      availability: "available", model: "active", subscriptionTier: "null")
    XCTAssertTrue(offered.supportsServiceTier("priority", catalog: catalog))
    XCTAssertFalse(offered.supportsServiceTier("ultrafast", catalog: catalog))
    XCTAssertFalse(absent.supportsServiceTier("priority", catalog: catalog))
  }

  func testAutoHasNoSubscriptionServiceTier() throws {
    let catalog = try decodeCatalog(routes: [])
    let auto = try decodeModel(
      availability: nil, providerType: "built-in", credentialScope: "org",
      model: "okou-1.0")
    XCTAssertTrue(auto.hasUsableRoute(catalog: catalog))
    XCTAssertFalse(auto.supportsServiceTier("priority", catalog: catalog))
  }

  private func decodeCatalog(routes: [String]) throws -> ModelCatalog {
    let json = """
      {"models":[{"model":"retired","resolvedModel":"active"},\
      {"model":"active","resolvedModel":"active"}],\
      "routes":[\(routes.joined(separator: ","))]}
      """
    return try APIClient.decoder().decode(ModelCatalog.self, from: Data(json.utf8))
  }

  private func decodeModel(
    availability: String?, providerType: String = "codex-oauth-token",
    credentialScope: String = "member", model: String = "retired", routeStatus: String = "valid",
    subscriptionTier: String? = nil
  ) throws -> AvailableRunModels.Model {
    let memberRoute =
      availability.map {
        #", "memberEffective":{"providerType":"\#(providerType)","credentialScope":"\#(credentialScope)","availability":"\#($0)"}"#
      } ?? ""
    let subscription =
      subscriptionTier.map {
        #", "subscriptionOptions":{"serviceTier":\#($0)}"#
      } ?? ""
    let json =
      #"{"model":"\#(model)","routeStatus":"\#(routeStatus)","defaultProviderType":"\#(providerType)"\#(memberRoute)\#(subscription)}"#
    return try APIClient.decoder().decode(AvailableRunModels.Model.self, from: Data(json.utf8))
  }
}
