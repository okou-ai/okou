import ChatData
import ChatDataTestSupport
import ChatDomain
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
    _ = try await cache.loadThreadList()
    try LegacyComposerFixture.storeLocation(previousID, in: cacheDirectory.url)
    let oldKey = "agent/" + previousID
    var document = ChatDraftDocument()
    document.replaceText("Unsent before upgrade")
    let record = ComposerDraftStore.LocalRecord(
      value: ComposerDraft(document: document),
      files: [], baseline: nil, dirty: true, cleared: false, consumedVoiceID: nil)
    try server.storage().save(record, key: oldKey)

    let workspace = WorkspaceStore(
      client: server.http.client, webURL: server.http.baseURL, cache: cache,
      draftStorage: server.storage())
    defer { workspace.close() }
    await workspace.prepareWorkspaceComposer()
    XCTAssertEqual(workspace.newChatDraft, "Unsent before upgrade")
    XCTAssertNil(try server.storage().load(oldKey, as: ComposerDraftStore.LocalRecord.self))
    XCTAssertNotNil(try server.storage().load("workspace", as: ComposerDraftStore.LocalRecord.self))
    workspace.setPhase(.active)
    await workspace.newComposer.synchronize()
    let requests = server.state.value.withLock { $0.paths }
    XCTAssertTrue(requests.contains("GET /api/chat-drafts/composer"))
    XCTAssertFalse(requests.contains(where: { $0.contains("/api/agents") }))
  }
}
