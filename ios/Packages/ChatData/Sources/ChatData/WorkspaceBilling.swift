import Foundation

public struct WorkspaceBilling: Decodable, Sendable {
  public let tier: String
  public let credits: Double
}

public struct WorkspaceCreditBalance: Sendable {
  public let personalCredits: Int
  public let canUseOrganizationCredits: Bool

  public func availableCredits(organizationCredits: Double) -> Double {
    Double(personalCredits) + (canUseOrganizationCredits ? max(organizationCredits, 0) : 0)
  }
}

public struct WorkspaceBillingService: Sendable {
  private let client: APIClient

  public init(client: APIClient) {
    self.client = client
  }

  public func status() async throws -> WorkspaceBilling {
    try await client.request("/api/billing/status")
  }

  public func creditBalance() async throws -> WorkspaceCreditBalance {
    struct Organization: Decodable, Sendable { let role: String }
    struct UsagePack: Decodable, Sendable { let totalCredits: Int }
    async let organization: Organization = client.request("/api/org")
    async let usagePack: UsagePack = client.request("/api/billing/usage-pack-credits")
    let (org, pack) = try await (organization, usagePack)
    return WorkspaceCreditBalance(
      personalCredits: pack.totalCredits, canUseOrganizationCredits: org.role == "admin")
  }
}
