import ChatDomain
import Foundation

// Current contracts: turbo/packages/api-contracts/src/contracts/chat-threads.ts.
// These are the fields this client consumes; unrelated server fields are ignored.
enum ThreadSnapshot: Decodable, Sendable {
  case inline([ThreadProjection], latestEventId: String?, latestSeqId: Int?)
  case remote(URL, latestEventId: String?, latestSeqId: Int?)

  private enum CodingKeys: String, CodingKey { case chatThreads, url, latestEventId, latestSeqId }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let latestEventId = try container.decodeIfPresent(String.self, forKey: .latestEventId)
    let latestSeqId = try container.decodeIfPresent(Int.self, forKey: .latestSeqId)
    if container.contains(.url) {
      guard !container.contains(.chatThreads) else {
        throw DecodingError.dataCorruptedError(
          forKey: .url, in: container, debugDescription: "Ambiguous chat thread snapshot")
      }
      self = .remote(
        try container.decode(URL.self, forKey: .url), latestEventId: latestEventId,
        latestSeqId: latestSeqId)
    } else {
      self = .inline(
        try container.decode([ThreadProjection].self, forKey: .chatThreads),
        latestEventId: latestEventId, latestSeqId: latestSeqId)
    }
  }
}

struct ThreadSnapshotArchive: Codable, Sendable {
  let chatThreads: [ThreadProjection]
}

struct ThreadProjection: Codable, Sendable {
  let id: String
  let agentId: String
  let title: String?
  let selectedModel: String?
  let createdAt: Date
  let updatedAt: Date
  let sortAt: Date
  let pinnedAt: Date?
  let pinOrder: String?
  let archived: Bool?
  let renamedAt: Date?
  let modelSettings: [String: ThreadModelSetting]?
  let serviceTier: String?
  let computerUseHostId: String?
  let cloudBrowserEnabled: Bool?

  var thread: ChatThread {
    ChatThread(
      id: id, agentID: agentId, title: title ?? "", selectedModel: selectedModel,
      createdAt: createdAt, updatedAt: updatedAt, sortAt: sortAt,
      pinnedAt: pinnedAt, pinOrder: pinOrder, renamedAt: renamedAt,
      modelSettings: modelSettings ?? [:], serviceTier: serviceTier,
      computerUseHostId: computerUseHostId, cloudBrowserEnabled: cloudBrowserEnabled ?? false,
      isArchived: archived ?? false, indicator: nil)
  }
}

struct ThreadEventsPage: Decodable, Sendable {
  let events: [ThreadEvent]
  let hasMore: Bool
}

struct ThreadEvent: Codable, Sendable {
  let id: String
  let seqId: Int
  let kind: ChatThreadChange.Kind
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
  var change: ChatThreadChange {
    ChatThreadChange(
      kind: kind, chatThreadId: chatThreadId, agentId: agentId,
      reassignedAgentId: reassignedAgentId, title: title, selectedModel: selectedModel,
      pinOrder: pinOrder, modelSettings: modelSettings, modelSettingsPatch: modelSettingsPatch,
      serviceTier: serviceTier, computerUseHostId: computerUseHostId,
      cloudBrowserEnabled: cloudBrowserEnabled, createdAt: createdAt)
  }

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

public struct Indicators: Decodable, Sendable {
  public let threads: [String: ChatIndicator]
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

struct ChatEventRow: Decodable, Sendable {
  let id: String
  let chatThreadId: String
  let runId: String?
  let revokesEventId: String?
  let seqId: Int
  let createdAt: Date
  let eventType: ChatEventType
  let payload: ChatEvent.Payload?

  var event: ChatEvent {
    ChatEvent(
      id: id, runId: runId, revokesEventId: revokesEventId,
      createdAt: createdAt, eventType: eventType, payload: payload)
  }
}

public struct AgentRecord: Decodable, Sendable {
  public let agentId: String
  public let isDefaultAgent: Bool
  public let displayName: String?
}

public struct SidebarPreferences: Decodable, Sendable {
  public let pinnedAgentIds: [String]
}

public struct SidebarFeatureSwitches: Decodable, Sendable {
  public let effectiveSwitches: [String: Bool]
}

struct ModelPreference: Decodable, Sendable {
  let selectedModel: String?
  let serviceTier: String?
  let modelSettings: [String: ModelSetting]?

  struct ModelSetting: Decodable, Sendable {
    let effort: String?
  }
}

struct AvailableRunModels: Decodable, Sendable {
  let models: [Model]
  struct Model: Decodable, Sendable {
    /// Nil is Auto; any other value is a selectable subscription model.
    let model: String?
    let memberEffective: MemberRoute
    /// Present on personal-subscription rows only.
    let subscriptionOptions: SubscriptionOptions?

    struct MemberRoute: Decodable, Sendable {
      let availability: String
    }

    struct SubscriptionOptions: Decodable, Sendable {
      let serviceTier: String?
    }

    /// A member's connected subscription remains selectable when reconnecting.
    /// Admission still validates the captured personal account before execution.
    func hasUsableRoute() -> Bool {
      switch memberEffective.availability {
      case "available", "reconnect_required", "plan_restricted": return true
      default: return false
      }
    }

    /// Only subscription rows offer a service tier; Fast is `priority`.
    func supportsServiceTier(_ tier: String) -> Bool {
      tier == "priority" && subscriptionOptions?.serviceTier == "priority"
    }
  }
}

/// Personal-subscription metadata and replacement identities.
struct ModelCatalog: Decodable, Sendable {
  let models: [Model]

  struct Model: Decodable, Sendable {
    let model: String
    /// The active model a stored selection of this model resolves to.
    let resolvedModel: String
  }

  /// Maps a stored selection to its active model; unknown models are unavailable.
  func resolve(_ model: String) -> String? {
    models.first(where: { $0.model == model })?.resolvedModel
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

/// The send route never returns a run: the input is queued and its run (or
/// `input.rejected`) arrives later through the thread's event rows.
struct ChatSendResponse: Decodable, Sendable {
  let threadId: String
}
