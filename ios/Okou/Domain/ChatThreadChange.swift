import Foundation

struct ThreadModelSetting: Codable, Equatable, Sendable {
  let effort: String?
}

struct ThreadModelSettingsPatch: Codable, Sendable {
  let model: String
  let effort: String
}

struct ChatThreadChange: Sendable {
  enum Kind: String, Codable, Sendable {
    case created, renamed, deleted, pinned, unpinned
    case modelSelectionUpdated = "model_selection_updated"
    case serviceTierUpdated = "service_tier_updated"
    case computerUseHostUpdated = "computer_use_host_updated"
    case sortTouched = "sort_touched"
    case archived, unarchived
  }
  let kind: Kind
  let chatThreadId: String
  let agentId: String
  let reassignedAgentId: String?
  let title: String?
  let selectedModel: String?
  let pinOrder: String?
  let modelSettings: [String: ThreadModelSetting]?
  let modelSettingsPatch: ThreadModelSettingsPatch?
  let serviceTier: String?
  let computerUseHostId: String?
  let cloudBrowserEnabled: Bool?
  let createdAt: Date
}
