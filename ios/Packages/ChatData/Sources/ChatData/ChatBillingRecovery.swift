import Foundation

public struct ChatBillingRecovery: Decodable, Equatable, Sendable {
  private let canBuyCredits: Bool
  private let credits: Double
  public var hasCredits: Bool { canBuyCredits && credits > 0 }
}

extension ChatCommands {
  public func billingRecovery() async throws -> ChatBillingRecovery {
    try await client.request("/api/billing/status")
  }
}
