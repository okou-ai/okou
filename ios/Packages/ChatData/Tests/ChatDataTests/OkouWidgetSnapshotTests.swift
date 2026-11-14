import ChatDataTestSupport
import Foundation
import Synchronization
import XCTest

@testable import ChatData

final class OkouWidgetSnapshotTests: XCTestCase {
  private let base = Date(timeIntervalSince1970: 1_800_000_000)
  private let known = "70000000-0000-4000-8000-000000000001"
  private let running = "70000000-0000-4000-8000-000000000002"
  private let drafted = "70000000-0000-4000-8000-000000000003"
  private let started = "70000000-0000-4000-8000-000000000004"
  private let archived = "70000000-0000-4000-8000-000000000005"
  private let deleted = "70000000-0000-4000-8000-000000000006"

  private func chat(
    _ id: String, _ title: String, _ state: OkouWidgetSnapshot.Chat.State,
    minutesAgo: Double, pinned: Bool = false
  ) -> OkouWidgetSnapshot.Chat {
    OkouWidgetSnapshot.Chat(
      id: id, title: title, emoji: nil, state: state, isPinned: pinned,
      activityAt: base.addingTimeInterval(-minutesAgo * 60))
  }

  private func snapshot(_ chats: [OkouWidgetSnapshot.Chat]) -> OkouWidgetSnapshot {
    OkouWidgetSnapshot(
      userID: "user", workspaceID: "workspace",
      greetings: .init(morning: "m", day: "d", evening: "e", night: "n"), chats: chats)
  }

  private func temporaryStore() -> OkouWidgetSnapshotStore {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("widget-snapshot-" + UUID().uuidString)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
    return OkouWidgetSnapshotStore(url: directory.appendingPathComponent("snapshot.json"))
  }

  func testAFinishedAlertMarksOnlyAListedChatAndMovesItAhead() throws {
    let current = snapshot([
      chat(running, "Running", .working, minutesAgo: 1),
      chat(known, "Known", .idle, minutesAgo: 30),
    ])
    let marked = try XCTUnwrap(current.markingFinished(threadID: known, at: base))
    XCTAssertEqual(marked.chats.map(\.id), [known, running])
    XCTAssertEqual(marked.chats.first?.state, .finished)
    XCTAssertEqual(marked.chats.first?.activityAt, base)
    // Already finished, or not listed: the widget's own refresh owns those.
    XCTAssertNil(marked.markingFinished(threadID: known, at: base))
    XCTAssertNil(current.markingFinished(threadID: started, at: base))
    XCTAssertTrue(current.belongs(toUser: "user", workspace: "workspace"))
    XCTAssertFalse(current.belongs(toUser: "user", workspace: "elsewhere"))
  }

  func testWidgetFeedAppliesServerStatesAndAddsVisibleUnlistedChats() async throws {
    let metadataReads = Mutex<[String]>([])
    let fixture = ChatHTTPFixture { [started, archived, deleted, known] request in
      let path = request.url?.path ?? ""
      if path == "/api/indicators" {
        return ChatHTTPResponse(
          body: """
            {"agents":{},"threads":{"\(known)":"unread","\(started)":"active",\
            "\(archived)":"unread","\(deleted)":"active"},\
            "unreadAt":{"\(known)":"2027-01-15T08:00:00.000Z","\(archived)":"2027-01-15T07:00:00.000Z"}}
            """)
      }
      metadataReads.withLock { $0.append(path) }
      switch path {
      case "/api/chat-threads/\(started)/metadata":
        return ChatHTTPResponse(
          body: #"{"title":"⏳ Started on the web","pinnedAt":null,"archived":false,"muted":false}"#)
      case "/api/chat-threads/\(archived)/metadata":
        return ChatHTTPResponse(
          body: #"{"title":"Archived","pinnedAt":null,"archived":true,"muted":false}"#)
      case "/api/chat-threads/\(deleted)/metadata":
        return ChatHTTPResponse(status: 404, body: #"{"error":{"message":"Not found"}}"#)
      default:
        throw URLError(.unsupportedURL)
      }
    }
    let current = snapshot([
      chat(running, "Running", .working, minutesAgo: 1),
      chat(known, "Known", .idle, minutesAgo: 30, pinned: true),
      chat(drafted, "Drafted", .draft, minutesAgo: 40),
    ])
    let now = base.addingTimeInterval(60)
    let feed = try await OkouWidgetFeed.read(for: current, client: fixture.client, now: now)
    let refreshed = feed.apply(to: current, now: now)

    XCTAssertEqual(
      metadataReads.withLock { Set($0) },
      Set([started, archived, deleted].map { "/api/chat-threads/\($0)/metadata" }),
      "Only unlisted chats are looked up")
    XCTAssertEqual(refreshed.chats.map(\.id), [known, started, running, drafted])
    XCTAssertEqual(
      refreshed.chats.map(\.state), [.finished, .working, .idle, .draft],
      "A chat no longer running rests idle; a draft stays a draft")
    let added = try XCTUnwrap(refreshed.chats.first { $0.id == started })
    XCTAssertEqual(added.title, "Started on the web")
    XCTAssertEqual(added.emoji, "⏳")
    XCTAssertEqual(added.activityAt, now)
    XCTAssertEqual(
      refreshed.chats.first?.activityAt,
      ISO8601DateFormatter().date(from: "2027-01-15T08:00:00Z"))
    XCTAssertEqual(refreshed.userID, "user")
    XCTAssertEqual(refreshed.greetings, current.greetings)
  }

  func testStoreChangesApplyToTheLatestFileAndSigningOutClearsIt() throws {
    let store = temporaryStore()
    XCTAssertNil(try store.read())
    XCTAssertNil(try store.update { $0 }, "No snapshot, nothing to change")
    let first = snapshot([chat(known, "Known", .idle, minutesAgo: 5)])
    try store.write(first)
    // Another process rewrote the file after this one read it.
    let newer = snapshot([
      chat(running, "Running", .working, minutesAgo: 1),
      chat(known, "Known", .idle, minutesAgo: 5),
    ])
    try store.write(newer)
    let marked = try store.update { $0.markingFinished(threadID: known, at: self.base) }
    XCTAssertEqual(marked?.chats.map(\.id), [known, running])
    XCTAssertEqual(try store.read(), marked)
    XCTAssertNil(try store.update { _ in nil })
    XCTAssertNotNil(store.modifiedAt())
    try store.clear()
    XCTAssertNil(try store.read())
  }

  func testASnapshotFromAnOlderAppStillDecodesWithoutAnAccount() throws {
    let data = Data(
      #"{"workspaceID":"workspace","greetings":{"morning":"m","day":"d","evening":"e","night":"n"},"chats":[]}"#
        .utf8)
    let decoded = try JSONDecoder().decode(OkouWidgetSnapshot.self, from: data)
    XCTAssertNil(decoded.userID)
    XCTAssertFalse(decoded.belongs(toUser: "user", workspace: "workspace"))
  }

  func testOrderingKeepsTwelveChatsWithNeedsFinishedWorkingPinnedThenRecent() {
    var chats = (1...14).map {
      chat(
        String(format: "70000000-0000-4000-8000-%012d", 100 + $0), "Chat \($0)", .idle,
        minutesAgo: Double($0))
    }
    chats.append(chat(known, "Pinned", .idle, minutesAgo: 90, pinned: true))
    chats.append(chat(running, "Working", .working, minutesAgo: 80))
    chats.append(chat(started, "Finished", .finished, minutesAgo: 70))
    let ordered = OkouWidgetSnapshot.ordered(chats)
    XCTAssertEqual(ordered.count, OkouWidgetSnapshot.chatLimit)
    XCTAssertEqual(
      Array(ordered.map(\.title).prefix(5)), ["Finished", "Working", "Pinned", "Chat 1", "Chat 2"])
  }
}
