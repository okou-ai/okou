import Foundation

/// The batch link is an untrusted claim, not an authorization receipt.
public struct ChatPermissionBatchAction: Hashable, Sendable {
  public struct Item: Codable, Hashable, Identifiable, Sendable {
    public let connectorSlug: String
    public let permission: String
    public var id: String { connectorSlug + "\0" + permission }

    private struct Key: CodingKey {
      let stringValue: String
      var intValue: Int? { nil }
      init?(stringValue: String) { self.stringValue = stringValue }
      init?(intValue: Int) { return nil }
    }

    public init(from decoder: any Decoder) throws {
      let container = try decoder.container(keyedBy: Key.self)
      guard Set(container.allKeys.map(\.stringValue)) == ["connectorSlug", "permission"] else {
        throw DecodingError.dataCorrupted(
          .init(codingPath: decoder.codingPath, debugDescription: "Unexpected permission fields"))
      }
      connectorSlug = try container.decode(String.self, forKey: Key(stringValue: "connectorSlug")!)
      permission = try container.decode(String.self, forKey: Key(stringValue: "permission")!)
      guard
        connectorSlug.range(of: #"\A[a-z0-9][a-z0-9-]{0,63}\z"#, options: .regularExpression)
          != nil,
        !permission.isEmpty, permission.utf16.count <= 128
      else {
        throw DecodingError.dataCorrupted(
          .init(codingPath: decoder.codingPath, debugDescription: "Invalid connector permission"))
      }
    }
  }

  public let agentID: String
  public let threadID: String
  public let items: [Item]
  public let duration: ChatPermissionAction.Duration
  public let callbackPrompt: String?

  public static func trustedURL(_ value: String, webURL: URL) -> URL? {
    guard let url = ChatPermissionAction.trustedPlatformURL(value, webURL: webURL),
      url.path.range(of: #"^/agents/[^/]+/permissions/batch$"#, options: .regularExpression) != nil
    else { return nil }
    return url
  }

  public init?(value: String, webURL: URL, agentID: String, threadID: String) {
    guard value.utf8.count <= 8192,
      value.trimmingCharacters(in: .whitespacesAndNewlines) == value,
      !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }),
      value.removingPercentEncoding != nil,
      let url = Self.trustedURL(value, webURL: webURL), url.absoluteString.utf8.count <= 8192,
      url.fragment == nil,
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      UUID(uuidString: agentID) != nil, UUID(uuidString: threadID) != nil
    else { return nil }
    let segments = url.path.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.count == 5, UUID(uuidString: String(segments[2])) == UUID(uuidString: agentID)
    else { return nil }
    // Batch links use URLSearchParams encoding, where "+" denotes a space.
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%20")
    let query = components.queryItems ?? []
    let allowed: Set<String> = ["items", "action", "expiresIn", "threadId", "callbackPrompt"]
    guard Set(query.map(\.name)).count == query.count,
      query.allSatisfy({ allowed.contains($0.name) })
    else { return nil }
    func field(_ name: String) -> String? { query.first { $0.name == name }?.value }
    guard field("action") == "allow", let json = field("items")?.data(using: .utf8),
      let rows = try? JSONDecoder().decode([Item].self, from: json), (1...20).contains(rows.count)
    else { return nil }
    let expiresIn = field("expiresIn")
    if query.contains(where: { $0.name == "expiresIn" }) {
      guard let expiresIn, ChatPermissionAction.Duration(rawValue: expiresIn) != nil else {
        return nil
      }
    }
    let callback = field("callbackPrompt")
    let callbackThread = field("threadId")
    if query.contains(where: { $0.name == "callbackPrompt" || $0.name == "threadId" }) {
      guard let callback, !callback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        let callbackThread, UUID(uuidString: callbackThread) == UUID(uuidString: threadID)
      else { return nil }
    }
    self.agentID = agentID.lowercased()
    self.threadID = threadID.lowercased()
    items = Set(rows).sorted {
      $0.connectorSlug == $1.connectorSlug
        ? $0.permission < $1.permission : $0.connectorSlug < $1.connectorSlug
    }
    duration = expiresIn.flatMap(ChatPermissionAction.Duration.init(rawValue:)) ?? .hour
    callbackPrompt = callback
  }
}
