import ChatData
import ChatDataTestSupport
import ChatDomain
import Foundation
import XCTest

@testable import Okou

@MainActor
final class ChatConnectorAccessStoreTests: XCTestCase {
  private typealias F = ConnectorHTTPFixtures

  func testEnablingAnotherDraftAccountKeepsTheDisplayedCurrentThroughCreationAndReopening()
    async throws
  {
    let fixture = makeFixture()
    let client = fixture.http.client
    let store = makeStore(fixture)
    defer { store.close() }
    store.configure(agentID: F.agentID)
    await store.refresh()
    await store.setAccountAccess(
      target: .builtin("slack"), connectionID: F.siblingID, enabled: true)
    let commands = ChatCommands(client: client, sync: ChatSync(client: client))
    let thread = try await commands.createThread(
      modelSelection: ChatModelSelection(),
      composerOptions: store.pendingOptions)
    let access = try await ChatComposerAccess(client: client).connectorAccess(
      target: .builtin("slack"), threadID: thread.id)
    XCTAssertEqual(access.currentConnectionId, F.accountID)
    XCTAssertTrue(try XCTUnwrap(access.accounts.first { $0.id == F.siblingID }).enabled)
    let reopened = makeStore(fixture, thread: thread)
    defer { reopened.close() }
    await reopened.refresh()
    XCTAssertEqual(reopened.connectors.first?.currentAccount?.id, F.accountID)
  }

  func testSupportedPermissionEntryRemainsAvailableWithAllAccountsOff() async throws {
    for kind in ["supported", "unsupported", "custom"] {
      var state = ConnectorAccessHTTPFixture.State()
      state.custom = kind == "custom"
      state.hasPermissions = kind != "unsupported"
      state.enabled = [F.accountID: false, F.siblingID: false]
      state.defaultID = nil
      let fixture = makeFixture(state)
      let store = makeStore(fixture)
      defer { store.close() }
      store.configure(agentID: F.agentID)
      await store.refresh()
      let connector = try XCTUnwrap(store.connectors.first)
      XCTAssertEqual(
        store.canConfigurePermissions(slug: connector.target.connectorSlug), kind == "supported")
      if kind == "supported" {
        try await store.service.savePermissions(
          slug: "slack", agentID: F.agentID,
          edits: [ChatPermissionEdit(permission: "read", action: "allow", expiresIn: "24h")])
        let permissions = try await store.service.permissions(slug: "slack", agentID: F.agentID)
        XCTAssertEqual(
          permissions.metadata.policy(for: "read", grants: permissions.grants, at: .now), .allow)
        let access = try await store.service.connectorAccess(
          target: .builtin("slack"), threadID: F.threadID)
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
    workspace.startNewChat()
    workspace.newChatDraft = "Keep this message"
    let store = workspace.newModelSelection.connectors
    store.configure(agentID: F.agentID)
    await store.refresh()
    await store.setAccountAccess(
      target: .builtin("slack"), connectionID: F.siblingID, enabled: true)
    await store.selectAccount(target: .builtin("slack"), connectionID: F.siblingID)
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
      webURL: fixture.http.baseURL, thread: thread, didFail: { _ in })
  }
}
