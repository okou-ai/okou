import Foundation

public struct WorkspaceBilling: Decodable, Sendable {
  public let tier: String
}

public struct WorkspaceBillingService: Sendable {
  private let client: APIClient

  public init(client: APIClient) {
    self.client = client
  }

  public func status() async throws -> WorkspaceBilling {
    try await client.request("/api/billing/status")
  }
}
