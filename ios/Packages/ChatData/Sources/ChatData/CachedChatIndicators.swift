import ChatDomain
import Foundation

/// A server-confirmed, bounded unread presentation snapshot, not a read cursor.
/// Running indicators deliberately stay in memory and are revalidated online.
public struct CachedChatIndicators: Codable, Sendable {
  public internal(set) var revision: Int
  public internal(set) var savedAt: Date
  public internal(set) var unreadAt: [String: Date]

  public var indicators: Indicators {
    Indicators(
      threads: unreadAt.mapValues { _ in .unread }, unreadAt: unreadAt)
  }

  mutating func markRead(threadID: String, through watermark: Date) {
    guard let timestamp = unreadAt[threadID], timestamp <= watermark else { return }
    unreadAt[threadID] = nil
  }
}

struct ChatIndicatorsRead: Sendable {
  let requestID: Int
  let mutationRevision: Int
}

enum ChatReadStateChange: Sendable {
  case read(threadID: String, through: Date?)
  case unread(threadID: String)
  case allRead(baseline: CachedChatIndicators?)
  case invalidated
}

/// The same state machine arbitrates both in-memory reads and shared SQLite
/// writes. Its counters order local operations, not remote database versions.
struct ChatIndicatorCacheState: Codable {
  var nextRequestID = 0
  var appliedRequestID = 0
  var mutationRevision = 0
  var snapshot: CachedChatIndicators?

  mutating func beginRead() -> ChatIndicatorsRead {
    nextRequestID += 1
    return ChatIndicatorsRead(requestID: nextRequestID, mutationRevision: mutationRevision)
  }

  mutating func save(
    _ indicators: Indicators, threads: [ChatThread], request: ChatIndicatorsRead
  ) -> Bool {
    guard accepts(request) else { return false }
    appliedRequestID = request.requestID
    snapshot = CachedChatIndicators(
      revision: (snapshot?.revision ?? 0) + 1, savedAt: Date(),
      unreadAt: indicators.unreadAt.filter { indicators.threads[$0.key] == .unread })
    return true
  }

  func accepts(_ request: ChatIndicatorsRead) -> Bool {
    request.mutationRevision == mutationRevision && request.requestID > appliedRequestID
  }

  mutating func change(_ change: ChatReadStateChange, threads: [ChatThread] = []) {
    mutationRevision += 1
    guard var snapshot else { return }
    snapshot.revision += 1
    switch change {
    case .read(let threadID, let watermark):
      if let watermark { snapshot.markRead(threadID: threadID, through: watermark) }
    case .unread:
      // Clearing the server cursor alone does not establish a terminal marker.
      // Retain other chats and let the following indicators read confirm this one.
      break
    case .allRead(let baseline):
      if let baseline {
        for thread in threads where !thread.isMuted {
          if let timestamp = baseline.unreadAt[thread.id] {
            snapshot.markRead(threadID: thread.id, through: timestamp)
          }
        }
      }
    case .invalidated: break
    }
    self.snapshot = snapshot
  }
}
