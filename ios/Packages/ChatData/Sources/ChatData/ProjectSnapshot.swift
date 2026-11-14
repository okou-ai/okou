import ChatDomain
import Foundation

/// A server-derived materialized Project baseline and its inseparable event frontier.
struct ProjectSnapshot: Codable, Sendable {
  var projects: [ChatProject]
  var latestEventId: String?
  var latestSeqId: Int

  var cursor: ChatCacheCursor { ChatCacheCursor(eventID: latestEventId, seqID: latestSeqId) }

  func validate() throws {
    guard latestSeqId >= 0, Set(projects.map(\.id)).count == projects.count else {
      throw ChatError.invalidContract("The Project snapshot is invalid.")
    }
  }

  mutating func apply(_ events: [ProjectEvent], seen: inout Set<String>) throws {
    var records = Dictionary(uniqueKeysWithValues: projects.map { ($0.id, $0) })
    for event in events {
      guard event.seqId > latestSeqId, seen.insert(event.id).inserted else {
        throw ChatError.invalidContract("Project events are not ordered.")
      }
      switch event.kind {
      case .deleted:
        records[event.projectId] = nil
      case .created, .renamed:
        guard let name = event.name,
          event.kind != .renamed || records[event.projectId] != nil
        else { throw ChatError.invalidContract("The Project event has no baseline or name.") }
        records[event.projectId] = ChatProject(
          id: event.projectId, name: name,
          createdAt: records[event.projectId]?.createdAt ?? event.createdAt,
          updatedAt: event.createdAt)
      }
      latestEventId = event.id
      latestSeqId = event.seqId
    }
    projects = records.values.sorted {
      $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
    }
  }
}

struct ProjectEvent: Decodable, Sendable {
  enum Kind: String, Decodable { case created, renamed, deleted }
  let id: String
  let seqId: Int
  let projectId: String
  let kind: Kind
  let name: String?
  let createdAt: Date
}

struct ProjectEventsPage: Decodable, Sendable {
  let events: [ProjectEvent]
  let hasMore: Bool
}

enum ProjectSnapshotResponse: Decodable, Sendable {
  case inline(ProjectSnapshot)
  case remote(URL, ChatCacheCursor)

  private enum CodingKeys: String, CodingKey { case url, latestEventId, latestSeqId }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    if let url = try container.decodeIfPresent(URL.self, forKey: .url) {
      self = .remote(
        url,
        ChatCacheCursor(
          eventID: try container.decodeIfPresent(String.self, forKey: .latestEventId),
          seqID: try container.decode(Int.self, forKey: .latestSeqId)))
    } else {
      self = .inline(try ProjectSnapshot(from: decoder))
    }
  }
}
