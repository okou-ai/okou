import Foundation
import XCTest

@testable import Okou

final class ModelSelectionTests: XCTestCase {
  func testCatalogResolvesRetiredSelectionsAndRejectsUnknownModels() throws {
    let catalog = try decodeCatalog(routes: [])
    XCTAssertEqual(catalog.resolve("retired"), "active")
    XCTAssertEqual(catalog.resolve("active"), "active")
    XCTAssertNil(catalog.resolve("unknown"))
  }

  func testSavedPreferencePreservesReconnectAndPlanRestriction() throws {
    let catalog = try decodeCatalog(routes: [])
    for availability in ["available", "reconnect_required", "plan_restricted"] {
      let policy = try decodePolicy(availability: availability)
      XCTAssertTrue(policy.hasUsableRoute(catalog: catalog), availability)
    }
    let unavailable = try decodePolicy(availability: "unavailable")
    XCTAssertFalse(unavailable.hasUsableRoute(catalog: catalog))

    let legacyValid = try decodePolicy(availability: nil, routeStatus: "valid")
    let legacyMissing = try decodePolicy(availability: nil, routeStatus: "missing_provider")
    XCTAssertTrue(legacyValid.hasUsableRoute(catalog: catalog))
    XCTAssertFalse(legacyMissing.hasUsableRoute(catalog: catalog))
  }

  func testUnavailableSubscriptionRequiresMatchingEnabledCatalogRoute() throws {
    let catalog = try decodeCatalog(routes: [
      #"{"model":"active","providerType":"codex-oauth-token","enabled":true,"serviceTiers":[]}"#,
      #"{"model":"active","providerType":"built-in","enabled":true,"serviceTiers":[]}"#,
      #"{"model":"active","providerType":"anthropic-api-key","enabled":false,"serviceTiers":[]}"#,
    ])
    let subscription = try decodePolicy(availability: "unavailable")
    XCTAssertTrue(subscription.hasUsableRoute(catalog: catalog))

    let builtIn = try decodePolicy(availability: "unavailable", providerType: "built-in")
    XCTAssertTrue(builtIn.hasUsableRoute(catalog: catalog))
    let disabled = try decodePolicy(availability: "unavailable", providerType: "anthropic-api-key")
    XCTAssertFalse(disabled.hasUsableRoute(catalog: catalog))
    let unmatched = try decodePolicy(availability: "unavailable", providerType: "openai-api-key")
    XCTAssertFalse(unmatched.hasUsableRoute(catalog: catalog))
    let organization = try decodePolicy(availability: "unavailable", credentialScope: "org")
    XCTAssertFalse(organization.hasUsableRoute(catalog: catalog))
    let unknownModel = try decodePolicy(availability: "unavailable", model: "unknown")
    XCTAssertFalse(unknownModel.hasUsableRoute(catalog: catalog))
  }

  func testResolvedRetiredSelectionPreservesItsSupportedServiceTierThroughReconnect() throws {
    let catalog = try decodeCatalog(routes: [
      #"{"model":"active","providerType":"codex-oauth-token","enabled":true,"serviceTiers":["priority","ultrafast"]}"#
    ])
    let resolved = try XCTUnwrap(catalog.resolve("retired"))
    let policy = try decodePolicy(
      availability: "reconnect_required", model: resolved, routeStatus: "missing_provider")

    XCTAssertTrue(policy.supportsServiceTier("priority", catalog: catalog))
    XCTAssertTrue(policy.supportsServiceTier("ultrafast", catalog: catalog))
    XCTAssertFalse(policy.supportsServiceTier("unsupported", catalog: catalog))
  }

  func testSubscriptionPriorityUsesItsOwnCapability() throws {
    let catalog = try decodeCatalog(routes: [])
    let offered = try decodePolicy(
      availability: "unavailable", model: "active", subscriptionTier: #""priority""#)
    let absent = try decodePolicy(
      availability: "available", model: "active", subscriptionTier: "null")

    XCTAssertTrue(offered.supportsServiceTier("priority", catalog: catalog))
    XCTAssertFalse(offered.supportsServiceTier("ultrafast", catalog: catalog))
    XCTAssertFalse(absent.supportsServiceTier("priority", catalog: catalog))
  }

  func testServiceTierRequiresEnabledSelectedProviderRouteAndLegacyValidStatus() throws {
    let catalog = try decodeCatalog(routes: [
      #"{"model":"active","providerType":"built-in","enabled":true,"serviceTiers":["priority"]}"#,
      #"{"model":"active","providerType":"codex-oauth-token","enabled":false,"serviceTiers":["priority"]}"#,
    ])
    let disabled = try decodePolicy(availability: "available", model: "active")
    XCTAssertFalse(disabled.supportsServiceTier("priority", catalog: catalog))
    let valid = try decodePolicy(
      availability: nil, providerType: "built-in", model: "active", routeStatus: "valid")
    XCTAssertTrue(valid.supportsServiceTier("priority", catalog: catalog))
    let missing = try decodePolicy(
      availability: nil, providerType: "built-in", model: "active", routeStatus: "missing_provider")
    XCTAssertFalse(missing.supportsServiceTier("priority", catalog: catalog))
  }

  private func decodeCatalog(routes: [String]) throws -> ModelCatalog {
    let json = """
      {"systemDefaultModel":"active",\
      "models":[{"model":"retired","resolvedModel":"active"},\
      {"model":"active","resolvedModel":"active"}],\
      "routes":[\(routes.joined(separator: ","))]}
      """
    return try APIClient.decoder().decode(ModelCatalog.self, from: Data(json.utf8))
  }

  private func decodePolicy(
    availability: String?, providerType: String = "codex-oauth-token",
    credentialScope: String = "member", model: String = "retired", routeStatus: String = "valid",
    subscriptionTier: String? = nil
  ) throws -> ModelPolicies.Policy {
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
    return try APIClient.decoder().decode(ModelPolicies.Policy.self, from: Data(json.utf8))
  }
}
