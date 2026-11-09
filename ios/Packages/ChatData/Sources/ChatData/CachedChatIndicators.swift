import ChatDomain
import Foundation

/// A server-confirmed, bounded unread presentation snapshot, not a read cursor.
/// Running indicators deliberately stay in memory and are revalidated online.
public struct CachedChatIndicators: Codable, Sendable {
  public internal(set) var revision: Int
  public internal(set) var savedAt: Date
  public internal(set) var unreadAt: [String: Date]
  public internal(set) var unreadAgentIDs: Set<String>
  var threadAgentIDs: [String: String]

  public var indicators: Indicators {
    Indicators(
      agents: Dictionary(uniqueKeysWithValues: unreadAgentIDs.map { ($0, .unread) }),
      threads: unreadAt.mapValues { _ in .unread }, unreadAt: unreadAt)
  }

  mutating func markRead(threadID: String, through watermark: Date) {
    guard let timestamp = unreadAt[threadID], timestamp <= watermark else { return }
    unreadAt[threadID] = nil
    // An unknown thread can account for another unread under this Agent. Never
    // clear the Agent merely because its remaining chats are not cached locally.
    if let agentID = threadAgentIDs[threadID],
      unreadAt.keys.allSatisfy({ threadAgentIDs[$0] != nil }),
      !unreadAt.keys.contains(where: { threadAgentIDs[$0] == agentID })
    {
      unreadAgentIDs.remove(agentID)
    }
  }
}

struct ChatIndicatorsRead: Sendable {
  let requestID: Int
  let mutationRevision: Int
}

enum ChatReadStateChange: Sendable {
  case read(threadID: String, through: Date?)
  case unread(threadID: String)
  case agentRead(agentID: String, baseline: CachedChatIndicators?)
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
      unreadAt: indicators.unreadAt.filter { indicators.threads[$0.key] == .unread },
      unreadAgentIDs: Set(indicators.agents.filter { $0.value == .unread }.map(\.key)),
      threadAgentIDs: Dictionary(
        uniqueKeysWithValues: threads.filter { indicators.unreadAt[$0.id] != nil }
          .map { ($0.id, $0.agentID) }))
    return true
  }

  func accepts(_ request: ChatIndicatorsRead) -> Bool {
    request.mutationRevision == mutationRevision && request.requestID > appliedRequestID
  }

  mutating func change(_ change: ChatReadStateChange, threads: [ChatThread] = []) {
    mutationRevision += 1
    guard var snapshot else { return }
    for thread in threads where snapshot.unreadAt[thread.id] != nil {
      snapshot.threadAgentIDs[thread.id] = thread.agentID
    }
    snapshot.revision += 1
    switch change {
    case .read(let threadID, let watermark):
      if let watermark { snapshot.markRead(threadID: threadID, through: watermark) }
    case .unread:
      // Clearing the server cursor alone does not establish a terminal marker.
      // Retain other chats and let the following indicators read confirm this one.
      break
    case .agentRead(let agentID, let baseline):
      if let baseline {
        for (threadID, timestamp) in baseline.unreadAt
        where snapshot.threadAgentIDs[threadID] == agentID {
          snapshot.markRead(threadID: threadID, through: timestamp)
        }
        if !snapshot.unreadAt.keys.contains(where: { snapshot.threadAgentIDs[$0] == agentID }),
          snapshot.unreadAt.keys.allSatisfy({ snapshot.threadAgentIDs[$0] != nil })
        {
          snapshot.unreadAgentIDs.remove(agentID)
        }
      }
    case .invalidated: break
    }
    self.snapshot = snapshot
  }
}
