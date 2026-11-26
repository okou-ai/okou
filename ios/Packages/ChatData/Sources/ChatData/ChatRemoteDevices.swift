import ChatDomain
import Foundation

public struct ChatRemoteDevice: Decodable, Sendable, Identifiable, Equatable {
  public struct Channel: Decodable, Sendable, Identifiable, Equatable {
    public enum Kind: String, Decodable, Sendable { case desktop, ios, ssh, vnc }

    public let id: UUID
    public let kind: Kind
    public let displayName: String
    public let lastSeenAt: Date?
  }

  public let id: UUID
  public let displayName: String
  public let accessAllowed: Bool
  public let accessExpiresAt: Date?
  public let channels: [Channel]
}

public struct ChatRemoteDevices: Sendable {
  public enum Policy: Sendable, CaseIterable, Hashable {
    case always, oneHour, twentyFourHours, sevenDays, denied

    fileprivate var body: PolicyBody {
      switch self {
      case .always: PolicyBody(mode: "always")
      case .oneHour: PolicyBody(mode: "for", hours: 1)
      case .twentyFourHours: PolicyBody(mode: "for", hours: 24)
      case .sevenDays: PolicyBody(mode: "for", hours: 168)
      case .denied: PolicyBody(mode: "denied")
      }
    }
  }

  fileprivate struct PolicyBody: Encodable {
    let mode: String
    var hours: Int?
  }
  private struct Directory: Decodable, Sendable { let devices: [ChatRemoteDevice] }
  private struct Create: Encodable {
    let id: UUID
    let displayName: String
  }
  private struct Approval: Encodable { let deviceId: UUID }
  private let client: APIClient

  public init(client: APIClient) { self.client = client }

  public func list() async throws -> [ChatRemoteDevice] {
    try await client.request("/api/remote-devices", as: Directory.self).devices
  }

  public func create(id: UUID, displayName: String) async throws {
    try await client.data(
      "/api/remote-devices", method: "POST",
      body: JSONEncoder().encode(Create(id: id, displayName: displayName)))
  }

  public func setPolicy(_ policy: Policy, deviceID: UUID) async throws {
    try await client.data(
      "/api/remote-devices/\(deviceID.uuidString.lowercased())/access", method: "PUT",
      body: JSONEncoder().encode(policy.body))
  }

  public func move(_ channel: ChatRemoteDevice.Channel, to deviceID: UUID) async throws {
    let base = "/api/remote-devices/\(deviceID.uuidString.lowercased())"
    try await client.data(
      "\(base)/channels/\(channel.kind.rawValue)/\(channel.id.uuidString.lowercased())",
      method: "PUT")
  }

  public func approve(deviceID: UUID, threadID: UUID) async throws {
    try await client.data(
      "/api/chat-threads/\(threadID.uuidString.lowercased())/remote-device-approval",
      method: "POST",
      body: JSONEncoder().encode(Approval(deviceId: deviceID)))
  }
}

public struct ChatRemoteDeviceApprovalAction: Hashable, Sendable {
  public let id: UUID
  public let deviceID: UUID
  public let threadID: UUID
  public let reason: String
  public let callbackPrompt: String?

  public static func parse(_ value: String, webURL: URL, threadID: String) -> Self? {
    guard let url = URL(string: value, relativeTo: webURL)?.absoluteURL,
      url.scheme == webURL.scheme, url.host() == webURL.host(), url.port == webURL.port,
      url.user == nil, url.password == nil,
      let originThreadID = UUID(uuidString: threadID),
      var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return nil }
    let path = url.pathComponents
    guard path.count == 3, path[1] == "chats", UUID(uuidString: path[2]) == originThreadID
    else { return nil }
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(
      of: "+", with: "%20")
    let queries = components.queryItems ?? []
    func query(_ name: String) -> String? { queries.first { $0.name == name }?.value }
    guard let deviceID = query("remoteDeviceApproval").flatMap(UUID.init(uuidString:)),
      let actionID = query("actionId").flatMap(UUID.init(uuidString:)),
      let reason = query("reason")?.trimmingCharacters(in: .ecmaScriptWhitespace),
      !reason.isEmpty, reason.utf16.count <= 500
    else { return nil }
    let callback = query("callbackPrompt")
    if let callback {
      guard !callback.trimmingCharacters(in: .ecmaScriptWhitespace).isEmpty,
        query("threadId").flatMap(UUID.init(uuidString:)) == originThreadID
      else { return nil }
    } else if query("threadId") != nil {
      return nil
    }
    return Self(
      id: actionID, deviceID: deviceID, threadID: originThreadID, reason: reason,
      callbackPrompt: callback)
  }
}
