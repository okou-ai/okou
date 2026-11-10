import Foundation

public struct SidebarNavigationSnapshot: Codable, Sendable {
  public let agents: [AgentRecord]

  public init(agents: [AgentRecord]) {
    self.agents = agents
  }
}
