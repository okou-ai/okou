import ChatDataTestSupport
import Foundation
import XCTest

@testable import Okou

@MainActor
final class WorkspaceCreationTests: XCTestCase {
  func testNewAccountCreatesAndActivatesItsFirstWorkspaceWithTheNativeSDK() async throws {
    let fixture = try AuthenticationHTTPFixture()
    fixture.state.withLock {
      $0.activeWorkspaceID = nil
      $0.workspaceIDs = []
      $0.pending = true
    }
    addTeardownBlock { await fixture.close() }
    let authentication = try await fixture.authentication()
    await authentication.refresh()
    XCTAssertTrue(authentication.needsWorkspaceSelection)

    let api = ChatHTTPFixture { request in
      guard request.url?.path == "/api/onboarding/native-availability" else {
        throw URLError(.unsupportedURL)
      }
      XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
      return ChatHTTPResponse(body: "{\"nativeOnboardingEnabled\":true}")
    }
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let bundleURL = directory.appending(path: "Creation.bundle")
    try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    addTeardownBlock { try FileManager.default.removeItem(at: directory) }
    let info = [
      "CFBundleIdentifier": "ai.okou.tests.workspace-creation",
      "CFBundleShortVersionString": "1.0.0",
      "APIBaseURL": api.baseURL.absoluteString,
      "WebBaseURL": api.baseURL.absoluteString
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      .write(to: bundleURL.appending(path: "Info.plist"))
    let configuration = try AppConfiguration(bundle: XCTUnwrap(Bundle(url: bundleURL)))
    let store = WorkspaceCreationStore(
      authentication: authentication, configuration: configuration, session: api.session)
    defer { store.close() }
    store.name = "Native workspace"
    await store.create()
    XCTAssertNil(store.error)
    XCTAssertEqual(authentication.activeWorkspaceID, "org_created_native")
    XCTAssertFalse(authentication.needsWorkspaceSelection)
  }
}
