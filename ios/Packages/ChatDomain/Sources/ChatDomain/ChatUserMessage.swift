import Foundation

/// The durable user message, including the context needed to render its original meaning.
public struct ChatUserMessage: Decodable, Equatable, Sendable {
  public let version: Int
  public let parts: [Part]

  public init(version: Int = 1, parts: [Part]) {
    self.version = version
    self.parts = parts
  }

  private enum CodingKeys: CodingKey { case version, parts }

  public init(from decoder: Decoder) throws {
    let fields = try decoder.container(keyedBy: CodingKeys.self)
    version = try fields.decode(Int.self, forKey: .version)
    parts = try Part.readStoredParts(
      from: fields.superDecoder(forKey: .parts), types: Part.messageTypes)
  }

  public var annotation: Part? {
    parts.first { ["source", "automation"].contains($0.type) || $0.isForwardedChat }
  }

  public var bodyParts: [Part] {
    let visible = parts.filter {
      !$0.isForwardedChat
        && ["text", "chat_thread", "project", "template", "feedback"].contains($0.type)
    }
    if annotation?.type == "automation",
      visible.map(\.displayText).joined()
        .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      let brief = annotation?.automationBrief?.trimmingCharacters(in: .whitespacesAndNewlines),
      !brief.isEmpty
    {
      return [.init(type: "text", text: brief)]
    }
    return visible
  }

  /// Context annotations and model metadata never become user-authored text.
  public var displayText: String { bodyParts.map(\.displayText).joined() }

  public var model: Model? {
    guard let part = parts.first(where: { $0.type == "model" }),
      let id = part.selectedModel
    else { return nil }
    return Model(id: id, isFast: part.serviceTier == "priority")
  }

  public func validate() throws {
    for part in parts { try part.validate() }
  }

  public func attachments() throws -> [ChatMessageAttachment] {
    try parts.filter { $0.type == "file" }.map { part in
      guard let id = part.fileId, !id.isEmpty,
        let filename = part.filenameSnapshot, !filename.isEmpty,
        let contentType = part.contentType, !contentType.isEmpty
      else { throw ChatError.invalidContract("Attachment identity or metadata is missing.") }
      return ChatMessageAttachment(
        id: id, filename: filename,
        contentType: part.annotatedFileId == nil ? contentType : "image/png",
        renderedFileID: part.annotatedFileId)
    }
  }

  public struct Model: Equatable, Sendable {
    public let id: String
    public let isFast: Bool

    public func selectsSameModel(as other: Model) -> Bool {
      id == other.id
        || (["auto", "okou-1.0"].contains(id) && ["auto", "okou-1.0"].contains(other.id))
    }
  }

  public struct Part: Decodable, Equatable, Sendable {
    public let type: String
    public let text: String?
    public let titleSnapshot: String?
    public let nameSnapshot: String?
    public let fileId: String?
    public let contentType: String?
    public let filenameSnapshot: String?
    public let workflowName: String?
    public let kind: String?
    public let href: String?
    public let clientName: String?
    public let threadId: String?
    public let projectId: String?
    public var isForwardedChat: Bool { type == "chat_thread" && runId != nil }
    public let runId: String?
    public let workflowId: String?
    public let automationBrief: String?
    public let eventId: String?
    public let range: FeedbackRange?
    public let quote: String?
    public var note: [Part]? { storedNote?.parts }
    private let storedNote: StoredFeedbackNote?
    public let source: FeedbackSource?
    public let selectedModel: String?
    public let serviceTier: String?
    public let annotatedFileId: String?

    private enum CodingKeys: String, CodingKey {
      case type, text, titleSnapshot, nameSnapshot, fileId, contentType, filenameSnapshot
      case workflowName, kind, href, clientName, threadId, projectId, runId, workflowId
      case automationBrief, eventId, range, quote, source, selectedModel, serviceTier,
        annotatedFileId
      case storedNote = "note"
    }

    fileprivate static let noteTypes: Set<String> = ["text", "chat_thread", "project", "template"]
    fileprivate static let messageTypes = noteTypes.union([
      "additional_info", "automation", "feedback", "file", "voice", "model", "source"
    ])
    private static let sourceKinds: Set<String> = [
      "slack", "discord", "wechat", "feishu", "lark", "teams", "telegram", "github", "agentphone",
      "mcp"
    ]

    fileprivate static func readStoredParts(from decoder: Decoder, types: Set<String>) throws
      -> [Part]
    {
      var items = try decoder.unkeyedContainer()
      var parts: [Part] = []
      while !items.isAtEnd {
        let item = try items.superDecoder()
        let fields = try item.container(keyedBy: CodingKeys.self)
        let type = try fields.decode(String.self, forKey: .type)
        guard types.contains(type) else { continue }
        if type == "source", !sourceKinds.contains(try fields.decode(String.self, forKey: .kind)) {
          continue
        }
        parts.append(try Part(from: item))
      }
      return parts
    }

    public init(
      type: String, text: String? = nil, titleSnapshot: String? = nil,
      nameSnapshot: String? = nil, fileId: String? = nil, contentType: String? = nil,
      filenameSnapshot: String? = nil, workflowName: String? = nil,
      kind: String? = nil, href: String? = nil, clientName: String? = nil,
      threadId: String? = nil, projectId: String? = nil,
      runId: String? = nil,
      workflowId: String? = nil, automationBrief: String? = nil,
      quote: String? = nil, note: [Part]? = nil, source: FeedbackSource? = nil,
      eventId: String? = nil, range: FeedbackRange? = nil,
      selectedModel: String? = nil, serviceTier: String? = nil, annotatedFileId: String? = nil
    ) {
      self.type = type
      self.text = text
      self.titleSnapshot = titleSnapshot
      self.nameSnapshot = nameSnapshot
      self.fileId = fileId
      self.contentType = contentType
      self.filenameSnapshot = filenameSnapshot
      self.workflowName = workflowName
      self.kind = kind
      self.href = href
      self.clientName = clientName
      self.threadId = threadId
      self.projectId = projectId
      self.runId = runId
      self.workflowId = workflowId
      self.automationBrief = automationBrief
      self.eventId = eventId
      self.range = range
      self.quote = quote
      self.storedNote = note.map(StoredFeedbackNote.init(parts:))
      self.source = source
      self.selectedModel = selectedModel
      self.serviceTier = serviceTier
      self.annotatedFileId = annotatedFileId
    }

    public var displayText: String {
      switch type {
      case "text": text ?? ""
      case "chat_thread", "template": titleSnapshot ?? ""
      case "project": nameSnapshot ?? ""
      case "feedback": "\n" + (quote ?? "") + "\n" + (note ?? []).map(\.displayText).joined() + "\n"
      default: ""
      }
    }

    fileprivate func validate() throws {
      func present(_ value: String?) -> Bool { value?.isEmpty == false }
      func identity(_ value: String?) -> Bool { value.flatMap(UUID.init(uuidString:)) != nil }
      let valid: Bool
      switch type {
      case "text": valid = present(text)
      case "chat_thread":
        valid = present(titleSnapshot) && identity(threadId) && (runId == nil || identity(runId))
      case "project": valid = present(nameSnapshot) && identity(projectId)
      case "template": valid = present(titleSnapshot)
      case "automation":
        valid = present(workflowName) && (workflowId == nil || identity(workflowId))
      case "feedback":
        valid =
          present(quote) && note != nil
          && ((eventId == nil) == (range == nil))
          && (eventId == nil || present(eventId))
          && (range.map { $0.start >= 0 && $0.end > $0.start } ?? true)
        for part in note ?? [] { try part.validate() }
        if let source, source.type != "mail" || !["draft", "sent"].contains(source.status) {
          throw ChatError.invalidContract("Invalid quoted feedback source.")
        }
      case "model": valid = present(selectedModel)
      case "source": valid = kind.map(Self.sourceKinds.contains) == true
      default: valid = true
      }
      guard valid else {
        throw ChatError.invalidContract("Invalid structured user message part: \(type).")
      }
    }
  }

  public struct FeedbackRange: Decodable, Equatable, Sendable {
    public let start: Int
    public let end: Int
  }

  public struct FeedbackSource: Decodable, Equatable, Sendable {
    public let type: String
    public let id: String
    public let status: String
    public let sentId: String?
  }
}

private struct StoredFeedbackNote: Decodable, Equatable, Sendable {
  let parts: [ChatUserMessage.Part]
}

extension StoredFeedbackNote {
  init(from decoder: Decoder) throws {
    parts = try ChatUserMessage.Part.readStoredParts(
      from: decoder, types: ChatUserMessage.Part.noteTypes)
  }
}

public enum ChatModelChange: Equatable, Sendable {
  case model(ChatUserMessage.Model)
  case fastMode(Bool)
}
