import Foundation

public struct ChatBillingRecovery: Equatable, Sendable {
  public let canBuyCredits: Bool
  public let credits: Double
  public let canManageBilling: Bool
  public var hasCredits: Bool { canBuyCredits && credits > 0 }
}

extension ChatCommands {
  public func billingRecovery() async throws -> ChatBillingRecovery {
    struct Status: Decodable, Sendable {
      let canBuyCredits: Bool
      let credits: Double
    }
    struct Organization: Decodable, Sendable { let role: String }
    async let status: Status = client.request("/api/billing/status")
    async let organization: Organization = client.request("/api/org")
    let (billing, org) = try await (status, organization)
    return ChatBillingRecovery(
      canBuyCredits: billing.canBuyCredits, credits: billing.credits,
      canManageBilling: org.role == "admin")
  }
}
