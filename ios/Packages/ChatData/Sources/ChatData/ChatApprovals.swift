import Foundation

/// A mail draft the agent prepared and left for the user to send ("drafts, not sends").
public struct ChatMailDraft: Decodable, Equatable, Sendable {
  public struct Attachment: Decodable, Equatable, Sendable {
    public let filename: String
    public let size: Int
  }

  public enum Status: String, Decodable, Sendable {
    case draft, sending, sent, deleted
  }

  public let provider: String
  public let from: String
  public let fromName: String?
  public let to: [String]
  public let cc: [String]
  public let bcc: [String]
  public let subject: String
  public let body: String
  public let status: Status
  public let detailAvailable: Bool
  public let accessStatus: String?
  public let attachments: [Attachment]
  public let outlookWebLink: URL?
  public let gmailThreadId: String?

  /// The provider must be reconnected before this draft can be sent.
  public var needsReconnect: Bool { accessStatus == "reconnect" }
}

/// A request to run commands on the user's own computer, approved per chat.
public struct ChatShellAuthorization: Decodable, Equatable, Sendable {
  public enum Status: String, Decodable, Sendable {
    case pending, approved, denied, revoked, expired
  }

  public let id: String
  public let chatThreadId: String
  public let computerUseHostId: String
  public let computerName: String
  public let reason: String?
  public let status: Status
  public let approvalBlockedReason: String?
  public let requestExpiresAt: Date
  public let grantExpiresAt: Date?
}

public enum ChatShareAudience: String, Encodable, Sendable {
  case `private`, organization, `public`
}

extension APIClient {
  private struct MailDraftEnvelope: Decodable { let mailDraft: ChatMailDraft }

  /// nil when the draft no longer exists.
  public func mailDraft(id: String) async throws -> ChatMailDraft? {
    do {
      let envelope: MailDraftEnvelope = try await request("/api/mail/drafts/\(id)")
      return envelope.mailDraft
    } catch let error as APIClientError where error.statusCode == 404 {
      return nil
    }
  }

  public func sendMailDraft(id: String) async throws -> ChatMailDraft {
    let envelope: MailDraftEnvelope = try await request(
      "/api/mail/drafts/\(id)/send", method: "POST")
    return envelope.mailDraft
  }

  public func discardMailDraft(id: String) async throws {
    try await data("/api/mail/drafts/\(id)", method: "DELETE")
  }

  public func shellAuthorization(id: String) async throws -> ChatShellAuthorization {
    try await request("/api/computer-use/shell/authorizations/\(id)")
  }

  public func approveShellAuthorization(id: String) async throws -> ChatShellAuthorization {
    try await request(
      "/api/computer-use/shell/authorizations/\(id)/approve", method: "POST", body: Data("{}".utf8)
    )
  }

  public func denyShellAuthorization(id: String) async throws -> ChatShellAuthorization {
    try await request(
      "/api/computer-use/shell/authorizations/\(id)/deny", method: "POST", body: Data("{}".utf8))
  }

  public func revokeShellAuthorization(id: String) async throws -> ChatShellAuthorization {
    try await request(
      "/api/computer-use/shell/authorizations/\(id)/revoke", method: "POST", body: Data("{}".utf8)
    )
  }

  /// Shares the given transcript events and returns the share's id; the web serves it at
  /// `/share/threads/<id>`. The id is chosen here so the link can be built at once.
  public func shareThread(
    threadID: String, eventIDs: [String], audience: ChatShareAudience
  ) async throws -> String {
    struct Demand: Encodable {
      let eventIds: [String]
      let id: String
      let audience: ChatShareAudience
    }
    struct Created: Decodable { let id: String }
    let id = UUID().uuidString.lowercased()
    let created: Created = try await request(
      "/api/chat-threads/\(threadID)/shared-threads/visibility", method: "POST",
      body: JSONEncoder().encode(Demand(eventIds: eventIDs, id: id, audience: audience)))
    return created.id
  }
}
