import ChatData
import ChatDataTestSupport
import UIKit
import XCTest

@testable import Okou

@MainActor
final class IdentityPresentationTests: XCTestCase {
  func testRestoredSidebarHasItsNameAndBothImagesBeforeNetworkVerification() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
      UIColor.red.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
    }
    let png = try XCTUnwrap(image.pngData())
    let server = try ChatFileHTTPServer { _ in
      ChatFileHTTPServer.Response(headers: ["Content-Type": "image/png"], body: png)
    }
    addTeardownBlock { await server.close() }
    let baseURL = try await server.start()
    let url = baseURL.appending(path: "logo.png")
    let cached = IdentityPresentationCache(
      environment: "test", userID: "user", directory: directory)
    try await cached.saveWorkspaces(
      [.init(id: "org", name: "Saved workspace", imageURL: url, hasImage: true)], activeID: "org")
    _ = try await cached.image(entity: "workspace:org", url: url)
    _ = try await cached.image(entity: "profile", url: url)
    try await cached.close()
    // The same caller entry used before WorkspaceRootView mounts must restore local bytes.
    let restored = IdentityPresentation(
      userID: "user",
      cache: IdentityPresentationCache(environment: "test", userID: "user", directory: directory))
    addTeardownBlock { @MainActor in await restored.close(removeFiles: true) }
    await restored.restore(workspaceID: "org", profileURL: url, hasProfileImage: true)
    XCTAssertEqual(restored.workspace("org")?.name, "Saved workspace")
    XCTAssertNotNil(restored.image("workspace:org"))
    XCTAssertNotNil(restored.image("profile"))
    XCTAssertEqual(restored.preparedWorkspaceID, "org")
    await restored.replaceWorkspaces(
      [.init(id: "org", name: "Renamed workspace", hasImage: false)], activeID: "org")
    XCTAssertEqual(restored.workspace("org")?.name, "Renamed workspace")
    XCTAssertNil(
      restored.image("workspace:org"), "A confirmed image removal must clear the old bitmap")
  }

  func testRefreshRetainsTheVisibleImageAndClosingRejectsALateReplacement() async throws {
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    let image = UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { context in
      UIColor.blue.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 24, height: 24))
    }
    let png = try XCTUnwrap(image.pngData())
    let gate = AuthenticationRequestGate()
    await gate.hold()
    let observation = await gate.observeRequests()
    let server = try ChatFileHTTPServer { request in
      if request.url?.path == "/new.png" { await gate.enter() }
      return ChatFileHTTPServer.Response(headers: ["Content-Type": "image/png"], body: png)
    }
    addTeardownBlock {
      await gate.releaseAll()
      await gate.stopObserving(observation.id)
      await server.close()
    }
    let baseURL = try await server.start()
    let oldURL = baseURL.appending(path: "old.png")
    let newURL = baseURL.appending(path: "new.png")
    let cache = IdentityPresentationCache(environment: "test", userID: "user", directory: directory)
    try await cache.saveWorkspaces(
      [.init(id: "org", name: "Workspace", imageURL: oldURL, hasImage: true)], activeID: "org")
    _ = try await cache.image(entity: "workspace:org", url: oldURL)
    let presentation = IdentityPresentation(userID: "user", cache: cache)
    addTeardownBlock { @MainActor in await presentation.close(removeFiles: true) }
    await presentation.restore(workspaceID: "org", profileURL: nil, hasProfileImage: false)
    let visible = try XCTUnwrap(presentation.image("workspace:org")?.pngData())
    await presentation.replaceWorkspaces(
      [.init(id: "org", name: "Renamed", imageURL: newURL, hasImage: true)], activeID: "org")
    for await _ in observation.arrivals { break }
    XCTAssertEqual(presentation.image("workspace:org")?.pngData(), visible)
    await presentation.close(removeFiles: true)
    await gate.releaseAll()
    await server.close()
    let reopened = IdentityPresentationCache(
      environment: "test", userID: "user", directory: directory)
    let lateImage = await reopened.cachedImage(entity: "workspace:org", url: newURL)
    let snapshot = await reopened.workspaces()
    XCTAssertNil(lateImage)
    XCTAssertTrue(snapshot.isEmpty)
  }

  func testCachedWorkspaceDisplayDoesNotVerifyMembershipOrActivateAnotherWorkspace() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let authentication = try await fixture.authentication()
    addTeardownBlock { @MainActor in try? await authentication.signOut() }
    let userID = try XCTUnwrap(authentication.userID)
    let cache = IdentityPresentationCache(environment: fixture.publishableKey, userID: userID)
    try await cache.saveWorkspaces(
      [
        .init(id: "org_one", name: "Previously confirmed workspace"),
        .init(id: "org_removed", name: "Removed workspace"),
      ], activeID: "org_one")
    try await cache.close()
    await authentication.preparePresentation()
    XCTAssertEqual(
      authentication.workspacePresentation("org_one")?.name, "Previously confirmed workspace")
    XCTAssertTrue(authentication.workspaces.isEmpty)
    XCTAssertNil(authentication.scopeID)
    // An explicitly rejected session must not acquire credentials from the display snapshot.
    fixture.identityOverride.withLock {
      $0 = { request in
        guard request.url?.path == "/v1/client" else { return nil }
        return ChatHTTPResponse(
          status: 400,
          body: #"{"errors":[{"code":"fixture_unavailable","message":"Session unavailable"}]}"#)
      }
    }
    await authentication.refresh()
    XCTAssertNil(authentication.scopeID)
    XCTAssertEqual(
      authentication.workspacePresentation("org_one")?.name, "Previously confirmed workspace")
    do {
      try await authentication.switchWorkspace("org_removed")
      XCTFail("Display metadata must never permit workspace activation")
    } catch {}
  }
}
