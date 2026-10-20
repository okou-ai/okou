import ChatDomain
import CryptoKit
import Foundation

public enum ChatDraftTarget: Equatable, Sendable {
  case unassigned
  case agent(String)
  case thread(agentID: String, threadID: String)

  public var key: String {
    switch self {
    case .unassigned: "unassigned"
    case .agent(let id): "agent/" + id
    case .thread(let agent, let thread): "agent/" + agent + "/thread/" + thread
    }
  }
  var readPath: String? {
    switch self {
    case .unassigned: nil
    case .agent(let id): "/api/agents/\(id)/draft"
    case .thread(_, let id): "/api/chat-threads/\(id)/draft"
    }
  }
  var writePath: String? {
    switch self {
    case .unassigned: nil
    case .agent: readPath
    case .thread(_, let id): "/api/chat-threads/\(id)"
    }
  }
}

public struct ComposerDraft: Codable, Equatable, Sendable {
  private enum CodingKeys: String, CodingKey { case draftUserMessage, draftAttachments }
  public var draftUserMessage: ChatDraftDocument?
  public var draftAttachments: [DraftAttachment]?

  public init(document: ChatDraftDocument? = nil, attachments: [DraftAttachment]? = nil) {
    draftUserMessage = document
    draftAttachments = attachments
  }

  public struct DraftAttachment: Codable, Equatable, Sendable {
    public let id: String
    public let url: String
    public let filename: String
    public let contentType: String
    public let size: Int

    public init(attachment: ChatAttachment, url: String) {
      id = attachment.id
      filename = attachment.filename
      contentType = attachment.contentType
      size = attachment.size
      self.url = url
    }
    public var attachment: ChatAttachment {
      ChatAttachment(id: id, filename: filename, contentType: contentType, size: size, url: url)
    }
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    draftUserMessage = try container.decode(ChatDraftDocument?.self, forKey: .draftUserMessage)
    draftAttachments = try container.decode([DraftAttachment]?.self, forKey: .draftAttachments)
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(draftUserMessage, forKey: .draftUserMessage)
    try container.encode(draftAttachments, forKey: .draftAttachments)
  }
}

public struct ChatDraftRepository: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func load(_ target: ChatDraftTarget) async throws -> ComposerDraft {
    guard let path = target.readPath else { throw ChatError.noDefaultAgent }
    return try await client.request(path)
  }
  public func save(_ draft: ComposerDraft, to target: ChatDraftTarget) async throws {
    guard let path = target.writePath else { throw ChatError.noDefaultAgent }
    try await client.data(path, method: "PATCH", body: JSONEncoder().encode(draft))
  }
}

/// Device-owned drafts never enter the server-confirmed history cache. Atomic files survive
/// process restarts and are scoped to the API origin, user, organization and composer owner.
public struct ChatDraftStorage: Sendable {
  private let directory: URL

  public init(scope: ChatCacheScope, directory: URL? = nil) {
    let root =
      directory
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let identity = [scope.apiBaseURL.absoluteString, scope.userID, scope.workspaceID].joined(
      separator: "\u{0}")
    self.directory = root.appendingPathComponent(
      "ChatDrafts/" + Self.digest(identity), isDirectory: true)
  }
  public func load<Value: Decodable>(_ key: String, as: Value.Type) throws -> Value? {
    let url = file(key)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(Value.self, from: Data(contentsOf: url))
  }
  public func save<Value: Encodable>(_ value: Value, key: String) throws {
    try FileManager.default.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var mutable = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try mutable.setResourceValues(values)
    try JSONEncoder().encode(value).write(
      to: file(key), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }
  private func file(_ key: String) -> URL {
    directory.appendingPathComponent(Self.digest(key) + ".json")
  }
  private static func digest(_ key: String) -> String {
    SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
