import ChatData
import Synchronization
import XCTest

@testable import Okou

@MainActor
final class ChatThreadDeleteTests: XCTestCase {

  func testParentNotFoundDiscardsOnlyItsDraftAndTheCachedRowStaysGoneOnRestart() async throws {
    let fixture = ThreadActionsFixture()
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "owner", workspaceID: "workspace")
    let storage = ChatDraftStorage(scope: scope, directory: directory.url)
    let id = ThreadActionsFixture.thread
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL,
      cache: directory.cache(scope: scope), draftStorage: storage)
    await store.prepareWorkspaceComposer()
    store.newComposer.text = "A separate new chat draft"
    _ = await store.list.refresh()
    store.selectChat(id)
    let chat = try XCTUnwrap(store.selectedConversation)
    chat.composer.text = "Unsent in the deleted chat"
    // Snapshot absence in a live chat is normal; the detail still exists.
    await chat.refresh(waitForCurrent: true)
    XCTAssertEqual(store.selectedThreadID, id)
    XCTAssertTrue(storage.hasThreadDraft(id))
    fixture.state.value.withLock { $0.parentStatus = 404 }
    await chat.refresh(waitForCurrent: true)

    XCTAssertNil(store.selectedThreadID)
    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertFalse(chat.composer.hasContent)
    XCTAssertNil(chat.composer.conflictingRemote)
    XCTAssertFalse(storage.hasThreadDraft(id))
    let feedback = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(feedback.message, String(localized: "This chat is no longer available."))
    XCTAssertNil(feedback.actionTitle)
    XCTAssertEqual(store.newComposer.text, "A separate new chat draft")
    await store.close().value

    let restarted = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL,
      cache: directory.cache(scope: scope), draftStorage: storage)
    defer { restarted.close() }
    await restarted.list.restoreCached()
    XCTAssertTrue(restarted.list.hasLoadedThreads)
    XCTAssertTrue(restarted.list.threads.isEmpty)
    _ = await restarted.list.refresh()
    XCTAssertTrue(restarted.list.threads.isEmpty)
    await restarted.prepareWorkspaceComposer()
    XCTAssertEqual(restarted.newComposer.text, "A separate new chat draft")
  }

  func testDeletionBetweenDraftReadAndSaveClosesTheComposerWithoutAConflict() async throws {
    let fixture = ThreadActionsFixture()
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "owner", workspaceID: "workspace")
    let storage = ChatDraftStorage(scope: scope, directory: directory.url)
    let id = ThreadActionsFixture.thread
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL,
      cache: directory.cache(scope: scope), draftStorage: storage)
    _ = await store.list.refresh()
    store.selectChat(id)
    let chat = try XCTUnwrap(store.selectedConversation)
    chat.composer.text = "Edited before the chat was removed"
    fixture.state.value.withLock { $0.failNext["draft-save"] = 404 }
    chat.composer.setForeground(true)
    await chat.composer.synchronize()
    XCTAssertNil(store.selectedThreadID)
    XCTAssertFalse(storage.hasThreadDraft(id))
    XCTAssertNil(chat.composer.conflictingRemote)
    XCTAssertNil(chat.composer.syncWarning)
    XCTAssertTrue(store.list.threads.isEmpty)
    await store.close().value
  }

  func testRemoteDeleteCleansAReleasedDraftAndItsImportedFiles() async throws {
    let fixture = ThreadActionsFixture()
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "owner", workspaceID: "workspace")
    let storage = ChatDraftStorage(scope: scope, directory: directory.url)
    let id = ThreadActionsFixture.thread
    let key = ChatDraftTarget.thread(id).key
    let store = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL,
      cache: directory.cache(scope: scope), draftStorage: storage)
    _ = await store.list.refresh()
    let chat = try XCTUnwrap(store.conversation(for: id))
    chat.composer.text = "Persisted before the other device deleted the chat"
    await store.close().value

    var record = try XCTUnwrap(storage.load(key, as: ComposerDraftStore.LocalRecord.self))
    let copy = directory.url.appendingPathComponent("Imported/file.txt")
    try FileManager.default.createDirectory(
      at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("file".utf8).write(to: copy)
    record.files = [
      .init(
        file: ImportedAttachmentFile(
          url: copy, filename: "file.txt", contentType: "text/plain", size: 4, thumbnail: nil),
        uploaded: nil)
    ]
    try storage.save(record, key: key)
    let pendingKey = ChatDraftTarget.thread(id).pendingKey
    try storage.save(["Unconfirmed send"], key: pendingKey)
    let other = ChatDraftStorage(
      scope: ChatCacheScope(
        apiBaseURL: fixture.http.baseURL, userID: "owner", workspaceID: "other"),
      directory: directory.url)
    try other.save("Other workspace", key: key)
    fixture.remote(kind: "deleted")
    let restarted = WorkspaceStore(
      client: fixture.http.client, webURL: fixture.http.baseURL,
      cache: directory.cache(scope: scope), draftStorage: storage)
    defer { restarted.close() }
    _ = await restarted.list.refresh()
    XCTAssertTrue(restarted.list.threads.isEmpty)
    XCTAssertNil(restarted.threadFeedback)
    XCTAssertFalse(storage.hasThreadDraft(id))
    XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    XCTAssertNil(try storage.load(pendingKey, as: [String].self))
    XCTAssertEqual(try other.load(key, as: String.self), "Other workspace")
  }

  func testExpiredCursorAcceptsLowerSnapshotAndKeepsDraftUntilParentConfirmsRemoval() async throws {
    let fixture = ThreadActionsFixture()
    let directory = CacheTestDirectory(owner: self)
    let scope = ChatCacheScope(
      apiBaseURL: fixture.http.baseURL, userID: "owner", workspaceID: "workspace")
    let storage = ChatDraftStorage(scope: scope, directory: directory.url)
    let id = ThreadActionsFixture.thread
    func workspace() -> WorkspaceStore {
      WorkspaceStore(
        client: fixture.http.client, webURL: fixture.http.baseURL,
        cache: directory.cache(scope: scope), draftStorage: storage)
    }
    let store = workspace()
    defer { store.close() }
    fixture.remote(kind: "renamed", extra: #","title":"Previous timeline""#)
    _ = await store.list.refresh()
    store.selectChat(id)
    let chat = try XCTUnwrap(store.selectedConversation)
    chat.composer.text = "Keep on a cursor expiry"
    fixture.state.value.withLock {
      $0.events = []
      $0.failNext["events"] = 410
    }
    let prefetch = ChatSync(client: fixture.http.client, cache: directory.cache(scope: scope))
    try await prefetch.prefetchThreadList()
    await store.list.restoreCached()
    XCTAssertEqual(store.list.threads.first?.title, "Planning a useful week")
    XCTAssertEqual(store.selectedThreadID, id)
    XCTAssertEqual(chat.composer.text, "Keep on a cursor expiry")
    let reopened = ChatSync(client: fixture.http.client, cache: directory.cache(scope: scope))
    let cached = await reopened.cachedThreads()
    XCTAssertEqual(cached?.first?.title, "Planning a useful week")

    fixture.remote(kind: "renamed", extra: #","title":"Before reset""#)
    _ = await store.list.refresh()
    fixture.state.value.withLock {
      $0.events = []
      $0.failNext["events"] = 410
      $0.snapshotIncludesThread = false
      $0.parentStatus = 503
    }
    await store.close().value
    try await prefetch.prefetchThreadList()
    let afterReset = workspace()
    defer { afterReset.close() }
    _ = await afterReset.list.refresh()
    XCTAssertTrue(afterReset.list.threads.isEmpty)
    XCTAssertTrue(storage.hasThreadDraft(id))
    XCTAssertNil(afterReset.threadFeedback)
    await afterReset.close().value

    fixture.state.value.withLock { $0.parentStatus = 404 }
    let retried = workspace()
    defer { retried.close() }
    _ = await retried.list.refresh()
    XCTAssertFalse(storage.hasThreadDraft(id))
    let pending = await reopened.pendingThreadAbsences()
    XCTAssertTrue(pending.isEmpty)
  }

  func testDeleteRemovesTheChatAtOnceAndLeavesItsOpenDetail() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    store.selectChat(ThreadActionsFixture.thread)
    let gate = ThreadActionGate()
    defer { gate.open() }
    let requested = expectation(description: "Delete reached the HTTP boundary")
    fixture.state.value.withLock {
      $0.nextGate = gate
      $0.nextWriteRequested = { requested.fulfill() }
    }
    let deleting = Task { await store.deleteThread(ThreadActionsFixture.thread) }
    addTeardownBlock {
      deleting.cancel()
      gate.open()
      _ = await deleting.value
    }
    await fulfillment(of: [requested], timeout: 3)

    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertNil(store.selectedThreadID)
    gate.open()
    let deleted = await deleting.value

    XCTAssertTrue(deleted)
    XCTAssertNil(store.threadFeedback)
    await store.refresh()
    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertEqual(fixture.writes.map(\.action), ["delete"])
  }

  func testUnconfirmedDeleteKeepsTheChatHiddenAndRetriesTheSameEvent() async throws {
    let fixture = ThreadActionsFixture()
    let store = fixture.workspace()
    defer { store.close() }
    await store.prepareWorkspaceComposer()
    await store.refresh()
    let chat = try XCTUnwrap(store.conversation(for: ThreadActionsFixture.thread))
    chat.composer.text = "Keep until the deletion is confirmed"
    fixture.state.value.withLock { $0.failNext["delete"] = 503 }

    let deleted = await store.deleteThread(ThreadActionsFixture.thread)

    XCTAssertFalse(deleted)
    XCTAssertTrue(chat.composer.hasContent)
    // Only the persistent event settles the optimistic delete; a failure does not restore it.
    XCTAssertTrue(store.list.threads.isEmpty)
    let retry = try XCTUnwrap(store.threadFeedback)
    XCTAssertEqual(retry.actionTitle, "Retry")
    XCTAssertTrue(retry.persists)
    XCTAssertTrue(store.list.canWrite(ThreadActionsFixture.thread))
    await retry.action()
    XCTAssertFalse(chat.composer.hasContent)
    XCTAssertNil(store.threadFeedback)
    await store.refresh()
    XCTAssertTrue(store.list.threads.isEmpty)
    XCTAssertEqual(fixture.writes.map(\.action), ["delete", "delete"])
    let eventIDs = fixture.writes.compactMap(\.eventID)
    XCTAssertEqual(eventIDs.count, 2)
    XCTAssertEqual(Set(eventIDs).count, 1)
  }
}
