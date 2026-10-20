import Foundation

public enum PersonalSubscriptionType: String, CaseIterable, Sendable, Identifiable {
  case codex = "codex-oauth-token"
  case claude = "claude-code-oauth-token"
  public var id: String { rawValue }
  public var authPath: String { self == .codex ? "codex" : "claude-code" }
}

public struct PersonalSubscription: Decodable, Identifiable, Sendable {
  public let id: String
  public let type: String
  public let isActive: Bool?
  public let accountEmail: String?
  public let workspaceName: String?
  public let planType: String?
  public let needsReconnect: Bool
  public let lastRefreshErrorCode: String?
  public let subscriptionUsage: Usage?
  public let subscriptionResetPeriod: String?
  public let subscriptionNextResetAt: Date?
  public let subscriptionResetSupported: Bool?
  public let subscriptionResetCredits: Int?
  public let subscriptionResetCreditsNextExpiresAt: Date?

  public struct Usage: Decodable, Sendable {
    public let fiveHour: Window?
    public let weekly: Window?
  }
  public struct Window: Decodable, Sendable {
    public let usedPercent: Double?
    public let remainingPercent: Double?
    public let resetAt: Date?
    public let windowSeconds: Double?
    public var remaining: Double? {
      let raw = remainingPercent ?? usedPercent.map { 100 - $0 }
      return raw.flatMap { $0.isFinite ? max(0, min(100, $0)) : nil }
    }
  }
  public struct UsageWindow: Identifiable, Sendable {
    public let id: String
    public let window: Window
  }
  public var usageWindows: [UsageWindow] {
    let weekly = subscriptionUsage?.weekly
    var windows: [UsageWindow] = []
    if let fiveHour = subscriptionUsage?.fiveHour {
      let exhausted = weekly?.remaining.map { $0 <= 0 } == true
      windows.append(
        UsageWindow(
          id: "fiveHour",
          window: Window(
            usedPercent: exhausted ? 100 : fiveHour.usedPercent,
            remainingPercent: exhausted ? 0 : fiveHour.remainingPercent,
            resetAt: fiveHour.resetAt ?? weekly?.resetAt, windowSeconds: fiveHour.windowSeconds)))
    }
    if let weekly { windows.append(UsageWindow(id: "week", window: weekly)) }
    return windows
  }
  public var limitingUsage: UsageWindow? {
    usageWindows.reduce(nil) { current, candidate in
      guard let remaining = candidate.window.remaining else { return current ?? candidate }
      guard let previous = current?.window.remaining else { return candidate }
      return remaining <= previous ? candidate : current
    }
  }
  public var limitingWindow: Window? { limitingUsage?.window }

}

/// Session tokens stay in the flow owner, never in persisted chat models or logs.
public struct SubscriptionAuthSession: Decodable, Sendable {
  public let sessionToken: String
  public let browserUrl: URL
  public let verificationCode: String?
  public let expiresIn: Int
  public let interval: Int?
}
public struct SubscriptionAuthCompletion: Decodable, Sendable {
  public let status: String
  public let errorMessage: String?
}

public struct PersonalSubscriptionService: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }
  public func list() async throws -> [PersonalSubscription] {
    struct Response: Decodable, Sendable { let subscriptions: [PersonalSubscription] }
    let response: Response = try await client.request("/api/me/3rd-party-subscriptions")
    return response.subscriptions
  }
  public func activate(id: String) async throws {
    try await client.data(
      "/api/me/model-provider-accounts/\(id)/activate", method: "POST", body: Data("{}".utf8))
  }
  public func disconnect(id: String) async throws {
    try await client.data("/api/me/model-provider-accounts/\(id)", method: "DELETE")
  }
  public func reset(id: String, idempotencyKey: String) async throws -> String {
    struct Response: Decodable, Sendable { let outcome: String }
    let response: Response = try await client.request(
      "/api/me/model-provider-accounts/\(id)/subscription-reset",
      method: "POST", body: JSONEncoder().encode(["idempotencyKey": idempotencyKey]))
    return response.outcome
  }
  public func start(type: PersonalSubscriptionType, accountID: String?) async throws
    -> SubscriptionAuthSession
  {
    var body = ["scope": "personal", "mode": accountID == nil ? "add" : "reconnect"]
    body["modelProviderId"] = accountID
    return try await client.request(
      "/api/model-providers/\(type.authPath)/device-auth/sessions",
      method: "POST", body: JSONEncoder().encode(body))
  }
  public func complete(type: PersonalSubscriptionType, token: String, code: String? = nil)
    async throws -> SubscriptionAuthCompletion
  {
    var body = ["sessionToken": token]
    body["authorizationCode"] = code
    return try await client.request(
      "/api/model-providers/\(type.authPath)/device-auth/sessions/complete",
      method: "POST", body: JSONEncoder().encode(body))
  }
  public func cancel(type: PersonalSubscriptionType, token: String) async throws {
    try await client.data(
      "/api/model-providers/\(type.authPath)/device-auth/sessions/cancel",
      method: "POST", body: JSONEncoder().encode(["sessionToken": token]))
  }
}
