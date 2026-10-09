import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatSyncTests: XCTestCase {
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
    let detailReads = Mutex(0)
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
          return detailReads.withLock { $0 == 0 }
            ? syncPage([], cursor: 2) : syncPage(laterRows, cursor: 4)
        case 4: return syncPage([], cursor: 4)
        default: throw URLError(.unsupportedURL)
        }
      case syncPath:
        detailReads.withLock { $0 += 1 }
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = syncScope(fixture)
    let service = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let firstRead = Task { try await service.history(threadID: syncThreadID) }
    await fulfillment(of: [firstTailStarted], timeout: 2)
    let secondRead = Task {
      secondReadStarted.fulfill()
      return try await service.history(threadID: syncThreadID)
    }
    await fulfillment(of: [secondReadStarted], timeout: 2)
    releaseFirstTail.open()
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
