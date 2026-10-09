import Foundation
import XCTest

@testable import ChatData

@MainActor
final class ChatCacheTests: XCTestCase {
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

    let reopened = ChatCache(scope: scope, directory: directory)
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
