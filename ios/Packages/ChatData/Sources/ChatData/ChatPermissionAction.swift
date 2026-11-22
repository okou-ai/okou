import Foundation

/// A permission request names its workspace member and may continue its originating Chat.
public struct ChatPermissionAction: Hashable, Sendable {
  public enum Action: String, Codable, Sendable { case allow, deny }
  public enum Duration: String, CaseIterable, Codable, Sendable {
    case hour = "1h"
    case day = "24h"
    case week = "7d"
    case always
  }

  public let member: WorkspaceMemberID
  public let threadID: String
  public let connectorSlug: String
  public let permission: String
  public let action: Action
  public let duration: Duration
  public let method: String?
  public let path: String?
  public let reason: String?
  public let callbackPrompt: String?

  /// Recognizes only permission routes on configured platform origins or the PWA's trusted hosts.
  public static func trustedURL(_ value: String, webURL: URL) -> URL? {
    guard let url = trustedPlatformURL(value, webURL: webURL),
      url.path == "/connectors/permissions"
    else { return nil }
    return url
  }

  static func trustedPlatformURL(_ value: String, webURL: URL) -> URL? {
    guard let url = URL(string: value, relativeTo: webURL)?.absoluteURL,
      ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
      url.user == nil, url.password == nil, let host = url.host?.lowercased()
    else { return nil }
    var configuredHosts = Set([webURL.host?.lowercased() ?? ""])
    if let configured = webURL.host?.lowercased(),
      let range = configured.range(
        of: #"(^|-)(platform|app|www|api)\."#, options: .regularExpression)
    {
      let prefix = configured[range].hasPrefix("-") ? "-" : ""
      for service in ["api", "www", "app", "platform"] {
        configuredHosts.insert(
          configured.replacingCharacters(in: range, with: "\(prefix)\(service)."))
      }
    }
    let configuredOrigin =
      configuredHosts.contains(host)
      && url.scheme?.lowercased() == webURL.scheme?.lowercased() && url.port == webURL.port
    let previewHost = ["vm6.ai", "vm7.ai"].contains { domain in
      (host == domain || host.hasSuffix(".\(domain)"))
        && host.range(of: #"(^|-)(platform|app|www|api)\."#, options: .regularExpression) != nil
    }
    guard configuredOrigin || host == "app.okou.ai" || previewHost
    else { return nil }
    return url
  }

  /// The caller must first validate the URL's platform origin using the message-card parser.
  public init?(url: URL, threadID: String) {
    guard url.path == "/connectors/permissions", UUID(uuidString: threadID) != nil,
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    // Match Web's URLSearchParams without changing an encoded literal plus (%2B).
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%20")
    let query = components.queryItems ?? []
    guard Set(query.map(\.name)).count == query.count,
      let member = WorkspaceMemberID(permissionQuery: query)
    else { return nil }
    func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
    guard let slug = value("connectorSlug") ?? value("ref"),
      slug.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
      let permission = value("permission"), !permission.isEmpty, permission.count <= 128,
      let action = Action(rawValue: value("action") ?? "allow")
    else { return nil }
    let callback = value("callbackPrompt")
    let callbackThread = value("threadId")
    if query.contains(where: { $0.name == "callbackPrompt" || $0.name == "threadId" }) {
      guard let callback, !callback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        let callbackThread, let claimedThread = UUID(uuidString: callbackThread),
        claimedThread == UUID(uuidString: threadID)
      else { return nil }
    }
    self.member = member
    self.threadID = threadID
    connectorSlug = slug
    self.permission = permission
    self.action = action
    duration = Duration(rawValue: value("expiresIn") ?? "") ?? .hour
    method = value("method")
    path = value("path")
    reason = value("reason")
    callbackPrompt = callback
  }
}
