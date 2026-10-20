import ChatDataTestSupport
import ChatDomain
import Foundation
import Synchronization
import XCTest

@testable import ChatData

@MainActor
final class ChatFollowupSyncTests: XCTestCase {
  func testSnapshotLateTailCacheRestartAndNewReplyAgree() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let tail = Mutex<[String]>([])
    let initial = [
      try row(1, type: "output.message", content: "Answer"), try row(2, type: "run.completed"),
    ]
    let fixture = ChatHTTPFixture { request in
      switch request.url?.path {
      case "/api/chat-threads/thread/event-snapshot":
        return ChatHTTPResponse(
          body: """
            {"url":"https://\(request.url!.host!)/snapshot","expiresInSeconds":60,"lastEventId":"\(Self.id(2))","lastSeqId":2}
            """)
      case "/snapshot": return ChatHTTPResponse(body: initial.joined(separator: "\n") + "\n")
      case "/api/chat-threads/thread/event-rows":
        let after =
          URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first {
            $0.name == "sinceSeqId"
          }?.value.flatMap(Int.init) ?? 0
        return tail.withLock { tail in
          let all = initial + tail
          let rows = all.dropFirst(after)
          return ChatHTTPResponse(
            body: """
              {"rows":[\(rows.joined(separator: ","))],"cursor":{"lastEventId":"\(Self.id(all.count))","lastSeqId":\(all.count)},"hasMore":false}
              """)
        }
      case "/api/chat-threads/thread":
        return ChatHTTPResponse(body: "{\"cancellationRecoveryPending\":false}")
      default: throw URLError(.unsupportedURL)
      }
    }
    let scope = ChatCacheScope(
      apiBaseURL: fixture.baseURL, userID: "user", workspaceID: "workspace")
    let sync = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let first = try await sync.history(threadID: "thread")
    XCTAssertNil(first.recommendedFollowups)
    let content =
      "{\"version\":1,\"followups\":[{\"prompt\":\"Make slides\",\"kind\":\"generate\",\"generationType\":\"presentation\"}]}"
    tail.withLock { $0.append(try! row(3, type: "output.followups", content: content)) }
    let late = try await sync.history(threadID: "thread")
    XCTAssertEqual(late.recommendedFollowups?.followups.map(\.prompt), ["Make slides"])
    XCTAssertEqual(late.messages, first.messages)
    let unchanged = try await sync.history(threadID: "thread")
    XCTAssertEqual(unchanged, late)

    let restarted = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let cached = await restarted.cachedHistory(threadID: "thread")
    XCTAssertEqual(cached, late)
    let reopened = try await restarted.history(threadID: "thread")
    XCTAssertEqual(reopened, late)
    tail.withLock {
      $0 += [
        try! row(4, type: "output.message", content: "New answer", run: "next"),
        try! row(5, type: "run.completed", run: "next"),
      ]
    }
    let newer = try await restarted.history(threadID: "thread")
    XCTAssertNil(newer.recommendedFollowups)
    let refreshed = ChatSync(
      client: fixture.client, cache: ChatCache(scope: scope, directory: directory))
    let restoredNewer = await refreshed.cachedHistory(threadID: "thread")
    XCTAssertEqual(restoredNewer, newer)
  }

  nonisolated private static func id(_ seq: Int) -> String { "followup-\(seq)" }
}

private func row(_ seq: Int, type: String, content: String? = nil, run: String = "run") throws
  -> String
{
  let payload = content.map { ["content": $0] } ?? [:]
  let data = try JSONSerialization.data(withJSONObject: [
    "id": "followup-\(seq)", "chatThreadId": "thread", "seqId": seq, "runId": run,
    "createdAt": "2026-10-20T00:00:00Z", "eventType": type, "payload": payload,
  ])
  return String(decoding: data, as: UTF8.self)
}
