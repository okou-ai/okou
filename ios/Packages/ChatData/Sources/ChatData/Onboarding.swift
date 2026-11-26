import Foundation

public struct OnboardingStatus: Decodable, Sendable {
  public let needsOnboarding: Bool
  public let onboardingComplete: Bool
  public let isAdmin: Bool
  public let hasOrg: Bool
  public let nativeOnboardingEnabled: Bool
  public var presentsOnboarding: Bool { nativeOnboardingEnabled && needsOnboarding }
}

public enum OnboardingStep: String, Codable, CaseIterable, Sendable {
  case industry, sources, experience, skills, slack, capabilities, ready
}

public struct OnboardingDraft: Codable, Equatable, Sendable {
  public var answers = Answers()
  public var step: OnboardingStep? = .industry
  public var revision: String?
  public init() {}

  public struct Answers: Codable, Equatable, Sendable {
    public var industry: String?
    public var experienced: Bool?
    public var provider: String?
    public var startingPromptDraft = ""
    public var startingPromptKey = ""
    public var startingPromptOutput: Output?
    public var recommendationJobId: String?
    public var recommendationStartedAt: Double?
    public init() {}
    enum CodingKeys: String, CodingKey {
      case industry, experienced, provider, startingPromptDraft, startingPromptKey
      case startingPromptOutput, recommendationJobId, recommendationStartedAt
    }
    public func encode(to encoder: Encoder) throws {
      var values = encoder.container(keyedBy: CodingKeys.self)
      try values.encode(industry, forKey: .industry)
      try values.encode(experienced, forKey: .experienced)
      try values.encode(provider, forKey: .provider)
      try values.encode(startingPromptDraft, forKey: .startingPromptDraft)
      try values.encode(startingPromptKey, forKey: .startingPromptKey)
      try values.encode(startingPromptOutput, forKey: .startingPromptOutput)
      try values.encode(recommendationJobId, forKey: .recommendationJobId)
      try values.encode(recommendationStartedAt, forKey: .recommendationStartedAt)
    }
  }
  public struct Output: Codable, Equatable, Sendable {
    public let format: String
    public let start: Int
    public let end: Int
    public init(format: String, start: Int, end: Int) {
      self.format = format
      self.start = start
      self.end = end
    }
  }
}

public struct OnboardingSource: Decodable, Identifiable, Sendable {
  public let slug: String
  public let label: String
  public let description: String
  public let icon: ChatConnectorIcon?
  public let authMethods: [ChatConnectorMethod]
  public var id: String { slug }
}

public struct OnboardingRecommendation: Decodable, Sendable {
  public let jobId: String
  public let status: String
  public let recommendation: Recommendation?
  public struct Recommendation: Decodable, Sendable {
    public let title: String
    public let outcome: String
    public let prompt: String
    public let profile: Profile
  }
  public struct Profile: Decodable, Sendable {
    public let overview: String
  }
}

/// The Web and native flows write the same member-scoped draft and completion.
public struct OnboardingService: Sendable {
  private let client: APIClient
  public init(client: APIClient) { self.client = client }

  public func status() async throws -> OnboardingStatus {
    try await client.request("/api/onboarding/status")
  }

  public func draft() async throws -> OnboardingDraft? {
    struct Response: Decodable, Sendable { let draft: OnboardingDraft? }
    let response: Response = try await client.request("/api/onboarding/draft")
    return response.draft
  }

  public func save(_ draft: OnboardingDraft) async throws -> String {
    // The API distinguishes a new draft (explicit null revision) from a stale write.
    struct Body: Encodable {
      let draft: OnboardingDraft
      enum CodingKeys: String, CodingKey { case answers, step, revision }
      func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(draft.answers, forKey: .answers)
        try values.encode(draft.step, forKey: .step)
        try values.encode(draft.revision, forKey: .revision)
      }
    }
    struct Response: Decodable, Sendable { let revision: String }
    let response: Response = try await client.request(
      "/api/onboarding/draft", method: "PUT", body: JSONEncoder().encode(Body(draft: draft)))
    return response.revision
  }

  public func complete(industry: String?, timezone: String) async throws -> OnboardingStatus {
    struct Body: Encodable {
      let industry: String?
      let timezone: String
    }
    struct Response: Decodable, Sendable {
      let onboardingComplete: Bool
      let needsOnboarding: Bool
    }
    let _: Response = try await client.request(
      "/api/onboarding/complete", method: "POST",
      body: JSONEncoder().encode(Body(industry: industry, timezone: timezone)))
    // A confirmed read also recovers completion after an earlier response was lost.
    return try await status()
  }

  public func sources() async throws -> [OnboardingSource] {
    struct Response: Decodable, Sendable { let connectors: [OnboardingSource] }
    let response: Response = try await client.request("/api/onboarding/sources")
    return response.connectors
  }

  public func startRecommendation(industry: String, locale: String) async throws -> String {
    struct Body: Encodable {
      let industry: String
      let locale: String
    }
    struct Response: Decodable, Sendable { let jobId: String }
    let response: Response = try await client.request(
      "/api/onboarding/recommendations", method: "POST",
      body: JSONEncoder().encode(Body(industry: industry, locale: locale)))
    return response.jobId
  }

  public func recommendation(_ id: String) async throws -> OnboardingRecommendation {
    try await client.request("/api/onboarding/recommendations/\(id)")
  }

}
