import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class SettingsConnectedConnectorsTests: XCTestCase {
  private typealias FixtureData = ConnectorHTTPFixtures

  func testSettingsShowsOverviewAndOpensOneDetailWhileInspectionIsPending() async throws {
    let inspecting = expectation(description: "Inspecting overview accounts")
    let visible = expectation(description: "Rows available before inspection returns")
    let response = HTTPResponseGate()
    let paths = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      let path = request.url!.path
      paths.withLock { $0.append(path) }
      switch path {
      case "/api/chat-connector-overview":
        return ChatHTTPResponse(body: FixtureData.managedOverview)
      case "/api/connector-accounts/inspect":
        inspecting.fulfill()
        await response.wait()
        return ChatHTTPResponse(body: FixtureData.managedInspection())
      case "/api/connector-catalog/slack":
        return ChatHTTPResponse(
          body: """
            {"connector":{"slug":"slack","label":"Slack","description":"Work messages",
             "category":"communication","authMethods":[],"permissionSummary":{"hasPermissions":true}}}
            """)
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = makeStore(fixture)
    defer { store.close() }
    let resources = try XCTUnwrap(store.resources)
    let checked = try resources.store.get(resources.connected)
    let overview = try resources.store.get(resources.overview)
    let rows = Task {
      let entries = try await overview.value
      visible.fulfill()
      return entries
    }
    addTeardownBlock {
      response.open()
      rows.cancel()
      checked.cancel()
      overview.cancel()
      _ = await (rows.result, checked.result, overview.result)
    }
    await fulfillment(of: [visible, inspecting], timeout: 3)
    XCTAssertEqual(
      paths.withLock { $0 }, ["/api/chat-connector-overview", "/api/connector-accounts/inspect"])
    let connector = try XCTUnwrap(store.connectors.first)
    XCTAssertEqual(connector.access.accounts.count, 2)
    XCTAssertTrue(store.snapshot.reconnectAccountIDs(for: connector).isEmpty)
    let detail = try XCTUnwrap(store.openAccounts(connector, managesDefaults: true))
    let catalog = try await detail.store.get(detail.catalog).value
    XCTAssertEqual(catalog.slug, "slack")
    XCTAssertEqual(paths.withLock { $0.last }, "/api/connector-catalog/slack")

    response.open()
    _ = try await checked.value
    XCTAssertEqual(store.snapshot.reconnectAccountIDs(for: connector), [FixtureData.siblingID])
  }

  func testFailedInspectionKeepsVerifiedRowsAndManualRefreshRecovers() async throws {
    let inspection = Mutex<String?>(FixtureData.managedInspection())
    let fixture = ChatHTTPFixture { request in
      switch request.url!.path {
      case "/api/chat-connector-overview":
        return ChatHTTPResponse(body: FixtureData.managedOverview)
      case "/api/connector-accounts/inspect":
        guard let body = inspection.withLock({ $0 }) else {
          return ChatHTTPResponse(
            status: 403, body: #"{"error":{"message":"Inspection unavailable"}}"#)
        }
        return ChatHTTPResponse(body: body)
      default: throw URLError(.unsupportedURL)
      }
    }
    let store = makeStore(fixture)
    defer { store.close() }
    let resources = try XCTUnwrap(store.resources)
    await store.refresh()
    let connector = try XCTUnwrap(store.connectors.first)
    XCTAssertEqual(store.snapshot.reconnectAccountIDs(for: connector), [FixtureData.siblingID])
    inspection.withLock { $0 = nil }
    await store.refresh()
    let visible = try await resources.store.get(resources.overview).value
    XCTAssertEqual(visible.map(\.label), ["Slack"])
    XCTAssertEqual(store.snapshot.reconnectAccountIDs(for: connector), [FixtureData.siblingID])
    if case .success = await (try resources.store.get(resources.connected)).result {
      XCTFail("A failed reconnect check was reported as confirmed")
    }
    inspection.withLock { $0 = FixtureData.managedInspection(kind: "unavailable") }
    await store.refresh()
    _ = try await resources.store.get(resources.connected).value
    XCTAssertTrue(store.snapshot.reconnectAccountIDs(for: connector).isEmpty)
  }

  private func makeStore(_ fixture: ChatHTTPFixture) -> ComposerConnectorStore {
    ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.client),
      authorizationService: ChatConnectorService(client: fixture.client), webURL: fixture.baseURL,
      graph: makeTestWorkspaceGraph(), includesRemote: false, didFail: { _ in })
  }
}
