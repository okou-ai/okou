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

  public func directionDraft(note: String) throws -> ComposerDraft {
    guard case .suggestion(let suggestion) = content, let customContextVersion,
      let original = suggestion.customOption.draft.draftUserMessage,
      let quote = original.parts.first(where: { $0["type"]?.string == "feedback" }),
      case .object(var feedback) = quote,
      !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else { throw APIClientError.incompatibleData }
    let files = suggestion.customOption.draft.draftAttachments ?? []
    let context = MessageJSON.object([
      "suggestionId": .string(id), "draftId": .string(id), "optionId": .string("custom"),
      "titleSnapshot": .string(suggestion.title),
      "rationaleSnapshot": .string(suggestion.rationale),
      "contextVersion": .string(customContextVersion),
      "attachmentIds": .array(files.map { .string($0.id) })
    ])
    let text =
      "Okou suggestion context v1:\n"
      + String(decoding: try JSONEncoder().encode(context), as: UTF8.self)
    feedback["note"] = .array([.object(["type": .string("text"), "text": .string(note)])])
    let parts: [MessageJSON] = [
      .object(["type": .string("additional_info"), "text": .string(text)]), .object(feedback)
    ]
    return ComposerDraft(
      document: ChatDraftDocument(
        parts: parts + original.parts.filter { $0["type"]?.string == "file" }),
      attachments: files)
  }
}

public enum ForYouFeedback: String, CaseIterable, Sendable {
  case alreadyDone = "already_done"
  case notPlanned = "not_planned"
  case dontNudge = "dont_nudge"
  case lessLikeThis = "less_like_this"

  var wireKind: String { self == .dontNudge ? Self.notPlanned.rawValue : rawValue }
  var note: String { self == .dontNudge ? "Do not nudge me about this again." : "" }
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
    do { try await client.data("/api/feed/items/\(id)/read", method: "POST") } catch let error
      as APIClientError where error.statusCode == 404
    { return }
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
      "id": .string(id), "kind": .string(target == nil ? reason?.wireKind ?? "dismissed" : "undo"),
      "note": .string(reason?.note ?? "")
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
      let path = "/api/workflow-automations/\(event.automationId)"
      let automation: Automation = try await client.request(path)
      if !automation.enabled { try await client.data(path + "/enable", method: "POST") }
    }
    do { try await client.data("/api/feed/items/\(cardID)/dismiss", method: "POST") } catch let
      error as APIClientError where error.statusCode == 404
    { return }
  }
}
