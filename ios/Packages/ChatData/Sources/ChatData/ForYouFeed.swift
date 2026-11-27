import ChatDomain
import Foundation

public struct ForYouOption: Decodable, Equatable, Sendable, Identifiable {
  public let id: String
  public let label: String
  public let description: String
  public let threadId: String?
  public let draft: ComposerDraft
}

public struct ForYouSuggestion: Decodable, Equatable, Sendable {
  public struct Direction: Decodable, Equatable, Sendable {
    public let threadId: String?
    public let draft: ComposerDraft
  }
  public let title: String
  public let rationale: String
  public let options: [ForYouOption]
  public let customOption: Direction
}

public struct ForYouAutomation: Decodable, Equatable, Sendable {
  public let automationId: String
  public let automationName: String
  public let automationDescription: String?
  public let consecutiveFailures: Int
  public let recoveryScheduled: Bool
  /// ISO 8601, as the feed sends it.
  public let disabledAt: String?
}

public struct ForYouCard: Decodable, Equatable, Sendable, Identifiable {
  public enum Content: Equatable, Sendable {
    case suggestion(ForYouSuggestion)
    case automation(ForYouAutomation)
    case unsupported
  }
  public let id: String
  public let content: Content
  public let customContextVersion: String?
  let snapshot: MessageJSON?

  private enum Keys: String, CodingKey {
    case id, type, content, consumeToken, customContextVersion
  }
  private struct EventType: Decodable { let eventType: String }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: Keys.self)
    id = try values.decode(String.self, forKey: .id)
    customContextVersion = try values.decodeIfPresent(String.self, forKey: .customContextVersion)
    switch try values.decode(String.self, forKey: .type) {
    case "suggestion":
      content = .suggestion(try values.decode(ForYouSuggestion.self, forKey: .content))
      snapshot =
        try values.decodeIfPresent(String.self, forKey: .consumeToken) == nil
        ? nil : MessageJSON(from: decoder)
    case "event"
    where try values.decode(EventType.self, forKey: .content).eventType == "automation-disabled":
      content = .automation(try values.decode(ForYouAutomation.self, forKey: .content))
      snapshot = nil
    default:
      content = .unsupported
      snapshot = nil
    }
  }

  /// The visible editor owns just the member's note. The original background and
  /// its signed file list remain immutable, including when the member adds files.
  public func directionDraft(note: ComposerDraft) throws -> ComposerDraft {
    guard case .suggestion(let suggestion) = content, let customContextVersion,
      let original = suggestion.customOption.draft.draftUserMessage,
      case .object(var feedback) = original.parts.first(where: { $0["type"]?.string == "feedback" }),
      let document = note.draftUserMessage
    else { throw APIClientError.incompatibleData }
    let noteParts = document.parts.filter { $0["type"]?.string != "file" }
    guard
      noteParts.allSatisfy({
        ["text", "chat_thread", "template"].contains($0["type"]?.string ?? "")
      }),
      noteParts.contains(where: {
        $0["type"]?.string != "text"
          || !($0["text"]?.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      })
    else { throw APIClientError.incompatibleData }
    let backgroundFiles = suggestion.customOption.draft.draftAttachments ?? []
    let backgroundIDs = backgroundFiles.map(\.id)
    let context = MessageJSON.object([
      "suggestionId": .string(id), "draftId": .string(id), "optionId": .string("custom"),
      "titleSnapshot": .string(suggestion.title),
      "rationaleSnapshot": .string(suggestion.rationale),
      "contextVersion": .string(customContextVersion),
      "attachmentIds": .array(backgroundIDs.map(MessageJSON.string))
    ])
    // Retries compare the complete message, including the JSON embedded in this text part.
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    guard let serialized = String(data: try encoder.encode(context), encoding: .utf8) else {
      throw APIClientError.incompatibleData
    }
    feedback["note"] = .array(noteParts)
    var parts: [MessageJSON] = [
      .object([
        "type": .string("additional_info"),
        "text": .string("Okou suggestion context v1:\n" + serialized)
      ]),
      .object(feedback)
    ]
    let files =
      backgroundFiles + (note.draftAttachments ?? []).filter { !backgroundIDs.contains($0.id) }
    parts += files.map { file in
      .object([
        "type": .string("file"), "fileId": .string(file.id),
        "filenameSnapshot": .string(file.filename), "contentType": .string(file.contentType)
      ])
    }
    return ComposerDraft(
      document: ChatDraftDocument(parts: parts), attachments: files.isEmpty ? nil : files)
  }
}

public enum ForYouFeedback: String, CaseIterable, Sendable {
  case alreadyDone = "already_done"
  case notPlanned = "not_planned"
  case later
  case lessLikeThis = "less_like_this"
}

public struct ForYouFeed: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func cards() async throws -> [ForYouCard] {
    struct Page: Decodable { let items: [ForYouCard] }
    let page: Page = try await client.request("/api/feed/items")
    return page.items.filter { $0.content != .unsupported }
  }

  public func hasUnread() async throws -> Bool {
    struct Summary: Decodable { let hasUnread: Bool }
    let summary: Summary = try await client.request("/api/feed/summary")
    return summary.hasUnread
  }

  public func markRead(_ id: String) async throws {
    do {
      try await client.data("/api/feed/items/\(id)/read", method: "POST")
    } catch APIClientError.http(404, _, _, _) { return }
  }

  public func consume(_ card: ForYouCard, optionID: String) async throws {
    var body: [String: MessageJSON] = ["optionId": .string(optionID)]
    body["snapshot"] = card.snapshot
    try await client.data(
      "/api/feed/items/\(card.id)/suggestion/consume", method: "POST",
      body: JSONEncoder().encode(body))
  }

  @discardableResult
  public func feedback(
    _ card: ForYouCard, reason: ForYouFeedback?, id: String, undoing target: String? = nil
  ) async throws -> Bool {
    struct Result: Decodable { let restored: Bool }
    var body: [String: MessageJSON] = [
      "id": .string(id), "kind": .string(target == nil ? reason?.rawValue ?? "dismissed" : "undo"),
      "note": .string("")
    ]
    body["targetId"] = target.map(MessageJSON.string)
    body["snapshot"] = card.snapshot
    let result: Result = try await client.request(
      "/api/feed/items/\(card.id)/suggestion/feedback", method: "POST",
      body: JSONEncoder().encode(body))
    return result.restored
  }

  public func checkThread(_ id: String) async throws {
    _ = try await client.data("/api/chat-threads/\(id)/metadata")
  }

  public func resolve(_ event: ForYouAutomation, cardID: String, enable: Bool) async throws {
    if enable {
      struct Automation: Decodable { let enabled: Bool }
      let automation: Automation = try await client.request(
        "/api/workflow-automations/\(event.automationId)")
      if !automation.enabled {
        try await client.data(
          "/api/workflow-automations/\(event.automationId)/enable", method: "POST")
      }
    }
    do {
      try await client.data("/api/feed/items/\(cardID)/dismiss", method: "POST")
    } catch APIClientError.http(404, _, _, _) { return }
  }
}
