import ChatData
import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class PersonalInstructionsTests: XCTestCase {
  func testIntentionalEmptySaveUsesVersionAndReplacesCanonicalContent() async throws {
    let saved = Mutex((content: "Seeded personal instructions", version: "v1"))
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/instructions" else { throw URLError(.unsupportedURL) }
      if request.httpMethod == "PUT" {
        let body = try JSONDecoder().decode(Write.self, from: chatRequestBody(request))
        guard body.ifVersion == saved.withLock({ $0.version }) else {
          return ChatHTTPResponse(
            status: 409, body: #"{"error":{"code":"CONFLICT","message":"Stale version"}}"#)
        }
        saved.withLock { $0 = (body.content, "v2") }
      }
      return instructions(saved.withLock { $0.content }, version: saved.withLock { $0.version })
    }
    let store = PersonalInstructionsStore(client: fixture.client, storage: nil, didFail: { _ in })
    defer { store.close() }
    await store.load()
    XCTAssertEqual(store.content, "Seeded personal instructions")
    store.edit("")
    await store.save()
    let readback = try await PersonalInstructionsClient(client: fixture.client).load()
    XCTAssertEqual(readback.content, "")
    XCTAssertFalse(store.isDirty)
  }

  func testFailureAndConflictRetainDraftUntilExplicitReload() async throws {
    let mode = Mutex(500)
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/instructions" else { throw URLError(.unsupportedURL) }
      if request.httpMethod == "PUT" {
        return ChatHTTPResponse(
          status: mode.withLock { $0 },
          body: #"{"error":{"code":"CONFLICT","message":"Save failed"}}"#)
      }
      return instructions(mode.withLock { $0 == 409 ? "New CLI value" : "Original value" })
    }
    let store = PersonalInstructionsStore(client: fixture.client, storage: nil, didFail: { _ in })
    defer { store.close() }
    await store.load()
    store.edit("Keep my local draft")
    await store.save()
    XCTAssertEqual(store.content, "Keep my local draft")
    XCTAssertTrue(store.isDirty)
    XCTAssertNotNil(store.error)
    mode.withLock { $0 = 409 }
    await store.save()
    XCTAssertTrue(store.conflict)
    XCTAssertEqual(store.content, "Keep my local draft")
    await store.discard()
    XCTAssertEqual(store.content, "New CLI value")
    XCTAssertFalse(store.isDirty)
  }

  func testDraftSurvivesReopeningAndIsIsolatedByMemberAndWorkspace() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = ChatHTTPFixture { _ in instructions("Personal seed") }
    let scope = ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "member", workspaceID: "alpha")
    let storage = ChatDraftStorage(scope: scope, directory: directory)
    let first = PersonalInstructionsStore(
      client: fixture.client, storage: storage, didFail: { _ in })
    await first.load()
    first.edit("Retain this draft")
    first.close()
    let reopened = PersonalInstructionsStore(
      client: fixture.client, storage: storage, didFail: { _ in })
    defer { reopened.close() }
    await reopened.load()
    XCTAssertEqual(reopened.content, "Retain this draft")
    for other in [
      ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "other", workspaceID: "alpha"),
      ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "member", workspaceID: "beta"),
    ] {
      let isolated = PersonalInstructionsStore(
        client: fixture.client, storage: ChatDraftStorage(scope: other, directory: directory),
        didFail: { _ in })
      await isolated.load()
      XCTAssertEqual(isolated.content, "Personal seed")
      isolated.close()
    }
  }
  func testEnabledNavigationUsesDefaultForNewChatsAndRestoresWorkspaceModeFromCache() async throws {
    let directory = CacheTestDirectory(owner: self)
    let enabled = Mutex(true)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/agents":
        return ChatHTTPResponse(
          body:
            #"[{"agentId":"default","isDefaultAgent":true,"displayName":"Customized shared name"},{"agentId":"legacy","isDefaultAgent":false,"displayName":"Legacy"}]"#
        )
      case "/api/user-preferences":
        return ChatHTTPResponse(body: #"{"pinnedAgentIds":["legacy"]}"#)
      case "/api/feature-switches":
        return ChatHTTPResponse(
          body: "{\"effectiveSwitches\":{\"singleAgent\":\(enabled.withLock { $0 })}}")
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body:
            #"{"chatThreads":[{"id":"legacy-thread","agentId":"legacy","title":"Historical chat","sortAt":"2026-11-05T00:00:00Z","createdAt":"2026-11-05T00:00:00Z","updatedAt":"2026-11-05T00:00:00Z","pinnedAt":null,"renamedAt":null,"selectedModel":"gpt-5.6-sol","serviceTier":null,"computerUseHostId":null,"cloudBrowserEnabled":false}],"latestEventId":null,"latestSeqId":null}"#
        )
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"agents":{},"threads":{},"unreadAt":{}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "member", workspaceID: "alpha")
    let first = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope))
    await first.refreshNavigation()
    await first.list.refresh()
    first.selectChat("legacy-thread")
    XCTAssertEqual(first.selectedAgentID, "legacy")
    first.startNewChat(agentID: "legacy")
    XCTAssertEqual(first.selectedAgentID, "default")
    XCTAssertEqual(first.currentAgentName, "Okou")
    first.close()
    let reopened = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: scope))
    defer { reopened.close() }
    await reopened.list.restoreCached()
    reopened.startNewChat(agentID: "legacy")
    XCTAssertEqual(reopened.selectedAgentID, "default")
    let otherScope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "member", workspaceID: "beta")
    let other = WorkspaceStore(
      client: fixture.client, webURL: fixture.baseURL, cache: directory.cache(scope: otherScope))
    defer { other.close() }
    enabled.withLock { $0 = false }
    await other.refreshNavigation()
    other.startNewChat(agentID: "legacy")
    XCTAssertEqual(other.selectedAgentID, "legacy")
    XCTAssertEqual(other.list.visiblePinnedAgents.map(\.agentId), ["default", "legacy"])
  }

}

private struct Write: Decodable {
  let content: String
  let ifVersion: String
}

private func instructions(_ content: String, version: String = "v1") -> ChatHTTPResponse {
  let value = [
    "orgId": "org", "userId": "user", "content": content,
    "version": version, "updatedAt": "2026-11-05T00:00:00Z",
  ]
  return ChatHTTPResponse(
    body: String(data: try! JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
}
