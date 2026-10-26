import Foundation

public struct SidebarNavigationSnapshot: Codable, Sendable {
  public let agents: [AgentRecord]
  public let preferences: SidebarPreferences
  public let featureSwitches: SidebarFeatureSwitches

  public init(
    agents: [AgentRecord], preferences: SidebarPreferences,
    featureSwitches: SidebarFeatureSwitches
  ) {
    self.agents = agents
    self.preferences = preferences
    self.featureSwitches = featureSwitches
  }
}
