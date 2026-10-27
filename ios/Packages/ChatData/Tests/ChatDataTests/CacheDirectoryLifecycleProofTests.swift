import ChatData
import Foundation
import XCTest

@MainActor
final class CacheDirectoryLifecycleProofTests: XCTestCase {
  private enum SetupFailure: Error { case afterOpening }
  private final class Resources {
    var url: URL?
    var cache: ChatCache?
  }

  func testOpenCacheIsClosedBeforeRemovalEvenWhenSetupThrows() async throws {
    let resources = Resources()
    addTeardownBlock { @MainActor in
      let url = try XCTUnwrap(resources.url)
      XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
      let cache = try XCTUnwrap(resources.cache)
      do {
        _ = try await cache.loadNavigation()
        XCTFail("The retained owner must be closed before its directory is removed")
      } catch ChatCacheError.unavailable {}
      XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
    do {
      try await openCacheThenThrow(resources)
      XCTFail("The setup sentinel must reach its caller")
    } catch SetupFailure.afterOpening {}
    XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(resources.url).path))
  }

  private func openCacheThenThrow(_ resources: Resources) async throws {
    let directory = CacheTestDirectory(owner: self)
    resources.url = directory.url
    let cache = directory.cache(
      scope: ChatCacheScope(
        apiBaseURL: URL(string: "https://cleanup.example.invalid")!,
        userID: UUID().uuidString, workspaceID: UUID().uuidString))
    resources.cache = cache
    _ = try await cache.loadNavigation()
    throw SetupFailure.afterOpening
  }
}
