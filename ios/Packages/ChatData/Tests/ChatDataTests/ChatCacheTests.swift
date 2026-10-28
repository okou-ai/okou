import Foundation
import SQLite3
import XCTest

@testable import ChatData

@MainActor
final class ChatCacheTests: XCTestCase {
  func testClosedCacheRejectsLateWritesAndANewConnectionRetainsCommittedHistory() async throws {
    let directory = CacheTestDirectory(owner: self)
    let cache = directory.cache(scope: scope())
    try await cache.replaceHistory(
      threadID: "chat", rows: [event(1)],
      cursor: ChatCacheCursor(eventID: event(1).id, seqID: 1), schemaVersion: 8)
    await cache.close()
    do {
      try await cache.appendHistory(
        threadID: "chat", rows: [event(2)],
        cursor: ChatCacheCursor(eventID: event(2).id, seqID: 2), schemaVersion: 8)
      XCTFail("A retired connection must reject late work")
    } catch ChatCacheError.unavailable {}
    let reopened = directory.cache(scope: scope())
    let history = try await reopened.loadHistory(threadID: "chat")
    XCTAssertEqual(history?.rows, [event(1)])
    await reopened.close()
  }

  func testSharedCacheImportsThePrivateCacheWithoutReplacingNewerExtensionHistory() async throws {
    let legacyRoot = CacheTestDirectory(owner: self)
    let sharedRoot = CacheTestDirectory(owner: self)
    let legacy = legacyRoot.cache(scope: scope())
    try await legacy.replaceThreadList(
      snapshot: Data(#"{"chatThreads":[]}"#.utf8),
      cursor: ChatCacheCursor(eventID: nil, seqID: 0), events: [])
    let navigation = try JSONDecoder().decode(
      SidebarNavigationSnapshot.self,
      from: Data(
        #"{"agents":[{"agentId":"agent-old","isDefaultAgent":true,"displayName":"Assistant"}],"preferences":{"pinnedAgentIds":[]},"featureSwitches":{"effectiveSwitches":{}}}"#
          .utf8))
    try await legacy.saveNavigation(navigation)
    try await legacy.replaceHistory(
      threadID: "chat", rows: [event(1)],
      cursor: ChatCacheCursor(eventID: event(1).id, seqID: 1), schemaVersion: 8)
    try await legacy.replaceHistory(
      threadID: "other", rows: [event(1)],
      cursor: ChatCacheCursor(eventID: event(1).id, seqID: 1), schemaVersion: 8)
    let extensionCache = sharedRoot.cache(scope: scope())
    try await extensionCache.replaceHistory(
      threadID: "chat", rows: [event(1), event(2)],
      cursor: ChatCacheCursor(eventID: event(2).id, seqID: 2), schemaVersion: 8)
    let app = sharedRoot.cache(scope: scope(), migratingFrom: legacyRoot.url)
    let newest = try await app.loadHistory(threadID: "chat")
    XCTAssertEqual(newest?.rows, [event(1), event(2)])
    let imported = try await app.loadHistory(threadID: "other")
    XCTAssertEqual(imported?.rows, [event(1)])
    let restoredNavigation = try await app.loadNavigation()
    XCTAssertEqual(restoredNavigation?.agents.first?.displayName, "Assistant")
    let retained = try await legacy.loadHistory(threadID: "chat")
    XCTAssertEqual(retained?.rows, [event(1)])
  }

  func testOverlappingConnectionsCannotMoveHistoryOrListCursorsBackwards() async throws {
    let directory = CacheTestDirectory(owner: self)
    let first = directory.cache(scope: scope())
    let second = directory.cache(scope: scope())
    try await first.replaceHistory(
      threadID: "chat", rows: [event(1)],
      cursor: ChatCacheCursor(eventID: event(1).id, seqID: 1), schemaVersion: 8)
    try await second.appendHistory(
      threadID: "chat", rows: [event(2)],
      cursor: ChatCacheCursor(eventID: event(2).id, seqID: 2), schemaVersion: 8)
    try await first.replaceHistory(
      threadID: "chat", rows: [event(1)],
      cursor: ChatCacheCursor(eventID: event(1).id, seqID: 1), schemaVersion: 8)
    try await first.appendHistory(
      threadID: "chat", rows: [event(1)],
      cursor: ChatCacheCursor(eventID: event(1).id, seqID: 1), schemaVersion: 8)
    let latest = try await second.loadHistory(threadID: "chat")
    XCTAssertEqual(latest?.cursor.seqID, 2)
    XCTAssertEqual(latest?.rows, [event(1), event(2)])
    try await first.replaceThreadList(
      snapshot: Data("old".utf8),
      cursor: ChatCacheCursor(eventID: nil, seqID: 0), events: [event(1)])
    try await second.replaceThreadList(
      snapshot: Data("new".utf8),
      cursor: ChatCacheCursor(eventID: event(2).id, seqID: 2), events: [event(3)])
    try await first.replaceThreadList(
      snapshot: Data("old".utf8),
      cursor: ChatCacheCursor(eventID: nil, seqID: 0), events: [event(1)])
    try await first.appendThreadEvents([event(1)])
    let list = try await second.loadThreadList()
    XCTAssertEqual(list?.snapshot, Data("new".utf8))
    XCTAssertEqual(list?.events, [event(3)])
  }

  func testThreadListSurvivesRestartAndIsScopedToIdentity() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let scope = ChatCacheScope(
      apiBaseURL: URL(string: "https://api.example.invalid")!, userID: "user-a",
      workspaceID: "workspace-a")
    let snapshot = Data(#"{"chatThreads":[]}"#.utf8)
    let first = ChatCache(scope: scope, directory: directory)
    try await first.replaceThreadList(
      snapshot: snapshot, cursor: ChatCacheCursor(eventID: nil, seqID: 10),
      events: [event(11), event(13)])

    // Reproduce the preceding build's version-one cache: the authoritative
    // thread tables exist, but the additive navigation table does not.
    let file = try XCTUnwrap(
      FileManager.default.contentsOfDirectory(
        at: directory.appendingPathComponent("ChatCache"), includingPropertiesForKeys: nil
      ).first { $0.pathExtension == "sqlite" })
    var handle: OpaquePointer?
    let opened = sqlite3_open(file.path, &handle)
    defer { sqlite3_close(handle) }
    XCTAssertEqual(opened, SQLITE_OK)
    XCTAssertEqual(sqlite3_exec(handle, "DROP TABLE sidebar_navigation", nil, nil, nil), SQLITE_OK)

    let reopened = ChatCache(scope: scope, directory: directory)
    let navigation = try JSONDecoder().decode(
      SidebarNavigationSnapshot.self,
      from: Data(
        #"{"agents":[{"agentId":"agent-a","isDefaultAgent":true,"displayName":"Assistant"}],"preferences":{"pinnedAgentIds":["agent-a"]},"featureSwitches":{"effectiveSwitches":{"chatThreadArchiving":true}}}"#
          .utf8))
    try await reopened.saveNavigation(navigation)
    let persistedNavigation = try await ChatCache(scope: scope, directory: directory)
      .loadNavigation()
    XCTAssertEqual(persistedNavigation?.agents.first?.displayName, "Assistant")
    XCTAssertEqual(persistedNavigation?.preferences.pinnedAgentIds, ["agent-a"])
    XCTAssertEqual(
      persistedNavigation?.featureSwitches.effectiveSwitches["chatThreadArchiving"], true)
    let loaded = try await reopened.loadThreadList()
    let stored = try XCTUnwrap(loaded)
    XCTAssertEqual(stored.snapshot, snapshot)
    XCTAssertEqual(stored.snapshotCursor, ChatCacheCursor(eventID: nil, seqID: 10))
    XCTAssertEqual(stored.events, [event(11), event(13)])

    // Replayed network pages are harmless; a new page extends the durable tail.
    try await reopened.appendThreadEvents([event(13), event(16)])
    let extended = try await reopened.loadThreadList()
    XCTAssertEqual(extended?.events, [event(11), event(13), event(16)])

    let otherUser = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: scope.apiBaseURL, userID: "user-b", workspaceID: scope.workspaceID),
      directory: directory)
    let otherWorkspace = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: scope.apiBaseURL, userID: scope.userID, workspaceID: "workspace-b"),
      directory: directory)
    let otherAPI = ChatCache(
      scope: ChatCacheScope(
        apiBaseURL: URL(string: "https://other.example.invalid")!, userID: scope.userID,
        workspaceID: scope.workspaceID), directory: directory)
    let foreignUser = try await otherUser.loadThreadList()
    let foreignWorkspace = try await otherWorkspace.loadThreadList()
    let foreignAPI = try await otherAPI.loadThreadList()
    XCTAssertNil(foreignUser)
    XCTAssertNil(foreignWorkspace)
    XCTAssertNil(foreignAPI)
    let foreignUserNavigation = try await otherUser.loadNavigation()
    let foreignWorkspaceNavigation = try await otherWorkspace.loadNavigation()
    let foreignAPINavigation = try await otherAPI.loadNavigation()
    XCTAssertNil(foreignUserNavigation)
    XCTAssertNil(foreignWorkspaceNavigation)
    XCTAssertNil(foreignAPINavigation)
  }

  func testFailedAppendRollsBackEarlierRowsInSamePage() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = ChatCache(scope: scope(), directory: directory)
    try await cache.replaceThreadList(
      snapshot: Data("snapshot".utf8), cursor: ChatCacheCursor(eventID: nil, seqID: 10),
      events: [event(11)])

    do {
      try await cache.appendThreadEvents([
        event(12), ChatCacheEvent(id: event(11).id, seqID: 13, data: Data("conflict".utf8)),
      ])
      XCTFail("An event ID cannot be reused at a different sequence")
    } catch {
      let stored = try await cache.loadThreadList()
      XCTAssertEqual(stored?.events, [event(11)])
    }
  }

  func testHistoryCursorAndRowsCommitTogetherAndCanBeRemoved() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = ChatCache(scope: scope(), directory: directory)
    let threadID = "thread-a"
    try await cache.replaceHistory(
      threadID: threadID, rows: [event(2), event(3)],
      cursor: ChatCacheCursor(eventID: event(3).id, seqID: 3), schemaVersion: 7)
    try await cache.appendHistory(
      threadID: threadID, rows: [event(3), event(5)],
      cursor: ChatCacheCursor(eventID: event(5).id, seqID: 5), schemaVersion: 7)
    try await cache.appendHistory(
      threadID: threadID, rows: [],
      cursor: ChatCacheCursor(eventID: event(5).id, seqID: 5), schemaVersion: 7)

    let reopened = ChatCache(scope: scope(), directory: directory)
    let loaded = try await reopened.loadHistory(threadID: threadID)
    let stored = try XCTUnwrap(loaded)
    XCTAssertEqual(stored.rows, [event(2), event(3), event(5)])
    XCTAssertEqual(stored.cursor, ChatCacheCursor(eventID: event(5).id, seqID: 5))
    XCTAssertEqual(stored.schemaVersion, 7)

    try await reopened.deleteHistory(threadID: threadID)
    let deleted = try await reopened.loadHistory(threadID: threadID)
    XCTAssertNil(deleted)
  }

  func testDamagedDatabaseIsDiscarded() async throws {
    let directory = temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    try await writeInitialCache(directory: directory)
    let cacheDirectory = directory.appendingPathComponent("ChatCache", isDirectory: true)
    let files = try FileManager.default.contentsOfDirectory(
      at: cacheDirectory, includingPropertiesForKeys: nil)
    let database = try XCTUnwrap(files.first(where: { $0.pathExtension == "sqlite" }))
    for file in files { try FileManager.default.removeItem(at: file) }
    try Data("not a SQLite database".utf8).write(to: database)

    let reopened = ChatCache(scope: scope(), directory: directory)
    let discarded = try await reopened.loadThreadList()
    XCTAssertNil(discarded)
    try await reopened.replaceThreadList(
      snapshot: Data("new".utf8), cursor: ChatCacheCursor(eventID: nil, seqID: 0), events: [])
    let fresh = try await reopened.loadThreadList()
    XCTAssertEqual(fresh?.snapshot, Data("new".utf8))
  }

  private func writeInitialCache(directory: URL) async throws {
    let cache = ChatCache(scope: scope(), directory: directory)
    try await cache.replaceThreadList(
      snapshot: Data("old".utf8), cursor: ChatCacheCursor(eventID: nil, seqID: 0), events: [])
  }

  private func scope() -> ChatCacheScope {
    ChatCacheScope(
      apiBaseURL: URL(string: "https://api.example.invalid")!, userID: "user-a",
      workspaceID: "workspace-a")
  }

  private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(
      UUID().uuidString, isDirectory: true)
  }

  private func event(_ sequence: Int) -> ChatCacheEvent {
    ChatCacheEvent(
      id: "event-\(sequence)", seqID: sequence, data: Data("row-\(sequence)".utf8))
  }
}
