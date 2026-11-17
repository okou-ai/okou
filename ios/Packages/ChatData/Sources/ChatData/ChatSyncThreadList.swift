import ChatDomain
import Foundation
import OSLog

extension ChatSync {
  struct ThreadListState {
    var snapshot: [ThreadProjection]
    var snapshotData: Data
    var snapshotCursor: ChatCacheCursor
    var events: [ThreadEvent]
    var newEvents: [ChatCacheEvent]
    var cursor: ChatCacheCursor
    var replaced: Bool
    var cursorFromServerSnapshot: Bool
  }

  private struct CachedThreadSnapshot: Decodable {
    enum Format: String, Decodable { case projectEvents }
    let cacheFormat: Format
    let chatThreads: [ThreadProjection]
  }

  func readCachedThreadList(newerThan sequence: Int? = nil) async -> ThreadListState? {
    guard let cache else { return nil }
    do {
      guard let stored = try await cache.loadThreadList() else { return nil }
      let cursor =
        stored.events.last.map { ChatCacheCursor(eventID: $0.id, seqID: $0.seqID) }
        ?? stored.snapshotCursor
      // Consult shared storage on every read so NSE commits remain visible, but
      // avoid decoding and replaying a list the caller has already applied.
      if let sequence, cursor.seqID <= sequence { return nil }
      let decoder = APIClient.decoder()
      let snapshot = try decoder.decode(
        CachedThreadSnapshot.self, from: stored.snapshot
      ).chatThreads
      let events = try stored.events.map { row in
        let event = try decoder.decode(ThreadEvent.self, from: row.data)
        guard event.id == row.id, event.seqId == row.seqID else {
          throw ChatError.invalidContract("Cached chat list event identity is invalid.")
        }
        return event
      }
      var previous = stored.snapshotCursor.seqID
      for event in events {
        guard event.seqId > previous else {
          throw ChatError.invalidContract("Cached chat list event order is invalid.")
        }
        previous = event.seqId
      }
      return ThreadListState(
        snapshot: snapshot, snapshotData: stored.snapshot,
        snapshotCursor: stored.snapshotCursor, events: events, newEvents: [],
        cursor: cursor,
        replaced: false, cursorFromServerSnapshot: false)
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.list.read.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      return nil
    }
  }

  func fetchThreadSnapshot() async throws -> ThreadListState {
    let response = try await client.data("/api/chat-threads/snapshot")
    let snapshot = try Self.decode(ThreadSnapshot.self, from: response.data)
    let archiveData: Data
    let latestEventID: String?
    let latestSeqID: Int?
    switch snapshot {
    case .inline(_, let eventID, let seqID):
      // The inline response is an empty scope on current APIs. Keep the exact
      // projection JSON for a rollback-window response as well.
      guard let object = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
        let threads = object["chatThreads"]
      else { throw APIClientError.incompatibleData }
      archiveData = try JSONSerialization.data(withJSONObject: ["chatThreads": threads])
      latestEventID = eventID
      latestSeqID = seqID
    case .remote(let url, let eventID, let seqID):
      archiveData = try await client.downloadSnapshot(url)
      latestEventID = eventID
      latestSeqID = seqID
    }
    let projections = try Self.decode(ThreadSnapshotArchive.self, from: archiveData).chatThreads
    guard var cachedSnapshot = try JSONSerialization.jsonObject(with: archiveData) as? [String: Any]
    else { throw APIClientError.incompatibleData }
    cachedSnapshot["cacheFormat"] = CachedThreadSnapshot.Format.projectEvents.rawValue
    let cachedData = try JSONSerialization.data(withJSONObject: cachedSnapshot)
    let cursor = ChatCacheCursor(eventID: latestEventID, seqID: latestSeqID ?? 0)
    return ThreadListState(
      snapshot: projections, snapshotData: cachedData, snapshotCursor: cursor,
      events: [], newEvents: [], cursor: cursor, replaced: true,
      cursorFromServerSnapshot: true)
  }

  func catchUpThreadEvents(_ initial: ThreadListState) async throws -> ThreadListState {
    var state = initial
    while true {
      do {
        try await loadThreadEventTail(into: &state)
        return state
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !state.cursorFromServerSnapshot else {
          throw ChatError.invalidContract(
            "Chat list cursor expired immediately after its snapshot.")
        }
        state = try await fetchThreadSnapshot()
      }
    }
  }

  private func loadThreadEventTail(into state: inout ThreadListState) async throws {
    while true {
      let query =
        state.cursor.seqID > 0
        ? [URLQueryItem(name: "sinceSeqId", value: String(state.cursor.seqID))] : []
      let response = try await client.data("/api/chat-threads/events", query: query)
      let page = try Self.decode(ThreadEventsPage.self, from: response.data)
      let rawEvents = try Self.rawArray("events", in: response.data)
      guard page.events.count == rawEvents.count else { throw APIClientError.incompatibleData }
      for (event, data) in zip(page.events, rawEvents) {
        guard event.seqId > state.cursor.seqID,
          !state.events.contains(where: { $0.id == event.id })
        else { throw ChatError.invalidContract("Chat list events are not ordered.") }
        state.events.append(event)
        state.newEvents.append(ChatCacheEvent(id: event.id, seqID: event.seqId, data: data))
        state.cursor = ChatCacheCursor(eventID: event.id, seqID: event.seqId)
      }
      if !page.events.isEmpty { state.cursorFromServerSnapshot = false }
      if !page.hasMore { return }
      if page.events.isEmpty {
        throw ChatError.invalidContract("Chat list cursor did not advance.")
      }
    }
  }

  func persistThreadList(_ state: ThreadListState) async -> Bool {
    guard let cache else { return false }
    guard state.replaced || !state.newEvents.isEmpty else { return true }
    do {
      if state.replaced {
        try await cache.replaceThreadList(
          snapshot: state.snapshotData, cursor: state.snapshotCursor, events: state.newEvents)
      } else {
        try await cache.appendThreadEvents(state.newEvents)
      }
      return true
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "event=chat.cache.list.save.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
        )
      return false
    }
  }

}
