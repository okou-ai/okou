import ChatDataTestSupport
import Foundation
import XCTest

@testable import ChatData

final class ChatConnectorAccessTests: XCTestCase {
  private typealias F = ConnectorHTTPFixtures

  func testChatOverridesCurrentAndInheritancePersistWithoutChangingOtherChatsOrDefaults()
    async throws
  {
    let fixture = makeFixture()
    let service = ChatComposerAccess(client: fixture.http.client)
    let target = ChatConnectorTarget.builtin("slack")
    try await service.setConnectorAccess(
      target: target, connectionID: F.siblingID, threadID: F.threadID, enabled: true)
    try await service.setCurrentAccount(
      target: target, connectionID: F.siblingID, threadID: F.threadID)
    let reopened = ChatComposerAccess(client: fixture.http.client)
    let selected = try await reopened.connectorAccess(target: target, threadID: F.threadID)
    let other = try await reopened.connectorAccess(target: target, threadID: F.attemptID)
    let defaults = try await reopened.accountDefaults(target: target)
    XCTAssertEqual(selected.currentConnectionId, F.siblingID)
    XCTAssertEqual(other.currentConnectionId, F.accountID)
    XCTAssertFalse(try XCTUnwrap(defaults.first { $0.id == F.siblingID }).defaultEnabled)

    try await service.setConnectorAccess(
      target: target, connectionID: F.siblingID, threadID: F.threadID, enabled: nil)
    let inherited = try await reopened.connectorAccess(target: target, threadID: F.threadID)
    XCTAssertEqual(inherited.currentConnectionId, F.accountID)
    XCTAssertNil(inherited.accounts.first { $0.id == F.siblingID }?.overrideEnabled)
    let request = try XCTUnwrap(
      fixture.state.withLock {
        $0.requests.last {
          $0.httpMethod == "PUT" && $0.url!.path.hasSuffix("/connector-access/\(F.siblingID)")
        }
      })
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
    XCTAssertTrue(body["enabled"] is NSNull)
  }

  func testAllDisabledDefaultsHaveNoDefaultAndEnablingFirstAccountEstablishesOne() async throws {
    let fixture = makeFixture()
    let service = ChatComposerAccess(client: fixture.http.client)
    let target = ChatConnectorTarget.builtin("slack")
    try await service.setDefaultEnabled(target: target, connectionID: F.accountID, enabled: false)
    let disabled = try await service.accountDefaults(target: target)
    XCTAssertFalse(disabled.contains { $0.defaultEnabled || $0.isDefault })
    try await service.setDefaultEnabled(target: target, connectionID: F.siblingID, enabled: true)
    let first = try await service.accountDefaults(target: target)
    XCTAssertEqual(first.first { $0.isDefault }?.id, F.siblingID)
    try await service.setDefaultEnabled(target: target, connectionID: F.accountID, enabled: true)
    try await service.setDefaultAccount(target: target, connectionID: F.accountID)
    let selected = try await service.accountDefaults(target: target)
    XCTAssertEqual(selected.first { $0.isDefault }?.id, F.accountID)
  }

  func testMemberPermissionsWorkWithAllAccountsOffAndPreserveOtherRulesAcrossChatsAndAccounts()
    async throws
  {
    var state = ConnectorAccessHTTPFixture.State()
    state.enabled = [F.accountID: false, F.siblingID: false]
    state.defaultID = nil
    state.grants = [
      ConnectorAccessHTTPFixture.Grant(
        permission: "write", action: "allow", expiresAt: "2098-01-01T00:00:00.000Z")
    ]
    let fixture = makeFixture(state)
    let service = ChatComposerAccess(client: fixture.http.client)
    let before = try await service.permissions(slug: "slack", agentID: F.agentID)
    XCTAssertTrue(before.connectorScoped)
    let expiration = before.grants.first { $0.permission == "write" }?.expiresAt
    try await service.savePermissions(
      slug: "slack", agentID: F.agentID,
      edits: [ChatPermissionEdit(permission: "read", action: "allow", expiresIn: "24h")])
    let otherAgent = try await service.permissions(slug: "slack", agentID: F.customID)
    XCTAssertEqual(
      otherAgent.metadata.policy(for: "read", grants: otherAgent.grants, at: .now), .allow)
    XCTAssertEqual(otherAgent.grants.first { $0.permission == "write" }?.expiresAt, expiration)
    let off = try await service.connectorAccess(target: .builtin("slack"), threadID: F.threadID)
    XCTAssertFalse(off.available)
    XCTAssertNil(off.currentConnectionId)
    try await service.setConnectorAccess(
      target: .builtin("slack"), connectionID: F.siblingID, threadID: F.threadID, enabled: true)
    try await service.setCurrentAccount(
      target: .builtin("slack"), connectionID: F.siblingID, threadID: F.threadID)
    let afterSwitch = try await service.permissions(slug: "slack", agentID: F.agentID)
    XCTAssertEqual(afterSwitch.grants, otherAgent.grants)
  }

  func testPermissionActionWritesMemberScopeAndExactDurationThenReadsBack() async throws {
    let fixture = makeFixture()
    let client = fixture.http.client
    let service = ChatPermissions(client: client)
    let action = try XCTUnwrap(
      ChatPermissionAction(
        url: URL(
          string:
            "https://app.okou.ai/agents/\(F.agentID)/permissions?connectorSlug=slack&permission=read"
        )!,
        agentID: F.agentID, threadID: F.threadID))
    _ = try await service.apply(action, duration: .day)
    let saved = try await service.load(action)
    XCTAssertTrue(saved.connectorScoped)
    XCTAssertEqual(saved.metadata?.policy(for: "read", grants: saved.grants, at: .now), .allow)
    let request = try XCTUnwrap(
      fixture.state.withLock {
        $0.requests.first {
          $0.url!.path == "/api/connector-permissions" && $0.httpMethod == "PUT"
        }
      })
    let body = try XCTUnwrap(
      JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
    XCTAssertEqual(Set(body.keys), ["target", "mode", "grants"])
    let grants = try XCTUnwrap(body["grants"] as? [[String: String]])
    XCTAssertEqual(grants.first?["expiresIn"], "24h")
  }

  func testExactAccountApprovalAllowsOnlyThatChatAndKeepsGlobalDefaults() async throws {
    let fixture = makeFixture()
    let client = fixture.http.client
    let action = try XCTUnwrap(
      ChatConnectorAction.parse(
        "/agents/\(F.agentID)/connector-accounts/\(F.siblingID)/select?kind=builtin&connectorSlug=slack&threadId=\(F.threadID)&callbackPrompt=Continue",
        webURL: URL(string: "https://app.okou.ai")!, agentID: F.agentID, threadID: F.threadID))
    let service = ChatConnectorService(client: client)
    let initial = try await service.status(action)
    let status = try XCTUnwrap(initial)
    XCTAssertFalse(status.selected)
    try await service.select(action, status: status)
    let readback = try await service.status(action)
    let accepted = try XCTUnwrap(readback)
    XCTAssertTrue(accepted.selected)
    let settings = ChatComposerAccess(client: client)
    let other = try await settings.connectorAccess(target: .builtin("slack"), threadID: F.attemptID)
    XCTAssertEqual(other.currentConnectionId, F.accountID)
    let defaults = try await settings.accountDefaults(target: .builtin("slack"))
    XCTAssertFalse(try XCTUnwrap(defaults.first { $0.id == F.siblingID }).defaultEnabled)
    XCTAssertEqual(defaults.first { $0.isDefault }?.id, F.accountID)
  }

  func testBuiltinAndCustomConnectionsCompleteWithoutAgentAuthorizationInNewMode() async throws {
    for custom in [false, true] {
      var state = ConnectorAccessHTTPFixture.State()
      state.custom = custom
      state.accountIDs = []
      state.defaultID = nil
      state.enabled = [:]
      let fixture = makeFixture(state)
      let service = ChatConnectorService(client: fixture.http.client)
      let action = ChatConnectorAction.configuration(
        target: custom ? .custom(F.customID) : .builtin("slack"), agentID: F.agentID, threadID: nil)
      let initial = try await service.status(action)
      let status = try XCTUnwrap(initial)
      let result = try await service.start(
        action, status: status, method: status.builtin?.authMethods.first, values: [:], options: [:]
      )
      let accountID = try result.operatedID
      let readback = try await service.status(action.confirming(accountID: accountID))
      let completed = try XCTUnwrap(readback)
      XCTAssertTrue(completed.complete)
      XCTAssertFalse(completed.requiresAgentAuthorization)
      if !custom {
        let request = try XCTUnwrap(
          fixture.state.withLock {
            $0.requests.first {
              $0.url!.path == "/api/connectors/slack/no-auth"
            }
          })
        let body = try XCTUnwrap(
          JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [String: Any])
        XCTAssertEqual(body["authorizeAgent"] as? Bool, false)
        XCTAssertNil(body["agentId"])
      }
      let defaults = try await ChatComposerAccess(client: fixture.http.client).accountDefaults(
        target: completed.target)
      XCTAssertTrue(try XCTUnwrap(defaults.first).defaultEnabled)
    }
  }

  func testNewChatInitializesOverridesThenCurrentBeforeSendingFirstEvent() async throws {
    let fixture = makeFixture()
    let client = fixture.http.client
    let commands = ChatCommands(client: client, sync: ChatSync(client: client))
    let thread = try await commands.createThread(
      modelSelection: ChatModelSelection(), composerOptions: options())
    _ = try await commands.send(thread: thread, text: "Use my selected account")
    let access = try await ChatComposerAccess(client: client).connectorAccess(
      target: .builtin("slack"), threadID: thread.id)
    XCTAssertEqual(access.currentConnectionId, F.siblingID)
    let requests = fixture.state.withLock { $0.requests }
    let enabled = try XCTUnwrap(
      requests.firstIndex { $0.httpMethod == "PUT" && $0.url!.path.contains("/connector-access/") })
    let current = try XCTUnwrap(
      requests.firstIndex { $0.url!.path.hasSuffix("/connector-current") })
    let sent = try XCTUnwrap(requests.firstIndex { $0.url!.path == "/api/chat/events" })
    XCTAssertLessThan(enabled, current)
    XCTAssertLessThan(current, sent)
  }

  private func options() -> ChatComposerOptions {
    var value = ChatComposerOptions()
    value.chatAccountAccess = true
    value.initialConnectorAccessOverrides = [
      ChatConnectorAccessOverride(
        target: .builtin("slack"), connectionId: F.siblingID, enabled: true)
    ]
    value.connectorSelections = [
      ChatConnectorSelection(target: .builtin("slack"), connectionId: F.siblingID)
    ]
    return value
  }

  private func makeFixture(_ state: ConnectorAccessHTTPFixture.State = .init())
    -> ConnectorAccessHTTPFixture
  {
    ConnectorAccessHTTPFixture(initial: state, onUnhandledRequest: { XCTFail($0) })
  }
}
