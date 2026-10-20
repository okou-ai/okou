import Foundation

public struct ChatRecommendedFollowup: Equatable, Sendable, Decodable {
  public enum Kind: String, Decodable, Sendable { case talk, generate }
  public enum GenerationType: String, Decodable, Sendable {
    case image, video, presentation, website
  }

  public let prompt: String
  public let kind: Kind
  public let generationType: GenerationType?

  public init(prompt: String, kind: Kind, generationType: GenerationType? = nil) {
    self.prompt = prompt
    self.kind = kind
    self.generationType = generationType
  }

  /// Match the strict versioned PWA document. Unsupported recommendations must
  /// not make the rest of a conversation unreadable or revive an older source.
  static func parse(_ content: String?) -> [Self] {
    guard let content, let data = content.data(using: .utf8),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == ["version", "followups"],
      let items = object["followups"] as? [[String: Any]],
      items.allSatisfy({
        Set($0.keys).isSubset(of: ["prompt", "kind", "generationType"])
          && ($0["generationType"] == nil || $0["generationType"] is String)
      }),
      let document = try? JSONDecoder().decode(Document.self, from: data), document.version == 1
    else { return [] }
    return document.followups.filter { $0.generationType != .video }
  }

  private struct Document: Decodable {
    let version: Int
    let followups: [ChatRecommendedFollowup]
  }
}

public struct ChatRecommendedFollowupSource: Equatable, Sendable {
  public let eventID: String
  public let followups: [ChatRecommendedFollowup]

  public init(eventID: String, followups: [ChatRecommendedFollowup]) {
    self.eventID = eventID
    self.followups = followups
  }
}

/// Recommendation ownership follows the same run-turn ordering as the PWA,
/// independently of the transcript's rendering window and collapsed work rows.
enum ChatFollowupProjection {
  static func source(rows: [ChatEvent], active: Bool)
    -> ChatRecommendedFollowupSource?
  {
    guard !active else { return nil }
    let revoked = Set(rows.compactMap(\.revokesEventId))
    let automation = Set(rows.filter { $0.eventType == .inputAutomation }.map(\.id))
    // Canonical rows carry the interrupt target in runId; the PWA's wire
    // projection names that same target interruptsRunId.
    let interrupted = Set(rows.filter { $0.eventType == .controlInterrupt }.compactMap(\.runId))
    var turns: [[ChatEvent]] = []
    var runTurns: [String: Int] = [:]
    for row in rows {
      guard !revoked.contains(row.id), row.eventType != .controlRevoke,
        row.eventType != .inputBudget, row.eventType != .usageRecorded,
        !(row.eventType == .inputAutomation && row.runId == nil),
        !(row.eventType == .inputRejected && row.revokesEventId.map(automation.contains) == true),
        !(row.eventType == .runCancelled && row.runId.map(interrupted.contains) == true)
      else { continue }
      let semantic: ChatEvent
      if row.eventType == .controlInterrupt, let runID = row.runId {
        semantic = ChatEvent(
          id: row.id, runId: runID, createdAt: row.createdAt, eventType: .runCancelled,
          payload: .init(content: "Run cancelled", error: "Run cancelled"))
      } else {
        semantic = row
      }
      if let run = semantic.runId, let index = runTurns[run] {
        turns[index].append(semantic)
      } else {
        if let run = semantic.runId { runTurns[run] = turns.count }
        turns.append([semantic])
      }
    }
    let ordered = turns.flatMap { $0 }
    guard let last = ordered.last, isAssistant(last.eventType), last.runId != nil,
      last.eventType != .runCancelled
    else { return nil }
    guard !hasStatusTail(ordered) else { return nil }
    for row in ordered.reversed() {
      guard isAssistant(row.eventType) else { return nil }
      if row.eventType == .outputFollowups {
        let followups = ChatRecommendedFollowup.parse(row.payload?.content)
        return followups.isEmpty ? nil : .init(eventID: row.id, followups: followups)
      }
      if row.eventType == .outputMessage || row.eventType == .outputError
        || row.eventType.isTerminal,
        !(row.payload?.content?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
      {
        return nil
      }
    }
    return nil
  }

  /// Inputs start a work phase; bookkeeping alone does not retire the previous
  /// outcome. An error after the phase's output anchor replaces the finished row.
  private static func hasStatusTail(_ ordered: [ChatEvent]) -> Bool {
    var phases: [[ChatEvent]] = []
    for row in ordered {
      if let run = row.runId, phases.last?.last?.runId == run, isAssistant(row.eventType) {
        phases[phases.count - 1].append(row)
      } else {
        phases.append([row])
      }
    }
    var hasTail = false
    for phase in phases {
      guard
        phase.contains(where: { row in
          !isAssistant(row.eventType)
            || row.eventType != .outputFollowups
              && (row.payload?.content?.isEmpty == false || row.payload?.error?.isEmpty == false)
        })
      else { continue }
      let anchor = phase.lastIndex { $0.eventType == .outputMessage }
      hasTail = phase.dropFirst((anchor ?? -1) + 1).contains { row in
        isAssistant(row.eventType) && row.payload?.error?.isEmpty == false
      }
    }
    return hasTail
  }

  private static func isAssistant(_ type: ChatEventType) -> Bool {
    switch type {
    case .outputMessage, .outputError, .outputFollowups, .runCompleted, .runFailed, .runCancelled,
      .usageRecorded:
      true
    default: false
    }
  }
}
