import Foundation
import XCTest

@testable import Okou

@MainActor
final class AppConfigurationTests: XCTestCase {
  func testAppVersionRequiresStableMarketingVersion() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "okou-configuration-tests-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }

    let configuration = try AppConfiguration(
      bundle: configurationBundle(in: directory, marketingVersion: "1.2.3"))
    XCTAssertEqual(configuration.appVersion, "1.2.3")

    // CFBundleVersion is always 1 and must never stand in for the marketing version.
    let invalidVersions: [String?] = [
      nil, "", "1", "1.2", "1.2.3-beta.1", "v1.2.3", "$(MARKETING_VERSION)",
    ]
    for marketingVersion in invalidVersions {
      let bundle = try configurationBundle(in: directory, marketingVersion: marketingVersion)
      XCTAssertThrowsError(
        try AppConfiguration(bundle: bundle), "\(marketingVersion ?? "missing")"
      ) { error in
        XCTAssertEqual(error as? AppConfiguration.ConfigurationError, .invalidVersion)
      }
    }
  }

  private func configurationBundle(in directory: URL, marketingVersion: String?) throws -> Bundle {
    let bundleURL = directory.appendingPathComponent(
      "\(UUID().uuidString).bundle", isDirectory: true)
    try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    var info: [String: Any] = [
      "CFBundleIdentifier": "ai.okou.tests.configuration",
      "CFBundleVersion": "1",
      "APIBaseURL": "https://api.example.invalid",
      "WebBaseURL": "https://app.example.invalid",
    ]
    info["CFBundleShortVersionString"] = marketingVersion
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      .write(to: bundleURL.appendingPathComponent("Info.plist"))
    return try XCTUnwrap(Bundle(url: bundleURL))
  }
}
