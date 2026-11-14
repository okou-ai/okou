import ChatDomain
import Foundation
import OSLog

/// What a widget refresh reads from the API: every active and unread chat in the workspace, and
/// the title of each such chat the snapshot does not list yet. It never reads chat history.
public struct OkouWidgetFeed: Equatable, Sendable {
  /// At most this many unlisted chats are looked up per refresh; the rest wait for the App.
  static let addedLimit = 6

  public let indicators: [String: ChatIndicator]
  public let unreadAt: [String: Date]
  public let added: [OkouWidgetSnapshot.Chat]

  public static func read(
    for snapshot: OkouWidgetSnapshot, client: APIClient, now: Date = .now
  ) async throws -> OkouWidgetFeed {
    let indicators: Indicators = try await client.request("/api/indicators")
    let listed = Set(snapshot.chats.map(\.id))
    // Unread results first, newest first, then running chats.
    let unlisted = indicators.threads.keys.filter { !listed.contains($0) }
      .sorted { lhs, rhs in
        let left = (indicators.threads[lhs] == .unread, indicators.unreadAt[lhs] ?? .distantPast)
        let right = (indicators.threads[rhs] == .unread, indicators.unreadAt[rhs] ?? .distantPast)
        if left.0 != right.0 { return left.0 }
        return left.1 != right.1 ? left.1 > right.1 : lhs < rhs
      }
    var added: [OkouWidgetSnapshot.Chat] = []
    for id in unlisted.prefix(addedLimit) {
      try Task.checkCancellation()
      guard let metadata = try await metadata(id, client: client),
        !metadata.archived, metadata.hidden != true
      else { continue }
      let title = metadata.title.flatMap { $0.isEmpty ? nil : $0 } ?? "New chat"
      let parts = ChatTitleParts(title)
      added.append(
        OkouWidgetSnapshot.Chat(
          id: id, title: parts.text, emoji: parts.emoji, state: .idle,
          isPinned: metadata.pinnedAt != nil, activityAt: indicators.unreadAt[id] ?? now))
    }
    return OkouWidgetFeed(
      indicators: indicators.threads, unreadAt: indicators.unreadAt, added: added)
  }

  public func apply(to snapshot: OkouWidgetSnapshot, now: Date = .now) -> OkouWidgetSnapshot {
    snapshot.refreshed(indicators: indicators, unreadAt: unreadAt, added: added, now: now)
  }

  private struct Metadata: Decodable, Sendable {
    let title: String?
    let pinnedAt: Date?
    let archived: Bool
    let hidden: Bool?
  }

  /// A chat deleted or moved since the indicators were read is skipped; so is one whose lookup
  /// fails, leaving the other chats' states to apply.
  private static func metadata(_ id: String, client: APIClient) async throws -> Metadata? {
    guard UUID(uuidString: id) != nil else { return nil }
    do {
      return try await client.request("/api/chat-threads/\(id)/metadata")
    } catch let error as APIClientError where error.statusCode == 401 || error.statusCode == 426 {
      throw error
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      Logger(subsystem: "ai.okou.ios", category: "widgets")
        .info("Skipping an unlisted widget chat: \(error.localizedDescription, privacy: .public)")
      return nil
    }
  }
}
