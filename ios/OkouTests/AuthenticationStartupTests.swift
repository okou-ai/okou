import ChatDataTestSupport
import Foundation
import XCTest

@testable import Okou

@MainActor
final class AuthenticationStartupTests: XCTestCase {
  func testHomeDataAndLocalDraftStayUsableWhileIdentityRestores() async throws {
    let fixture = try AuthenticationHTTPFixture()
    let authentication = try await fixture.authentication()
    let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    let bundleURL = directory.appending(path: "Startup.bundle")
    try FileManager.default.createDirectory(at: bundleURL, withIntermediateDirectories: true)
    let info = [
      "CFBundleIdentifier": "ai.okou.tests.startup", "CFBundleShortVersionString": "1.0.0",
      "APIBaseURL": fixture.api.baseURL.absoluteString,
      "WebBaseURL": fixture.api.baseURL.absoluteString,
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
      .write(to: bundleURL.appending(path: "Info.plist"))
    let configuration = try AppConfiguration(bundle: XCTUnwrap(Bundle(url: bundleURL)))
    let notifications = NotificationService(system: NotificationSystemFixture())
    let data = try XCTUnwrap(
      notifications.data(
        authentication: authentication, configuration: configuration, session: fixture.api.session))
    let store = WorkspaceStore(
      client: data.client, webURL: configuration.webURL, sharedSync: data.sync)
    addTeardownBlock { @MainActor in
      store.close()
      await fixture.clientReads.releaseAll()
      try? await authentication.signOut()
      await fixture.close()
      try FileManager.default.removeItem(at: directory)
    }
    await fixture.clientReads.hold()
    let observation = await fixture.clientReads.observeRequests()
    let refresh = Task { await authentication.refresh() }
    addTeardownBlock {
      await fixture.clientReads.releaseAll()
      await refresh.value
      await fixture.clientReads.stopObserving(observation.id)
    }
    for await _ in observation.arrivals { break }
    await fixture.clientReads.stopObserving(observation.id)
    XCTAssertNil(authentication.scopeID)
    store.newChatDraft = "Draft written before identity verification"
    await fixture.clientReads.releaseAll()
    await refresh.value
    let resolved = try XCTUnwrap(
      notifications.data(
        authentication: authentication, configuration: configuration, session: fixture.api.session))
    XCTAssertTrue(data.sync === resolved.sync)
    XCTAssertEqual(data.scopeID, authentication.scopeID)
    XCTAssertEqual(store.newChatDraft, "Draft written before identity verification")
    _ = try await resolved.client.data("/api/agents")
  }

  func testUnexpectedAPIRequestFailsAtTheHTTPBoundary() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let url = fixture.api.baseURL.appending(path: "api/unhandled-startup-request")
    XCTExpectFailure(
      "An unconfigured startup endpoint must fail with the request URL",
      issueMatcher: { @Sendable issue in
        issue.compactDescription.contains("Unhandled fixture request: GET \(url)")
      })
    do {
      _ = try await fixture.api.session.data(from: url)
      XCTFail("An unconfigured startup request must be rejected")
    } catch let error as URLError {
      XCTAssertEqual(error.code, .unsupportedURL)
    }
  }

  func testUnexpectedIdentityRequestReportsFailureBeforeReturningItsTransportError() async throws {
    let fixture = try AuthenticationHTTPFixture()
    addTeardownBlock { await fixture.close() }
    let request = URLRequest(url: URL(string: "http://127.0.0.1/v1/unconfigured-sdk-route")!)
    XCTExpectFailure(
      "An SDK fixture omission must fail even if its transport error is caught",
      issueMatcher: { @Sendable issue in
        issue.compactDescription.contains("Unhandled Clerk HTTP request: GET")
          && issue.compactDescription.contains("/v1/unconfigured-sdk-route")
      })
    do {
      _ = try await fixture.response(request)
      XCTFail("An unconfigured identity request must be rejected")
    } catch let error as URLError {
      XCTAssertEqual(error.code, .unsupportedURL)
    }
  }
}
