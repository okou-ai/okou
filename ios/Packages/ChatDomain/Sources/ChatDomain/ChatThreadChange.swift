import Foundation

public struct ThreadModelSetting: Codable, Equatable, Sendable {
  public let effort: String?

  public init(
    effort: String? = nil
  ) {
    self.effort = effort
  }
}

public struct ThreadModelSettingsPatch: Codable, Sendable {
  public let model: String
  public let effort: String

  public init(
    model: String,
    effort: String
  ) {
    self.model = model
    self.effort = effort
  }
}

public struct ChatThreadChange: Sendable {
  public enum Kind: String, Codable, Sendable {
    case created, renamed, deleted, pinned, unpinned
    case modelSelectionUpdated = "model_selection_updated"
    case serviceTierUpdated = "service_tier_updated"
    case computerUseHostUpdated = "computer_use_host_updated"
    case sortTouched = "sort_touched"
    case archived, unarchived
  }
  public let kind: Kind
  public let chatThreadId: String
  public let agentId: String
  public let reassignedAgentId: String?
  public let title: String?
  public let selectedModel: String?
  public let pinOrder: String?
  public let modelSettings: [String: ThreadModelSetting]?
  public let modelSettingsPatch: ThreadModelSettingsPatch?
  public let serviceTier: String?
  public let computerUseHostId: String?
  public let cloudBrowserEnabled: Bool?
  public let createdAt: Date

  public init(
    kind: Kind,
    chatThreadId: String,
    agentId: String,
    reassignedAgentId: String? = nil,
    title: String? = nil,
    selectedModel: String? = nil,
    pinOrder: String? = nil,
    modelSettings: [String: ThreadModelSetting]? = nil,
    modelSettingsPatch: ThreadModelSettingsPatch? = nil,
    serviceTier: String? = nil,
    computerUseHostId: String? = nil,
    cloudBrowserEnabled: Bool? = nil,
    createdAt: Date
  ) {
    self.kind = kind
    self.chatThreadId = chatThreadId
    self.agentId = agentId
    self.reassignedAgentId = reassignedAgentId
    self.title = title
    self.selectedModel = selectedModel
    self.pinOrder = pinOrder
    self.modelSettings = modelSettings
    self.modelSettingsPatch = modelSettingsPatch
    self.serviceTier = serviceTier
    self.computerUseHostId = computerUseHostId
    self.cloudBrowserEnabled = cloudBrowserEnabled
    self.createdAt = createdAt
  }
}
