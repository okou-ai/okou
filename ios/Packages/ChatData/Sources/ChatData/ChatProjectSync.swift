import ChatDomain
import Foundation
import OSLog

extension ChatSync {
  /// Match Web's Project snapshot/tail protocol without changing invalidation topics.
  public func projectList() async throws -> [ChatProject] {
    let cached = await cachedProjectSnapshot()
    try Task.checkCancellation()
    var snapshot: ProjectSnapshot
    if let cached {
      snapshot = cached
    } else {
      snapshot = try await fetchProjectSnapshot()
    }
    var fromServerSnapshot = cached == nil
    var seen = Set<String>()
    while true {
      let page: ProjectEventsPage
      do {
        page = try await client.request(
          "/api/projects/events",
          query: [URLQueryItem(name: "sinceSeqId", value: String(snapshot.latestSeqId))])
        try Task.checkCancellation()
      } catch let error as APIClientError where error.statusCode == 410 {
        guard !fromServerSnapshot else {
          throw ChatError.invalidContract("Project cursor expired immediately after its snapshot.")
        }
        snapshot = try await fetchProjectSnapshot()
        fromServerSnapshot = true
        seen.removeAll()
        continue
      }
      try snapshot.apply(page.events, seen: &seen)
      if !page.events.isEmpty { fromServerSnapshot = false }
      if !page.hasMore { break }
      guard !page.events.isEmpty else {
        throw ChatError.invalidContract("The Project cursor did not advance.")
      }
    }
    try Task.checkCancellation()
    if let cache {
      do {
        // Publish the complete tail atomically. Local mutation confirmations have
        // no server cursor and stay in the separate presentation cache.
        snapshot = try await cache.commitProjectSnapshot(snapshot, replacing: cached?.cursor)
        try Task.checkCancellation()
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        Logger(subsystem: "ai.okou.ios", category: "ChatCache")
          .error(
            "Cannot save Project event baseline: \(error.localizedDescription, privacy: .public)")
      }
    }
    return snapshot.projects
  }

  private func cachedProjectSnapshot() async -> ProjectSnapshot? {
    do { return try await cache?.loadProjectSnapshot() } catch {
      Logger(subsystem: "ai.okou.ios", category: "ChatCache")
        .error(
          "Cannot read Project event baseline: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }

  private func fetchProjectSnapshot() async throws -> ProjectSnapshot {
    let response: ProjectSnapshotResponse = try await client.request("/api/projects/snapshot")
    try Task.checkCancellation()
    let snapshot: ProjectSnapshot
    switch response {
    case .inline(let value):
      snapshot = value
    case .remote(let url, let cursor):
      let data = try await client.downloadSnapshot(url)
      try Task.checkCancellation()
      snapshot = try APIClient.decoder().decode(ProjectSnapshot.self, from: data)
      guard snapshot.cursor == cursor else {
        throw ChatError.invalidContract("The Project snapshot does not match its cursor.")
      }
    }
    try snapshot.validate()
    return snapshot
  }
}
