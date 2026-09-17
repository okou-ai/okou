import Foundation

// Current contracts: turbo/packages/api-contracts/src/contracts/chat-threads.ts.
// These are the fields this client consumes; unrelated server fields are ignored.
struct ThreadSnapshot: Decodable, Sendable {
  let chatThreads: [ThreadProjection]
  let latestSeqId: Int?
}

struct ThreadProjection: Decodable, Sendable {
  let id: String
  let agentId: String
  let title: String?
  let selectedModel: String?
  let createdAt: Date
  let updatedAt: Date
  let sortAt: Date
  let pinnedAt: Date?
  let pinOrder: String?

  var thread: ChatThread {
    ChatThread(
      id: id, agentID: agentId, title: title ?? "", selectedModel: selectedModel,
      createdAt: createdAt, updatedAt: updatedAt, sortAt: sortAt,
      pinnedAt: pinnedAt, pinOrder: pinOrder, indicator: nil)
  }
}

struct ThreadEventsPage: Decodable, Sendable {
  let events: [ThreadEvent]
  let hasMore: Bool
}

struct ThreadEvent: Decodable, Sendable {
  enum Kind: String, Decodable, Sendable {
    case created, renamed, deleted, pinned, unpinned
    case modelSelectionUpdated = "model_selection_updated"
    case serviceTierUpdated = "service_tier_updated"
    case computerUseHostUpdated = "computer_use_host_updated"
    case videoModelUpdated = "video_model_updated"
    case imageModelUpdated = "image_model_updated"
    case sortTouched = "sort_touched"
  }
  let id: String
  let seqId: Int
  let kind: Kind
  let chatThreadId: String
  let agentId: String
  let title: String?
  let selectedModel: String?
  let pinOrder: String?
  let createdAt: Date
}

struct ThreadMetadata: Decodable, Sendable {
  let id: String
  let agentId: String
  let title: String?
  let selectedModel: String?
  let computerUseHostId: String?
  let cloudBrowserEnabled: Bool
}

struct ThreadDetail: Decodable, Sendable {
  let cancellationRecoveryPending: Bool
}

struct Indicators: Decodable, Sendable {
  let threads: [String: ChatIndicator]
}

struct EventCursor: Decodable, Equatable, Sendable {
  let lastEventId: String?
  let lastSeqId: Int
  static let start = EventCursor(lastEventId: nil, lastSeqId: 0)

  var isValid: Bool { lastSeqId == 0 ? lastEventId == nil : lastSeqId > 0 && lastEventId != nil }
}

struct EventSnapshot: Decodable, Sendable {
  let url: URL
  let lastEventId: String?
  let lastSeqId: Int
  var cursor: EventCursor { EventCursor(lastEventId: lastEventId, lastSeqId: lastSeqId) }
}

struct EventRowsPage: Decodable, Sendable {
  let rows: [ChatEventRow]
  let cursor: EventCursor
  let hasMore: Bool
}

enum ChatEventType: String, Decodable, Sendable {
  case inputPrompt = "input.prompt"
  case inputAutomation = "input.automation"
  case inputGoal = "input.goal"
  case inputBudget = "input.budget"
  case inputRejected = "input.rejected"
  case outputMessage = "output.message"
  case outputError = "output.error"
  case outputThinking = "output.thinking"
  case outputFollowups = "output.followups"
  case runQueued = "run.queued"
  case runDequeued = "run.dequeued"
  case runCompleted = "run.completed"
  case runFailed = "run.failed"
  case runCancelled = "run.cancelled"
  case controlInterrupt = "control.interrupt"
  case controlRevoke = "control.revoke"
  case browserOpen = "browser.open"
  case browserClose = "browser.close"
  case goalOpen = "goal.open"
  case goalClose = "goal.close"
  case usageRecorded = "usage.recorded"

  var isTerminal: Bool { self == .runCompleted || self == .runFailed || self == .runCancelled }
}

struct ChatEventRow: Decodable, Sendable {
  let id: String
  let chatThreadId: String
  let runId: String?
  let revokesEventId: String?
  let seqId: Int
  let createdAt: Date
  let eventType: ChatEventType
  let payload: Payload?

  struct Payload: Decodable, Sendable {
    let content: String?
    let error: String?
    let userMessage: UserMessage?
  }
  struct UserMessage: Decodable, Sendable {
    let version: Int
    let parts: [Part]
    struct Part: Decodable, Sendable {
      let type: String
      let text: String?
      let titleSnapshot: String?
      let nameSnapshot: String?
      let filenameSnapshot: String?
      let workflowName: String?
    }
  }
}

struct AgentRecord: Decodable, Sendable {
  let agentId: String
  let isDefaultAgent: Bool
}

struct ModelPreference: Decodable, Sendable {
  let selectedModel: String?
  let serviceTier: String?
  let modelSettings: [String: ModelSetting]?

  struct ModelSetting: Decodable, Sendable {
    let effort: String?
  }
}

struct ModelPolicies: Decodable, Sendable {
  let workspaceDefaultModel: String?
  let policies: [Policy]
  struct Policy: Decodable, Sendable {
    let model: String
    let isDefault: Bool
    let routeStatus: String
  }
}

struct CreatedThread: Decodable, Sendable {
  let id: String
  let title: String?
  let createdAt: Date
  let selectedModel: String?
}

struct ConnectorSelections: Decodable, Sendable {
  let selections: [Selection]
  struct Selection: Decodable, Sendable {
    let target: Target
  }
  enum Target: Codable, Sendable {
    case builtin(String)
    case custom(String)
    private enum CodingKeys: String, CodingKey { case kind, connectorSlug, customConnectorId }

    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      switch try container.decode(String.self, forKey: .kind) {
      case "builtin": self = .builtin(try container.decode(String.self, forKey: .connectorSlug))
      case "custom": self = .custom(try container.decode(String.self, forKey: .customConnectorId))
      default:
        throw DecodingError.dataCorruptedError(
          forKey: .kind, in: container, debugDescription: "Unknown connector target")
      }
    }

    func encode(to encoder: Encoder) throws {
      var container = encoder.container(keyedBy: CodingKeys.self)
      switch self {
      case .builtin(let slug):
        try container.encode("builtin", forKey: .kind)
        try container.encode(slug, forKey: .connectorSlug)
      case .custom(let id):
        try container.encode("custom", forKey: .kind)
        try container.encode(id, forKey: .customConnectorId)
      }
    }
  }
}

struct ChatSendResponse: Decodable, Sendable {
  let runId: String?
  let threadId: String
}
