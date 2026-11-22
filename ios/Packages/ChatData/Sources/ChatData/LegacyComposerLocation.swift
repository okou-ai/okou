import Foundation

/// Reads the local composer key from the navigation snapshot saved by earlier installations.
public struct LegacyComposerLocation: Codable, Sendable {
  private struct Entry: Codable, Sendable {
    let agentId: String
    let isDefaultAgent: Bool
  }

  private let agents: [Entry]

  public var localID: String? { agents.first(where: \.isDefaultAgent)?.agentId }
}
