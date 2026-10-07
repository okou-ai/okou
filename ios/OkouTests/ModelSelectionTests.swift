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

  func testSavedPersonalPreferencePreservesReconnectAndPlanRestriction() throws {
    for availability in ["available", "reconnect_required", "plan_restricted"] {
      let option = try decodeModel(availability: availability)
      XCTAssertTrue(option.hasUsableRoute(), availability)
    }
    let unknown = try decodeModel(availability: "unknown")
    XCTAssertFalse(unknown.hasUsableRoute())
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
      availability: "reconnect_required", model: "active", subscriptionTier: #""priority""#)
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
    XCTAssertTrue(auto.hasUsableRoute())
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
