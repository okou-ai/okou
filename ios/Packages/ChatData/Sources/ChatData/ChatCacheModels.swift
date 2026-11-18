import Foundation

public struct ChatCacheScope: Sendable {
  public let apiBaseURL: URL
  public let userID: String
  public let workspaceID: String

  public init(
    apiBaseURL: URL,
    userID: String,
    workspaceID: String
  ) {
    self.apiBaseURL = apiBaseURL
    self.userID = userID
    self.workspaceID = workspaceID
  }
}

public struct ChatCacheCursor: Equatable, Sendable {
  public let eventID: String?
  public let seqID: Int

  public init(
    eventID: String?,
    seqID: Int
  ) {
    self.eventID = eventID
    self.seqID = seqID
  }
}

public struct ChatCacheEvent: Equatable, Sendable {
  public let id: String
  public let seqID: Int
  public let data: Data

  public init(
    id: String,
    seqID: Int,
    data: Data
  ) {
    self.id = id
    self.seqID = seqID
    self.data = data
  }
}

public struct CachedThreadList: Sendable {
  public let snapshot: Data
  public let snapshotCursor: ChatCacheCursor
  public let events: [ChatCacheEvent]

  public init(
    snapshot: Data,
    snapshotCursor: ChatCacheCursor,
    events: [ChatCacheEvent]
  ) {
    self.snapshot = snapshot
    self.snapshotCursor = snapshotCursor
    self.events = events
  }
}

public struct CachedChatHistory: Sendable {
  public let rows: [ChatCacheEvent]
  public let cursor: ChatCacheCursor
  public let schemaVersion: Int

  public init(
    rows: [ChatCacheEvent],
    cursor: ChatCacheCursor,
    schemaVersion: Int
  ) {
    self.rows = rows
    self.cursor = cursor
    self.schemaVersion = schemaVersion
  }
}

public enum ChatCacheError: Error {
  case unavailable
  case missingThreadList
  case missingHistory
  case invalidCursor
  case invalidEventSequence
  case incompatibleHistorySchema
  case corrupt
  case unsupportedVersion
}
