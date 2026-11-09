import ChatDataTestSupport
import Foundation
import XCTest

@testable import ChatData

@MainActor
final class IdentityPresentationCacheTests: XCTestCase {
  func testWorkspaceDisplaySurvivesReopeningWithoutCrossingAccountsOrEnvironments() async throws {
    let directory = temporaryDirectory()
    let workspace = WorkspacePresentation(
      id: "org", name: "Saved workspace", imageURL: URL(string: "https://images.example.invalid/logo"),
      hasImage: true)
    let original = IdentityPresentationCache(environment: "one", userID: "user", directory: directory)
    try await original.saveWorkspaces([workspace], activeID: workspace.id)
    try await original.close()
    let reopened = IdentityPresentationCache(environment: "one", userID: "user", directory: directory)
    let restored = await reopened.workspaces()
    XCTAssertEqual(restored, [workspace])
    for (environment, user) in [("two", "user"), ("one", "other")] {
      let other = IdentityPresentationCache(environment: environment, userID: user, directory: directory)
      let values = await other.workspaces()
      XCTAssertTrue(values.isEmpty)
      try await other.close()
    }
    try await reopened.close(removeFiles: true)
    let signedOut = IdentityPresentationCache(environment: "one", userID: "user", directory: directory)
    let cleared = await signedOut.workspaces()
    XCTAssertTrue(cleared.isEmpty)
  }

  func testImageBytesSurviveRestartAndKeepFullURLAndEntityIdentity() async throws {
    let directory = temporaryDirectory()
    let http = ChatHTTPFixture { request in
      ChatHTTPResponse(body: request.url!.query ?? "image")
    }
    let original = IdentityPresentationCache(
      environment: "one", userID: "user", directory: directory, session: http.session)
    let first = http.baseURL.appending(path: "avatar").appending(queryItems: [.init(name: "v", value: "1")])
    let second = http.baseURL.appending(path: "avatar").appending(queryItems: [.init(name: "v", value: "2")])
    let bytes = try await original.image(entity: "profile", url: first)
    try await original.close()
    let reopened = IdentityPresentationCache(
      environment: "one", userID: "user", directory: directory, session: http.session)
    let restored = await reopened.cachedImage(entity: "profile", url: first)
    XCTAssertEqual(restored, bytes)
    let updated = await reopened.cachedImage(entity: "profile", url: second)
    let workspace = await reopened.cachedImage(entity: "workspace:org", url: first)
    XCTAssertNil(updated)
    XCTAssertNil(workspace)
    try await reopened.removeImages(entity: "profile")
    let removed = await reopened.cachedImage(entity: "profile", url: first)
    XCTAssertNil(removed)
  }

  func testDiskBudgetEvictsOlderImagesAndKeepsTheNewestUsable() async throws {
    let directory = temporaryDirectory()
    let http = ChatHTTPFixture { _ in ChatHTTPResponse(body: "12345678") }
    let cache = IdentityPresentationCache(
      environment: "one", userID: "user", directory: directory, session: http.session, maximumBytes: 12)
    let first = http.baseURL.appending(path: "first")
    let second = http.baseURL.appending(path: "second")
    _ = try await cache.image(entity: "profile", url: first)
    _ = try await cache.image(entity: "profile", url: second)
    let evicted = await cache.cachedImage(entity: "profile", url: first)
    let retained = await cache.cachedImage(entity: "profile", url: second)
    XCTAssertNil(evicted)
    XCTAssertEqual(retained, Data("12345678".utf8))
  }

  private func temporaryDirectory() -> URL {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    addTeardownBlock {
      if FileManager.default.fileExists(atPath: directory.path) {
        try FileManager.default.removeItem(at: directory)
      }
    }
    return directory
  }
}
