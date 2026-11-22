import ChatData
import ChatDataTestSupport
import Foundation
import XCTest

@testable import Okou

@MainActor
final class NavigationResourceTests: XCTestCase {
  func testUpgradeRestoresPendingLocalDraftAndUsesMemberComposerEndpoint() async throws {
    let server = DraftServer()
    defer { try? FileManager.default.removeItem(at: server.directory) }
    let cacheDirectory = CacheTestDirectory(owner: self)
    let cache = cacheDirectory.cache(
      scope: ChatCacheScope(apiBaseURL: server.http.baseURL, userID: "user", workspaceID: "org"))
    let previousID = "43000000-0000-4000-8000-000000000002"
    let previousNavigation = try JSONDecoder().decode(
      LegacyComposerLocation.self,
      from: Data(
        #"""
        {"agents":[{"agentId":"\#(previousID)","isDefaultAgent":true,"displayName":"Previous profile"}]}
        """#.utf8))
    try await cache.saveNavigation(previousNavigation)
    let oldComposer = server.composer(storage: server.storage().restoringWorkspace(previousID))
    oldComposer.text = "Unsent before upgrade"
    oldComposer.close()

    let workspace = WorkspaceStore(
      client: server.http.client, webURL: server.http.baseURL, cache: cache,
      draftStorage: server.storage())
    defer { workspace.close() }
    await workspace.prepareWorkspaceComposer()
    XCTAssertEqual(workspace.newChatDraft, "Unsent before upgrade")
    workspace.setPhase(.active)
    await workspace.newComposer.synchronize()
    let requests = server.state.value.withLock { $0.paths }
    XCTAssertTrue(requests.contains("GET /api/chat-drafts/composer"))
    XCTAssertFalse(requests.contains(where: { $0.contains("/api/agents") }))
  }
}
