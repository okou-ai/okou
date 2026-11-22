import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatClientTests: XCTestCase {

  func testUpgradeRequiredBlocksHistory() async throws {
    let fixture = ChatHTTPFixture { _ in
      ChatHTTPResponse(
        status: 426, body: "{\"error\":{\"message\":\"Client update required\"}}")
    }
    do {
      _ = try await ChatSync(client: fixture.client).history(threadID: fixtureThread)
      XCTFail("Expected upgrade-required response")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 426)
      XCTAssertEqual(error.errorDescription, "Update Okou in TestFlight to continue.")
    }
  }

  func testListReplaysRenameDeletionAndNewThreadAfterSnapshot() async throws {
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[\(threadJSON(id: fixtureThread, date: "2026-09-17T10:00:00.123456")),\(threadJSON(id: deletedThread, date: "2026-09-17T10:00:00"))],"latestEventId":"\(eventIdentity(10))","latestSeqId":10}
            """)
      case "/api/chat-threads/events":
        return ChatHTTPResponse(
          body: """
            {"events":[\(threadEventJSON(seq: 11, kind: "renamed", thread: fixtureThread, title: "Latest title")),\(threadEventJSON(seq: 12, kind: "deleted", thread: deletedThread)),\(threadEventJSON(seq: 13, kind: "created", thread: newThread))],"hasMore":false}
            """)
      case "/api/indicators":
        return ChatHTTPResponse(
          body: "{\"unreadAt\":{},\"threads\":{\"\(fixtureThread)\":\"unread\"}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let threads = try await ChatSync(client: fixture.client).threads()
    XCTAssertEqual(Set(threads.map(\.id)), [fixtureThread, newThread])
    XCTAssertEqual(threads.first(where: { $0.id == fixtureThread })?.title, "Latest title")
    XCTAssertEqual(threads.first(where: { $0.id == fixtureThread })?.indicator, .unread)
    let snapshotThread = try XCTUnwrap(threads.first(where: { $0.id == fixtureThread }))
    XCTAssertEqual(
      snapshotThread.createdAt.timeIntervalSince1970, 1_789_639_200.123456, accuracy: 0.000001)
  }

  func testServerTimestampsKeepTheirUTCInstantsAndPrecisionAcrossOfflineRestart() async throws {
    let directory = CacheTestDirectory(owner: self)
    let dates: [(value: String, seconds: TimeInterval)] = [
      ("2026-09-17T10:00:00.123Z", 1_789_639_200.123),
      ("2026-09-17T10:00:00Z", 1_789_639_200),
      ("2026-09-17T10:00:00.123456", 1_789_639_200.123456),
      ("2026-09-17T10:00:01", 1_789_639_201),
      ("2026-09-17T18:00:00.123+08:00", 1_789_639_200.123),
      ("2026-09-17T05:00:02-05:00", 1_789_639_202)
    ]
    let snapshot = dates.enumerated().map { index, date in
      threadJSON(id: eventIdentity(index + 1), date: date.value)
    }.joined(separator: ",")
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(snapshot)],\"latestEventId\":null,\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: #"{"events":[],"hasMore":false}"#)
      case "/api/indicators":
        return ChatHTTPResponse(body: #"{"threads":{},"unreadAt":{}}"#)
      default: throw URLError(.unsupportedURL)
      }
    }
    addTeardownBlock { fixture.session.invalidateAndCancel() }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "timestamp-user", workspaceID: "timestamp-workspace")
    let cache = directory.cache(scope: scope)
    let service = ChatSync(client: fixture.client, cache: cache)
    let online = try await service.threads()
    await cache.close()
    fixture.session.invalidateAndCancel()
    let reopened = directory.cache(scope: scope)
    let restored = await ChatSync(client: fixture.client, cache: reopened).cachedThreads()
    for threads in [online, try XCTUnwrap(restored)] {
      XCTAssertEqual(threads.count, dates.count)
      for (index, date) in dates.enumerated() {
        let thread = try XCTUnwrap(threads.first { $0.id == eventIdentity(index + 1) })
        XCTAssertEqual(thread.createdAt.timeIntervalSince1970, date.seconds, accuracy: 0.000001)
        XCTAssertEqual(thread.updatedAt.timeIntervalSince1970, date.seconds, accuracy: 0.000001)
        XCTAssertEqual(thread.sortAt.timeIntervalSince1970, date.seconds, accuracy: 0.000001)
      }
    }
  }

  func testListKeepsArchivedSnapshotAndReplaysUnarchive() async throws {
    let archivedThread = threadJSON(id: fixtureThread)
      .replacingOccurrences(of: "\"renamedAt\":null", with: "\"archived\":true,\"renamedAt\":null")
    let snapshotOnly = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(archivedThread)],\"latestSeqId\":null}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let archived = try await ChatSync(client: snapshotOnly.client).threads()
    XCTAssertEqual(archived.first?.isArchived, true)

    let unarchivedEvent = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: "{\"chatThreads\":[\(archivedThread)],\"latestSeqId\":10}")
      case "/api/chat-threads/events":
        return ChatHTTPResponse(
          body:
            "{\"events\":[\(threadEventJSON(seq: 11, kind: "unarchived", thread: fixtureThread))],\"hasMore\":false}"
        )
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let unarchived = try await ChatSync(client: unarchivedEvent.client).threads()
    XCTAssertEqual(unarchived.first?.isArchived, false)
  }

  func testRestartReadsCachedListAndHistoryBeforeIncrementalCatchUp() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let since = chatQueryValue("sinceSeqId", in: request)
      requests.withLock { $0.append("\(path)?\(since ?? "")") }
      switch path {
      case "/api/chat-threads/snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/list-snapshot","latestEventId":"\(eventIdentity(10))","latestSeqId":10}
            """)
      case "/list-snapshot":
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(threadJSON(id: fixtureThread))]}")
      case "/api/chat-threads/events":
        if since == "10" {
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 11, kind: "renamed", thread: fixtureThread, title: "Synced title"))],\"hasMore\":false}"
          )
        }
        guard since == "11" else { throw URLError(.badServerResponse) }
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/history-snapshot","lastEventId":"\(eventIdentity(1))","lastSeqId":1}
            """)
      case "/history-snapshot":
        return ChatHTTPResponse(
          body: eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Hello")) + "\n")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        if since == "1" {
          return ChatHTTPResponse(
            body: """
              {"rows":[\(eventJSON(seq: 2, type: "output.message", payload: "{\"content\":\"Answer\"}")),\(eventJSON(seq: 3, type: "run.completed"))],"cursor":{"lastEventId":"\(eventIdentity(3))","lastSeqId":3},"hasMore":false}
              """)
        }
        guard since == "3" else { throw URLError(.badServerResponse) }
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(3))\",\"lastSeqId\":3},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "warm-cache-user", workspaceID: "warm-cache-workspace")
    let first = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let firstThreads = try await first.threads()
    let firstHistory = try await first.history(threadID: fixtureThread)
    XCTAssertEqual(firstThreads.first?.title, "Synced title")
    XCTAssertEqual(firstHistory.messages.map(\.text), ["Hello", "Answer"])

    let requestsBeforeRestart = requests.withLock { $0.count }
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let cachedThreads = await restarted.cachedThreads()
    let cachedHistory = await restarted.cachedHistory(threadID: fixtureThread)
    XCTAssertEqual(cachedThreads?.first?.title, "Synced title")
    XCTAssertEqual(cachedHistory?.messages.map(\.text), ["Hello", "Answer"])
    XCTAssertEqual(requests.withLock { $0.count }, requestsBeforeRestart)
    let unchanged = await restarted.cachedThreadList(newerThan: 11)
    XCTAssertNil(unchanged)
    let afterSnapshot = await restarted.cachedThreadList(newerThan: 10)
    XCTAssertEqual(afterSnapshot?.threads.first?.title, "Synced title")
    XCTAssertEqual(afterSnapshot?.cursor.seqID, 11)

    let restartedThreads = try await restarted.threads()
    let restartedHistory = try await restarted.history(threadID: fixtureThread)
    XCTAssertEqual(restartedThreads.first?.title, "Synced title")
    XCTAssertEqual(restartedHistory.messages.map(\.text), ["Hello", "Answer"])
    let paths = requests.withLock { $0 }
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/snapshot?" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot?" }.count, 1)
    XCTAssertEqual(
      paths.filter { $0 == "/api/chat-threads/\(fixtureThread)/event-snapshot?" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/history-snapshot?" }.count, 1)
    XCTAssertTrue(paths.contains("/api/chat-threads/events?11"))
    XCTAssertTrue(paths.contains("/api/chat-threads/\(fixtureThread)/event-rows?3"))
  }

  func testThreadListRetainsObservedEventIdentitiesAcrossSnapshotCompaction() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let compact = Mutex(false)
    let fixture = ChatHTTPFixture { request in
      let current = compact.withLock { $0 }
      switch request.url?.path {
      case "/api/chat-threads/snapshot":
        let thread = threadJSON(id: fixtureThread)
          .replacingOccurrences(
            of: "Original title", with: current ? "Compacted title" : "Original title")
        let cursor = current ? "\"\(eventIdentity(101))\"" : "null"
        return ChatHTTPResponse(
          body: """
            {"chatThreads":[\(thread)],"latestEventId":\(cursor),"latestSeqId":\(current ? "101" : "null")}
            """)
      case "/api/chat-threads/events":
        let events =
          current && chatQueryValue("sinceSeqId", in: request) == nil
          ? (1...101).map {
            threadEventJSON(seq: $0, kind: "renamed", thread: fixtureThread, title: "Event \($0)")
          }
          : []
        return ChatHTTPResponse(
          body: "{\"events\":[\(events.joined(separator: ","))],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"threads\":{},\"unreadAt\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let sync = ChatSync(
      client: fixture.client,
      cache: ChatCache(
        scope: ChatCacheScope(
          apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace"),
        directory: directory))
    _ = try await sync.threads()
    compact.withLock { $0 = true }
    let result = try await sync.threadsWithIndicators()
    XCTAssertEqual(result.threads.first?.title, "Compacted title")
    XCTAssertEqual(result.eventIDs, Set((1...101).map(eventIdentity)))
  }

}

@MainActor
final class ChatCursorRecoveryTests: XCTestCase {

  func testMissingThreadSnapshotDoesNotBecomeEmptyHistory() async throws {
    let tailReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        return ChatHTTPResponse(
          status: 404,
          body: "{\"error\":{\"code\":\"CHAT_THREAD_NOT_FOUND\",\"message\":\"Chat not found\"}}")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        tailReads.withLock { $0 += 1 }
        throw URLError(.unsupportedURL)
      default: throw URLError(.unsupportedURL)
      }
    }

    do {
      _ = try await ChatSync(client: fixture.client).history(threadID: fixtureThread)
      XCTFail("A missing thread must not render as empty history")
    } catch let error as APIClientError {
      XCTAssertEqual(error.statusCode, 404)
    }
    XCTAssertEqual(tailReads.withLock { $0 }, 0)
  }

  func testExpiredListAndHistoryCursorsReplacePersistedCacheAfterRestart() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let generation = Mutex(1)
    let requests = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let since = chatQueryValue("sinceSeqId", in: request)
      let current = generation.withLock { $0 }
      requests.withLock { $0.append("\(path)?\(since ?? "")") }
      switch path {
      case "/api/chat-threads/snapshot":
        let sequence = current == 1 ? 10 : 20
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/list-snapshot","latestEventId":"\(eventIdentity(sequence))","latestSeqId":\(sequence)}
            """)
      case "/list-snapshot":
        let title = current == 1 ? "Old title" : "Rebased title"
        let thread = threadJSON(id: fixtureThread)
          .replacingOccurrences(of: "Original title", with: title)
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(thread)]}")
      case "/api/chat-threads/events":
        if current == 2 && since == "10" {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        if current == 2 && since == "20" {
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 21, kind: "renamed", thread: fixtureThread, title: "Current title"))],\"hasMore\":false}"
          )
        }
        return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        let sequence = current == 1 ? 1 : 3
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/history-snapshot","lastEventId":"\(eventIdentity(sequence))","lastSeqId":\(sequence)}
            """)
      case "/history-snapshot":
        return Self.historySnapshot(generation: current)
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        if current == 2 && since == "1" {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        if current == 2 && since == "3" {
          return ChatHTTPResponse(
            body: """
              {"rows":[\(eventJSON(seq: 4, type: "run.completed"))],"cursor":{"lastEventId":"\(eventIdentity(4))","lastSeqId":4},"hasMore":false}
              """)
        }
        let cursor = current == 1 ? 1 : 4
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(cursor))\",\"lastSeqId\":\(cursor)},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "rebase-user", workspaceID: "rebase-workspace")
    let first = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let firstThreads = try await first.threads()
    let firstHistory = try await first.history(threadID: fixtureThread)
    XCTAssertEqual(firstThreads.first?.title, "Old title")
    XCTAssertEqual(firstHistory.messages.map(\.text), ["Old question"])

    generation.withLock { $0 = 2 }
    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let oldThreads = await restarted.cachedThreads()
    let oldHistory = await restarted.cachedHistory(threadID: fixtureThread)
    XCTAssertEqual(oldThreads?.first?.title, "Old title")
    XCTAssertEqual(oldHistory?.messages.map(\.text), ["Old question"])
    let rebuiltThreads = try await restarted.threads()
    let rebuiltHistory = try await restarted.history(threadID: fixtureThread)
    XCTAssertEqual(rebuiltThreads.first?.title, "Current title")
    XCTAssertEqual(rebuiltHistory.messages.map(\.text), ["New question", "New answer"])
    let rebuiltCachedThreads = await restarted.cachedThreads()
    let rebuiltCachedHistory = await restarted.cachedHistory(threadID: fixtureThread)
    XCTAssertEqual(rebuiltCachedThreads?.first?.title, "Current title")
    XCTAssertEqual(rebuiltCachedHistory?.messages.map(\.text), ["New question", "New answer"])
    let paths = requests.withLock { $0 }
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/snapshot?" }.count, 2)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot?" }.count, 2)
    XCTAssertEqual(
      paths.filter { $0 == "/api/chat-threads/\(fixtureThread)/event-snapshot?" }.count, 2)
    XCTAssertTrue(paths.contains("/api/chat-threads/events?10"))
    XCTAssertTrue(paths.contains("/api/chat-threads/events?20"))
    XCTAssertTrue(paths.contains("/api/chat-threads/\(fixtureThread)/event-rows?1"))
    XCTAssertTrue(paths.contains("/api/chat-threads/\(fixtureThread)/event-rows?3"))
  }

  func testExpiredSecondListPageRebasesWithoutSavingAbandonedTail() async throws {
    let directory = try temporaryChatCacheDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let requests = Mutex<[String]>([])
    let snapshotReads = Mutex(0)
    let fixture = ChatHTTPFixture { request in
      let path = request.url?.path ?? ""
      let since = chatQueryValue("sinceSeqId", in: request)
      requests.withLock { $0.append("\(path)?\(since ?? "")") }
      switch path {
      case "/api/chat-threads/snapshot":
        let count = snapshotReads.withLock {
          $0 += 1
          return $0
        }
        guard count <= 2 else { throw URLError(.badServerResponse) }
        let sequence = count == 1 ? 10 : 20
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/list-snapshot-\(count)","latestEventId":"\(eventIdentity(sequence))","latestSeqId":\(sequence)}
            """)
      case "/list-snapshot-1":
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(threadJSON(id: fixtureThread))]}")
      case "/list-snapshot-2":
        let thread = threadJSON(id: fixtureThread)
          .replacingOccurrences(of: "Original title", with: "Rebased title")
        return ChatHTTPResponse(body: "{\"chatThreads\":[\(thread)]}")
      case "/api/chat-threads/events":
        switch since {
        case "10":
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 11, kind: "renamed", thread: fixtureThread, title: "Abandoned title"))],\"hasMore\":true}"
          )
        case "11":
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        case "20":
          return ChatHTTPResponse(
            body:
              "{\"events\":[\(threadEventJSON(seq: 21, kind: "renamed", thread: fixtureThread, title: "Final title"))],\"hasMore\":false}"
          )
        case "21":
          return ChatHTTPResponse(body: "{\"events\":[],\"hasMore\":false}")
        default: throw URLError(.badServerResponse)
        }
      case "/api/indicators":
        return ChatHTTPResponse(body: "{\"unreadAt\":{},\"threads\":{}}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "paged-rebase-user",
      workspaceID: "paged-rebase-workspace")
    let first = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let resolved = try await first.threads()
    XCTAssertEqual(resolved.map(\.title), ["Final title"])
    let cached = await first.cachedThreads()
    XCTAssertEqual(cached?.map(\.title), ["Final title"])

    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restored = await restarted.cachedThreads()
    XCTAssertEqual(restored?.map(\.title), ["Final title"])
    let caughtUp = try await restarted.threads()
    XCTAssertEqual(caughtUp.map(\.title), ["Final title"])
    XCTAssertEqual(snapshotReads.withLock { $0 }, 2)
    let paths = requests.withLock { $0 }
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?10" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?11" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?20" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/api/chat-threads/events?21" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot-1?" }.count, 1)
    XCTAssertEqual(paths.filter { $0 == "/list-snapshot-2?" }.count, 1)
  }

  func testHistoryRecoversExpiredCursorAndNeverSendsBearerToSnapshot() async throws {
    struct State: Sendable {
      var snapshotCount = 0
      var tailCount = 0
      var snapshotAuthorization: String?
    }
    let state = Mutex(State())
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/\(fixtureThread)/event-snapshot":
        let count = state.withLock {
          $0.snapshotCount += 1
          return $0.snapshotCount
        }
        let sequence = count == 1 ? 2 : 4
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/snapshot","expiresInSeconds":60,"lastEventId":"\(eventIdentity(sequence))","lastSeqId":\(sequence)}
            """)
      case "/snapshot":
        let count = state.withLock {
          $0.snapshotAuthorization = request.value(forHTTPHeaderField: "Authorization")
          return $0.snapshotCount
        }
        let rows =
          count == 1
          ? [
            eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Hello")),
            eventJSON(seq: 2, type: "output.message", payload: "{\"content\":\"First answer\"}")
          ]
          : [
            eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Hello")),
            eventJSON(seq: 2, type: "output.message", payload: "{\"content\":\"First answer\"}"),
            eventJSON(seq: 4, type: "run.completed")
          ]
        return ChatHTTPResponse(body: rows.joined(separator: "\n") + "\n")
      case "/api/chat-threads/\(fixtureThread)/event-rows":
        let count = state.withLock {
          $0.tailCount += 1
          return $0.tailCount
        }
        if count == 3 {
          return ChatHTTPResponse(status: 410, body: "{\"error\":{\"message\":\"Expired\"}}")
        }
        let sequence = count <= 3 ? 2 : 4
        return ChatHTTPResponse(
          body:
            "{\"rows\":[],\"cursor\":{\"lastEventId\":\"\(eventIdentity(sequence))\",\"lastSeqId\":\(sequence)},\"hasMore\":false}"
        )
      case "/api/chat-threads/\(fixtureThread)":
        return ChatHTTPResponse(body: "{\"lastReadAt\":null,\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let service = ChatSync(client: fixture.client)
    let first = try await service.history(threadID: fixtureThread)
    XCTAssertEqual(first.messages.map(\.text), ["Hello", "First answer"])
    XCTAssertEqual(first.executionState, .running)
    let second = try await service.history(threadID: fixtureThread)
    XCTAssertEqual(second.messages.map(\.text), ["Hello", "First answer"])
    XCTAssertEqual(second.executionState, .completed)
    XCTAssertEqual(state.withLock { $0.snapshotCount }, 2)
    XCTAssertNil(state.withLock { $0.snapshotAuthorization })
  }

}

@MainActor
extension XCTestCase {

  nonisolated fileprivate static func historySnapshot(generation current: Int) -> ChatHTTPResponse {
    if current == 1 {
      return ChatHTTPResponse(
        body: eventJSON(seq: 1, type: "input.prompt", payload: userPayload("Old question"))
          + "\n")
    }
    return ChatHTTPResponse(
      body: [
        eventJSON(seq: 1, type: "input.prompt", payload: userPayload("New question")),
        eventJSON(seq: 3, type: "output.message", payload: "{\"content\":\"New answer\"}")
      ].joined(separator: "\n") + "\n")
  }
}
