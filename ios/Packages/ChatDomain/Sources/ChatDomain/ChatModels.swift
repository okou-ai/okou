import Foundation

public struct ChatThread: Identifiable, Equatable, Sendable {
  public let id: String
  public var agentID: String
  public var title: String
  public var selectedModel: String?
  public var createdAt: Date
  public var updatedAt: Date
  public var sortAt: Date
  public var pinnedAt: Date?
  public var pinOrder: String?
  public var renamedAt: Date? = nil
  public var modelSettings: [String: ThreadModelSetting] = [:]
  public var serviceTier: String? = nil
  public var computerUseHostId: String? = nil
  public var cloudBrowserEnabled = false
  public var isArchived = false
  public var isHidden = false
  public var indicator: ChatIndicator?
  public var unreadAt: Date?
  public var isMuted: Bool
  public var isUnread: Bool { unreadAt != nil && !isMuted }

  public init(
    id: String,
    agentID: String,
    title: String,
    selectedModel: String? = nil,
    createdAt: Date,
    updatedAt: Date,
    sortAt: Date,
    pinnedAt: Date? = nil,
    pinOrder: String? = nil,
    renamedAt: Date? = nil,
    modelSettings: [String: ThreadModelSetting] = [:],
    serviceTier: String? = nil,
    computerUseHostId: String? = nil,
    cloudBrowserEnabled: Bool = false,
    isArchived: Bool = false,
    isHidden: Bool = false,
    indicator: ChatIndicator? = nil,
    unreadAt: Date? = nil,
    isMuted: Bool = false
  ) {
    self.id = id
    self.agentID = agentID
    self.title = title
    self.selectedModel = selectedModel
    self.createdAt = createdAt
    self.updatedAt = updatedAt
    self.sortAt = sortAt
    self.pinnedAt = pinnedAt
    self.pinOrder = pinOrder
    self.renamedAt = renamedAt
    self.modelSettings = modelSettings
    self.serviceTier = serviceTier
    self.computerUseHostId = computerUseHostId
    self.cloudBrowserEnabled = cloudBrowserEnabled
    self.isArchived = isArchived
    self.isHidden = isHidden
    self.indicator = indicator
    self.unreadAt = unreadAt
    self.isMuted = isMuted
  }

  public var displayTitle: String { title.isEmpty ? "New chat" : title }
}

public enum ChatIndicator: String, Decodable, Sendable {
  case active, unread
}

/// Durable file identity and display snapshots; temporary download URLs never enter history.
public struct ChatMessageAttachment: Equatable, Identifiable, Sendable {
  public let id: String
  public let filename: String
  public let contentType: String
  public let size: Int?
  public let renderedFileID: String?
  public var downloadID: String { renderedFileID ?? id }

  public init(
    id: String, filename: String, contentType: String, size: Int? = nil,
    renderedFileID: String? = nil
  ) {
    self.id = id
    self.filename = filename
    self.contentType = contentType
    self.size = size
    self.renderedFileID = renderedFileID
  }
}

public struct ChatMessage: Identifiable, Equatable, Sendable {
  public enum Role: String, Sendable { case user, assistant, system }

  public let id: String
  public let role: Role
  public let text: String
  public let attachments: [ChatMessageAttachment]
  public let createdAt: Date
  public let runID: String?
  public let isQueued: Bool
  public let isError: Bool
  public let userMessage: ChatUserMessage?
  public let inputError: String?
  public let modelChange: ChatModelChange?
  public var copyText: String { userMessage?.displayText ?? text }
  public let failure: ChatFailure?

  public init(
    id: String,
    role: Role,
    text: String,
    attachments: [ChatMessageAttachment] = [],
    createdAt: Date,
    runID: String? = nil,
    isQueued: Bool,
    isError: Bool,
    userMessage: ChatUserMessage? = nil, inputError: String? = nil,
    modelChange: ChatModelChange? = nil,
    failure: ChatFailure? = nil
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.attachments = attachments
    self.createdAt = createdAt
    self.runID = runID
    self.isQueued = isQueued
    self.isError = isError
    self.userMessage = userMessage
    self.inputError = inputError
    self.modelChange = modelChange
    self.failure = failure
  }
}

public enum ChatExecutionState: String, Equatable, Sendable {
  case idle, queued, running, stopping, recovering, completed, failed, cancelled

  public var isActive: Bool {
    switch self {
    case .queued, .running, .stopping, .recovering: true
    case .idle, .completed, .failed, .cancelled: false
    }
  }

  public var label: String {
    switch self {
    case .idle: "Ready"
    case .queued: "Waiting in queue..."
    case .running: "Thinking..."
    case .stopping: "Stopping"
    case .recovering: "Finishing cancellation"
    case .completed: "Completed"
    case .failed: "Failed"
    case .cancelled: "Stopped"
    }
  }
}

public struct ChatHistory: Equatable, Sendable {
  public let messages: [ChatMessage]
  public let workSections: [ChatWorkSection]
  public let executionState: ChatExecutionState
  public let activeRunIDs: [String]
  public let activityRunID: String?
  public let queuedEventIDs: [String]
  public var persistedEventIDs: Set<String> = []
  public let latestRunFinishAt: Date?
  public let latestFailureID: String?
  public let recommendedFollowups: ChatRecommendedFollowupSource?
  public let usageEventIDs: [String: String]
  public let runUsageAnchors: [String: String]

  public init(
    messages: [ChatMessage],
    executionState: ChatExecutionState,
    activeRunIDs: [String],
    activityRunID: String? = nil,
    queuedEventIDs: [String],
    persistedEventIDs: Set<String> = [],
    workSections: [ChatWorkSection] = [],
    latestRunFinishAt: Date? = nil,
    latestFailureID: String? = nil,
    recommendedFollowups: ChatRecommendedFollowupSource? = nil,
    usageEventIDs: [String: String] = [:],
    runUsageAnchors: [String: String] = [:]
  ) {
    self.messages = messages
    self.workSections = workSections
    self.latestRunFinishAt = latestRunFinishAt
    self.latestFailureID = latestFailureID
    self.recommendedFollowups = recommendedFollowups
    self.usageEventIDs = usageEventIDs
    self.runUsageAnchors = runUsageAnchors
    self.executionState = executionState
    self.activeRunIDs = activeRunIDs
    self.activityRunID = activityRunID
    self.queuedEventIDs = queuedEventIDs
    self.persistedEventIDs = persistedEventIDs
  }

  public static let empty = ChatHistory(
    messages: [], executionState: .idle, activeRunIDs: [], queuedEventIDs: [])
  public var canStop: Bool { !activeRunIDs.isEmpty || !queuedEventIDs.isEmpty }
}

/// One contiguous run phase, bounded by user inputs rather than the run's lifetime.
public struct ChatWorkSection: Equatable, Identifiable, Sendable {
  public let id: String
  public let anchorMessageID: String
  public let hiddenMessageIDs: [String]
  public let stepCount: Int
  public let startTime: Date
  public let endTime: Date?

  public var isCollapsible: Bool { stepCount > 0 }
}

public struct SendReceipt: Sendable {
  public let threadID: String
  public let clientEventID: String

  public init(
    threadID: String,
    clientEventID: String
  ) {
    self.threadID = threadID
    self.clientEventID = clientEventID
  }
}

public enum ChatError: LocalizedError, Sendable {
  case noDefaultAgent
  case agentUnavailable
  case invalidContract(String)
  case settingsChanged
  case operationInProgress
  case sendUncertain(String)

  public var errorDescription: String? {
    switch self {
    case .noDefaultAgent:
      "This workspace has no default agent. Complete setup on the Okou website, then refresh."
    case .agentUnavailable:
      "This agent is no longer available. Choose another agent and try again."
    case .invalidContract(let detail):
      "Chat data could not be read. Refresh or update the TestFlight app. \(detail)"
    case .settingsChanged:
      "Chat settings changed while preparing your message. Refresh and try again."
    case .operationInProgress:
      "Another chat action is still in progress. Wait for it to finish."
    case .sendUncertain(let detail):
      "The message may have been accepted. Refresh this chat before sending again. \(detail)"
    }
  }
}
