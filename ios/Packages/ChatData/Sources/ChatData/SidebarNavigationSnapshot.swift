import Foundation

public struct SidebarNavigationSnapshot: Codable, Sendable {
  public let agents: [AgentRecord]
  public let preferences: SidebarPreferences

  public init(agents: [AgentRecord], preferences: SidebarPreferences) {
    self.agents = agents
    self.preferences = preferences
  }
}
