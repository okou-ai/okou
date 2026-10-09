import Foundation
import XCTest

@testable import ChatData

final class ModelSelectionTests: XCTestCase {
  func testCatalogResolvesRetiredSubscriptionSelectionsAndRejectsUnknownModels() throws {
    let catalog = try decodeCatalog()
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

  func testSubscriptionPriorityUsesItsOwnCapability() throws {
    let offered = try decodeModel(
      availability: "reconnect_required",
      subscriptionTier: #""priority""#
    )
    let absent = try decodeModel(availability: "available", subscriptionTier: "null")
    XCTAssertTrue(offered.supportsServiceTier("priority"))
    XCTAssertFalse(offered.supportsServiceTier("unsupported"))
    XCTAssertFalse(absent.supportsServiceTier("priority"))
  }

  func testAutoHasNoSubscriptionServiceTier() throws {
    let auto = try decodeModel(
      availability: "available", model: nil, providerType: "built-in",
      runtimeProviderType: "openrouter-codex", credentialScope: "org",
      accountSelection: "not_applicable")
    XCTAssertNil(auto.model)
    XCTAssertTrue(auto.hasUsableRoute())
    XCTAssertFalse(auto.supportsServiceTier("priority"))
  }

  private func decodeCatalog() throws -> ModelCatalog {
    let json = """
      {"systemDefaultModel":"okou-1.0","models":[{"model":"retired","resolvedModel":"active"},\
      {"model":"active","resolvedModel":"active"}],"routes":[]}
      """
    return try APIClient.decoder().decode(ModelCatalog.self, from: Data(json.utf8))
  }

  private func decodeModel(
    availability: String, model: String? = "gpt-5.6-sol",
    providerType: String = "codex-oauth-token", runtimeProviderType: String = "codex-oauth-token",
    credentialScope: String = "member", accountSelection: String = "capture_required",
    subscriptionTier: String? = nil
  ) throws -> AvailableRunModels.Model {
    let modelJSON = model.map { "\"\($0)\"" } ?? "null"
    let label = model ?? "Auto"
    let subscription =
      subscriptionTier.map {
        #", "subscriptionOptions":{"efforts":["low","medium","high"],"serviceTier":\#($0)}"#
      } ?? ""
    let json =
      #"{"model":\#(modelJSON),"modelLabel":"\#(label)","modelProviderId":null,"memberEffective":{"providerType":"\#(providerType)","runtimeProviderType":"\#(runtimeProviderType)","credentialScope":"\#(credentialScope)","availability":"\#(availability)","accountSelection":"\#(accountSelection)"}\#(subscription)}"#
    return try APIClient.decoder().decode(AvailableRunModels.Model.self, from: Data(json.utf8))
  }
}
