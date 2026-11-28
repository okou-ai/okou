import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import XCTest

@testable import Okou

@MainActor
final class ChatConnectorAccessStoreTests: XCTestCase {
  private typealias FixtureData = ConnectorHTTPFixtures

  func testMemberAccessIgnoresLegacyDraftOverridesAndTheirDerivedChoicesOnFirstSend() async throws {
    let fixture = makeFixture()
    let client = fixture.http.client
    let store = ComposerConnectorStore(
      service: ChatComposerAccess(client: client),
      authorizationService: ChatConnectorService(client: client), webURL: fixture.http.baseURL,
      graph: makeTestWorkspaceGraph(),
      memberAccessEnabled: { fixture.state.withLock { $0.memberAccess } }, didFail: { _ in })
    defer { store.close() }
    await store.refresh()
    await store.setAccountAccess(
      target: .builtin("slack"), connectionID: FixtureData.siblingID, enabled: true)
    XCTAssertFalse(store.submissionOptions.initialConnectorAccessOverrides.isEmpty)
    fixture.state.withLock { $0.memberAccess = true }
    let commands = ChatCommands(client: client, sync: ChatSync(client: client))
    _ = try await commands.createThread(
      modelSelection: ChatModelSelection(), composerOptions: store.submissionOptions)
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertFalse(
      requests.contains {
        $0.httpMethod == "PUT"
          && ($0.url?.path.contains("/connector-access/") == true
            || $0.url?.path.hasSuffix("/connector-current") == true)
      })
  }

  func testEnablingAnotherDraftAccountKeepsTheDisplayedCurrentThroughCreationAndReopening()
    async throws
  {
    let fixture = makeFixture()
    let client = fixture.http.client
    let store = makeStore(fixture)
    defer { store.close() }
    await store.refresh()
    await store.setAccountAccess(
      target: .builtin("slack"), connectionID: FixtureData.siblingID, enabled: true)
    let commands = ChatCommands(client: client, sync: ChatSync(client: client))
    let thread = try await commands.createThread(
      modelSelection: ChatModelSelection(),
      composerOptions: store.pendingOptions)
    let access = try await ChatComposerAccess(client: client).connectorAccess(
      target: .builtin("slack"), threadID: thread.id)
    XCTAssertEqual(access.currentConnectionId, FixtureData.accountID)
    XCTAssertTrue(try XCTUnwrap(access.accounts.first { $0.id == FixtureData.siblingID }).enabled)
    let reopened = makeStore(fixture, thread: thread)
    defer { reopened.close() }
    await reopened.refresh()
    XCTAssertEqual(reopened.connectors.first?.access.currentConnectionId, FixtureData.accountID)
  }

  func testSupportedPermissionEntryRemainsAvailableWithAllAccountsOff() async throws {
    for kind in ["supported", "unsupported", "custom"] {
      var state = ConnectorAccessHTTPFixture.State()
      state.custom = kind == "custom"
      state.hasPermissions = kind != "unsupported"
      state.enabled = [FixtureData.accountID: false, FixtureData.siblingID: false]
      state.defaultID = nil
      let fixture = makeFixture(state)
      let store = makeStore(fixture)
      defer { store.close() }
      await store.refresh()
      let connector = try XCTUnwrap(store.connectors.first)
      XCTAssertEqual(
        store.canConfigurePermissions(slug: connector.target.connectorSlug), kind == "supported")
      if kind == "supported" {
        try await store.service.savePermissions(
          slug: "slack",
          edits: [ChatPermissionEdit(permission: "read", action: "allow", expiresIn: "24h")])
        let permissions = try await store.service.permissions(slug: "slack")
        XCTAssertEqual(
          permissions.metadata.policy(for: "read", grants: permissions.grants, at: .now), .allow)
        let access = try await store.service.connectorAccess(
          target: .builtin("slack"), threadID: FixtureData.threadID)
        XCTAssertFalse(access.available)
        XCTAssertNil(access.currentConnectionId)
      }
    }
  }

  func testRejectedFirstChatAccountInitializationKeepsTheDraftAndDoesNotSend() async throws {
    var state = ConnectorAccessHTTPFixture.State()
    state.rejectCurrentOnce = true
    let fixture = makeFixture(state)
    let workspace = WorkspaceStore(client: fixture.http.client, webURL: fixture.http.baseURL)
    defer { workspace.close() }
    await workspace.prepareWorkspaceComposer()
    workspace.startNewChat()
    workspace.newChatDraft = "Keep this message"
    let store = workspace.newModelSelection.connectors
    await store.refresh()
    await store.setAccountAccess(
      target: .builtin("slack"), connectionID: FixtureData.siblingID, enabled: true)
    await store.setAccountAccess(
      target: .builtin("slack"), connectionID: FixtureData.accountID, enabled: false)
    await workspace.sendNewChat()
    XCTAssertEqual(workspace.newChatDraft, "Keep this message")
    XCTAssertNil(workspace.selectedThreadID)
    XCTAssertNotNil(workspace.error)
    let requests = fixture.state.withLock { $0.requests }
    XCTAssertTrue(
      requests.contains { $0.url!.path.hasSuffix("/connector-current") && $0.httpMethod == "PUT" })
    XCTAssertFalse(requests.contains { $0.url!.path == "/api/chat/events" })
  }

  private func makeFixture(_ state: ConnectorAccessHTTPFixture.State = .init())
    -> ConnectorAccessHTTPFixture
  {
    ConnectorAccessHTTPFixture(initial: state, onUnhandledRequest: { XCTFail($0) })
  }

  private func makeStore(_ fixture: ConnectorAccessHTTPFixture, thread: ChatThread? = nil)
    -> ComposerConnectorStore
  {
    ComposerConnectorStore(
      service: ChatComposerAccess(client: fixture.http.client),
      authorizationService: ChatConnectorService(client: fixture.http.client),
      webURL: fixture.http.baseURL, graph: makeTestWorkspaceGraph(), threadID: thread?.id,
      didFail: { _ in })
  }
}
