import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatSyncTests: XCTestCase {
  func testExtensionTailBecomesVisibleToAResidentReaderBeforeAnyForegroundRequest() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let later = Mutex(false)
    let offline = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      switch request.url?.path {
      case syncPath + "/event-snapshot": return syncMissingSnapshot()
      case syncPath + "/event-rows":
        switch syncSequence(request) {
        case 0: return syncPage([syncRow(1, text: "First answer"), syncRow(2)], cursor: 2)
        case 2:
          return later.withLock { $0 }
            ? syncPage(
              [
                syncRow(3, text: "New answer", runID: syncSecondRunID),
                syncRow(4, runID: syncSecondRunID),
              ], cursor: 4)
            : syncPage([], cursor: 2)
        case 4: return syncPage([], cursor: 4)
        default: throw URLError(.unsupportedURL)
        }
      case syncPath: return ChatHTTPResponse(body: #"{"cancellationRecoveryPending":false}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let app = ChatSync(client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    _ = try await app.history(threadID: syncThreadID)
    later.withLock { $0 = true }
    let nse = ChatSync(client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let receipt = try await nse.prefetchHistoryTail(threadID: syncThreadID, runID: syncSecondRunID)
    XCTAssertTrue(receipt.containsRun)
    XCTAssertEqual(receipt.lastSeqID, 4)
    offline.withLock { $0 = true }
    let cached = await app.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(cached?.messages.map(\.text), ["First answer", "New answer"])
  }

  func testNotificationPrefetchReportsThePersistedTargetRunAndReopensOffline() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let offline = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      if offline.withLock({ $0 }) { throw URLError(.notConnectedToInternet) }
      switch request.url?.path {
      case syncPath + "/event-snapshot": return syncMissingSnapshot()
      case syncPath + "/event-rows":
        return syncSequence(request) == 0
          ? syncPage([syncRow(1, text: "Prefetched answer"), syncRow(2)], cursor: 2)
          : syncPage([], cursor: 2)
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let receipt = try await service.prefetchHistory(threadID: syncThreadID, runID: syncRunID)
    XCTAssertEqual(receipt.lastSeqID, 2)
    XCTAssertTrue(receipt.containsRun)
    offline.withLock { $0 = true }
    let reopened = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let cached = await reopened.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(cached?.messages.map(\.text), ["Prefetched answer"])
  }

  func testPreviousSchemaCacheRebuildsFromHeaderFreeSnapshotAndTail() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let requests = Mutex<[URLRequest]>([])
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      switch request.url?.path {
      case syncPath + "/event-snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/snapshot","expiresInSeconds":60,"lastEventId":"\(syncEventID(1))","lastSeqId":1}
            """)
      case "/snapshot":
        return ChatHTTPResponse(body: syncRow(1, text: "Current snapshot") + "\n")
      case syncPath + "/event-rows":
        switch syncSequence(request) {
        case 1: return syncPage([syncRow(2)], cursor: 2)
        case 2: return syncPage([], cursor: 2)
        default: throw URLError(.unsupportedURL)
        }
      case syncPath:
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let cache = ChatCache(scope: scope, directory: directory)
    try await cache.replaceHistory(
      threadID: syncThreadID,
      rows: [
        ChatCacheEvent(
          id: syncEventID(1), seqID: 1, data: Data(syncRow(1, text: "Old cached output").utf8))
      ],
      cursor: ChatCacheCursor(eventID: syncEventID(1), seqID: 1), schemaVersion: 7)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))

    let previousSchemaHistory = await service.cachedHistory(threadID: syncThreadID)
    XCTAssertNil(previousSchemaHistory)
    let history = try await service.history(threadID: syncThreadID)
    XCTAssertEqual(history.messages.map(\.text), ["Current snapshot"])
    XCTAssertEqual(history.executionState, .completed)
    XCTAssertEqual(history.persistedEventIDs, Set([syncEventID(1), syncEventID(2)]))
    let observed = requests.withLock { $0 }
    XCTAssertTrue(observed.contains { $0.url?.path == syncPath + "/event-snapshot" })
    XCTAssertTrue(observed.contains { $0.url?.path == syncPath + "/event-rows" })
    XCTAssertTrue(
      observed.allSatisfy { $0.value(forHTTPHeaderField: "X-Chat-Event-Schema-Version") == nil })

    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(restored?.messages.map(\.text), ["Current snapshot"])
    XCTAssertEqual(restored?.executionState, .completed)
    let durable = try await cache.loadHistory(threadID: syncThreadID)
    XCTAssertEqual(durable?.schemaVersion, 8)
  }

  func testUnavailableCacheRetainsDirtyRowsUntilLaterPersistenceSucceeds() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let blocker = directory.appendingPathComponent("ChatCache")
    try Data("A file prevents creating the cache directory".utf8).write(to: blocker)
    let hasNewTail = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case syncPath + "/event-snapshot": return syncMissingSnapshot()
      case syncPath + "/event-rows":
        switch syncSequence(request) {
        case 0:
          return syncPage([syncRow(1, text: "Initial answer"), syncRow(2)], cursor: 2)
        case 2:
          if hasNewTail.withLock({ $0 }) {
            return syncPage(
              [
                syncRow(3, text: "Later answer", runID: syncSecondRunID),
                syncRow(4, runID: syncSecondRunID),
              ], cursor: 4)
          }
          return syncPage([], cursor: 2)
        case 4: return syncPage([], cursor: 4)
        default: throw URLError(.unsupportedURL)
        }
      case syncPath:
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let first = try await service.history(threadID: syncThreadID)
    _ = await service.releaseHistory(threadID: syncThreadID)
    let retained = await service.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(retained?.messages.map(\.text), ["Initial answer"])

    XCTAssertEqual(first.messages.map(\.text), ["Initial answer"])

    try FileManager.default.removeItem(at: blocker)
    hasNewTail.withLock { $0 = true }
    let latest = try await service.history(threadID: syncThreadID)
    XCTAssertEqual(latest.messages.map(\.text), ["Initial answer", "Later answer"])

    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(restored?.messages.map(\.text), ["Initial answer", "Later answer"])
    XCTAssertEqual(restored?.executionState, .completed)
    XCTAssertEqual(restored?.persistedEventIDs, Set((1...4).map(syncEventID)))
  }

  func testOverlappingHistoryReadsCatchUpFromPriorCommittedCursor() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let firstTailStarted = expectation(description: "First history tail is in flight")
    let secondReadStarted = expectation(description: "Second history read is submitted")
    let releaseFirstTail = SyncResponseGate()
    defer { releaseFirstTail.open() }
    let requests = Mutex<[URLRequest]>([])
    let startReads = Mutex(0)
    let tailReads = Mutex(0)
    let initialRows = [syncRow(1, text: "Initial answer"), syncRow(2)]
    let laterRows = [
      syncRow(3, text: "Latest answer", runID: syncSecondRunID),
      syncRow(4, runID: syncSecondRunID),
    ]
    let fixture = ChatHTTPFixture { request in
      requests.withLock { $0.append(request) }
      switch request.url?.path {
      case syncPath + "/event-snapshot": return syncMissingSnapshot()
      case syncPath + "/event-rows":
        switch syncSequence(request) {
        case 0:
          let first = startReads.withLock {
            $0 += 1
            return $0 == 1
          }
          if first {
            firstTailStarted.fulfill()
            await releaseFirstTail.wait()
            return syncPage(initialRows, cursor: 2)
          }
          return syncPage(initialRows + laterRows, cursor: 4)
        case 2:
          // The next reader can catch up before the first reader requests thread details.
          let first = tailReads.withLock {
            $0 += 1
            return $0 == 1
          }
          return first
            ? syncPage([], cursor: 2) : syncPage(laterRows, cursor: 4)
        case 4: return syncPage([], cursor: 4)
        default: throw URLError(.unsupportedURL)
        }
      case syncPath:
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let firstRead = Task { try await service.history(threadID: syncThreadID) }
    await fulfillment(of: [firstTailStarted], timeout: 2)
    let prefetchStarted = expectation(description: "Notification prefetch started")
    let prefetchCancelled = expectation(
      description: "Prefetch cancels before the foreground response")
    let prefetch = Task {
      prefetchStarted.fulfill()
      do {
        try await service.prefetchHistory(threadID: syncThreadID)
        XCTFail("Cancelled prefetch must not complete a history read")
      } catch is CancellationError {
      } catch { XCTFail("Unexpected prefetch failure: \(error)") }
      prefetchCancelled.fulfill()
    }
    await fulfillment(of: [prefetchStarted], timeout: 2)
    prefetch.cancel()
    await fulfillment(of: [prefetchCancelled], timeout: 2)
    let secondRead = Task {
      secondReadStarted.fulfill()
      return try await service.history(threadID: syncThreadID)
    }
    await fulfillment(of: [secondReadStarted], timeout: 2)
    releaseFirstTail.open()
    await prefetch.value
    let first = try await firstRead.value
    let second = try await secondRead.value

    XCTAssertEqual(first.messages.map(\.text), ["Initial answer"])
    XCTAssertEqual(second.messages.map(\.text), ["Initial answer", "Latest answer"])
    let observed = requests.withLock { $0 }
    XCTAssertEqual(
      observed.filter { $0.url?.path == syncPath + "/event-snapshot" }.count, 1)
    XCTAssertEqual(
      observed.filter { $0.url?.path == syncPath + "/event-rows" }.compactMap(syncSequence),
      [0, 2, 2])
    let cache = ChatCache(scope: scope, directory: directory)
    let durable = try await cache.loadHistory(threadID: syncThreadID)
    XCTAssertEqual(durable?.cursor, ChatCacheCursor(eventID: syncEventID(4), seqID: 4))
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(restored?.messages.map(\.text), ["Initial answer", "Latest answer"])
  }
  func testWarmingPersistsUnopenedHistoryAndContinuesItsCursor() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let cursors = Mutex<[Int]>([])
    let fixture = ChatHTTPFixture { request in
      guard request.url?.path == "/api/chat/events/catch-up" else {
        throw URLError(.unsupportedURL)
      }
      let body = try XCTUnwrap(
        JSONSerialization.jsonObject(with: chatRequestBody(request)) as? [[Any]])
      let sequence = try XCTUnwrap(body.first?.last as? Int)
      cursors.withLock { $0.append(sequence) }
      return ChatHTTPResponse(
        body: """
          {"events":{"\(syncThreadID)":[\(sequence == 0 ? [syncRow(1, text: "Prepared answer"), syncRow(2)].joined(separator: ",") : "")]},"notFoundThreads":[]}
          """)
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    try await service.warmHistories(threadIDs: [syncThreadID, syncThreadID])
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(restored?.messages.map(\.text), ["Prepared answer"])
    XCTAssertEqual(restored?.executionState, .completed)
    try await restarted.warmHistories(threadIDs: [syncThreadID])
    XCTAssertEqual(cursors.withLock { $0 }, [0, 2])
  }

  func testOpeningAChatOvertakesWarmingAndKeepsTheNewerHistory() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let warmingStarted = expectation(description: "Batch warming is in flight")
    let releaseWarming = SyncResponseGate()
    defer { releaseWarming.open() }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat/events/catch-up":
        warmingStarted.fulfill()
        await releaseWarming.wait()
        return ChatHTTPResponse(
          body:
            "{\"events\":{\"\(syncThreadID)\":[\(syncRow(1, text: "Earlier answer"))]},\"notFoundThreads\":[]}"
        )
      case syncPath + "/event-snapshot": return syncMissingSnapshot()
      case syncPath + "/event-rows":
        return syncSequence(request) == 0
          ? syncPage([syncRow(1, text: "Earlier answer"), syncRow(2)], cursor: 2)
          : syncPage([], cursor: 2)
      case syncPath:
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    try await withThrowingTaskGroup(of: Void.self) { group in
      defer {
        group.cancelAll()
        releaseWarming.open()
      }
      group.addTask { try await service.warmHistories(threadIDs: [syncThreadID]) }
      await fulfillment(of: [warmingStarted], timeout: 2)
      let opened = try await service.history(threadID: syncThreadID)
      XCTAssertEqual(opened.executionState, .completed)
      releaseWarming.open()
      try await group.waitForAll()
    }
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(restored?.executionState, .completed)
    XCTAssertEqual(restored?.persistedEventIDs, Set([syncEventID(1), syncEventID(2)]))
  }

  func testWarmingRebuildsASnapshotWhenTheBatchCursorCannotContinue() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat/events/catch-up":
        return ChatHTTPResponse(body: "{\"events\":{},\"notFoundThreads\":[\"\(syncThreadID)\"]}")
      case syncPath + "/event-snapshot":
        return ChatHTTPResponse(
          body:
            "{\"url\":\"https://\(request.url!.host!)/snapshot\",\"lastEventId\":\"\(syncEventID(1))\",\"lastSeqId\":1}"
        )
      case "/snapshot": return ChatHTTPResponse(body: syncRow(1, text: "Snapshot answer") + "\n")
      case syncPath + "/event-rows":
        return syncSequence(request) == 1
          ? syncPage([syncRow(2)], cursor: 2) : syncPage([], cursor: 2)
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    try await service.warmHistories(threadIDs: [syncThreadID])
    let restored = await service.cachedHistory(threadID: syncThreadID)
    XCTAssertEqual(restored?.messages.map(\.text), ["Snapshot answer"])
    XCTAssertEqual(restored?.executionState, .completed)
  }

  func testWarmingRejectsAnIncompleteBatchWithoutPublishingHistory() async throws {
    let directory = try syncDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(body: "{\"events\":{},\"notFoundThreads\":[]}")
    }
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: syncScope(fixture), directory: directory))
    do {
      try await service.warmHistories(threadIDs: [syncThreadID])
      XCTFail("An incomplete response must not become an empty cached conversation")
    } catch is ChatError {}
    let restored = await service.cachedHistory(threadID: syncThreadID)
    XCTAssertNil(restored)
  }
}

private final class SyncResponseGate: Sendable {
  private let stream: AsyncStream<Void>
  private let continuation: AsyncStream<Void>.Continuation

  init() {
    let pair = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
    stream = pair.stream
    continuation = pair.continuation
  }

  func open() {
    continuation.yield(())
    continuation.finish()
  }

  func wait() async {
    for await _ in stream { return }
  }
}

private let syncThreadID = "60000000-0000-4000-8000-000000000001"
private let syncRunID = "60000000-0000-4000-8000-000000000002"
private let syncSecondRunID = "60000000-0000-4000-8000-000000000003"
private let syncPath = "/api/chat-threads/" + syncThreadID

private func syncEventID(_ sequence: Int) -> String {
  String(format: "61000000-0000-4000-8000-%012d", sequence)
}

private func syncRow(_ sequence: Int, text: String? = nil, runID: String = syncRunID) -> String {
  let eventType = text == nil ? "run.completed" : "output.message"
  let payload = text.map { "{\"content\":\"\($0)\"}" } ?? "null"
  return """
    {"id":"\(syncEventID(sequence))","chatThreadId":"\(syncThreadID)","runId":"\(runID)","revokesEventId":null,"contextType":null,"contextId":null,"runEventSequenceNumber":null,"runEventId":null,"seqId":\(sequence),"createdAt":"2026-10-03T00:00:00.000Z","eventType":"\(eventType)","payload":\(payload)}
    """
}

private func syncPage(_ rows: [String], cursor: Int) -> ChatHTTPResponse {
  let identity = cursor == 0 ? "null" : "\"\(syncEventID(cursor))\""
  return ChatHTTPResponse(
    body: """
      {"rows":[\(rows.joined(separator: ","))],"cursor":{"lastEventId":\(identity),"lastSeqId":\(cursor)},"hasMore":false}
      """)
}

private func syncSequence(_ request: URLRequest) -> Int? {
  guard let url = request.url,
    let value = URLComponents(url: url, resolvingAgainstBaseURL: false)?
      .queryItems?.first(where: { $0.name == "sinceSeqId" })?.value
  else { return nil }
  return Int(value)
}

private func syncScope(_ fixture: ChatHTTPFixture) -> ChatCacheScope {
  ChatCacheScope(apiBaseURL: fixture.baseURL, userID: "sync-user", workspaceID: "sync-workspace")
}

private func syncDirectory() throws -> URL {
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
    "okou-chat-sync-tests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  return directory
}

private func syncMissingSnapshot() -> ChatHTTPResponse {
  ChatHTTPResponse(
    status: 404,
    body: "{\"error\":{\"code\":\"CHAT_EVENT_SNAPSHOT_NOT_FOUND\",\"message\":\"No snapshot\"}}")
}
