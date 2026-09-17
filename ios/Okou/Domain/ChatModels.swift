import Foundation

struct ChatThread: Identifiable, Equatable, Sendable {
  let id: String
  let agentID: String
  var title: String
  var selectedModel: String?
  var createdAt: Date
  var updatedAt: Date
  var sortAt: Date
  var pinnedAt: Date?
  var pinOrder: String?
  var indicator: ChatIndicator?

  var displayTitle: String { title.isEmpty ? "New chat" : title }
}

enum ChatIndicator: String, Decodable, Sendable {
  case active, unread
}

struct ChatMessage: Identifiable, Equatable, Sendable {
  enum Role: String, Sendable { case user, assistant, system }

  let id: String
  let role: Role
  let text: String
  let createdAt: Date
  let runID: String?
  let isQueued: Bool
  let isError: Bool
}

enum ChatExecutionState: String, Equatable, Sendable {
  case idle, queued, running, stopping, recovering, completed, failed, cancelled

  var isActive: Bool {
    switch self {
    case .queued, .running, .stopping, .recovering: true
    case .idle, .completed, .failed, .cancelled: false
    }
  }

  var label: String {
    switch self {
    case .idle: "Ready"
    case .queued: "Starting"
    case .running: "Working"
    case .stopping: "Stopping"
    case .recovering: "Finishing cancellation"
    case .completed: "Completed"
    case .failed: "Failed"
    case .cancelled: "Stopped"
    }
  }
}

struct ChatHistory: Equatable, Sendable {
  let messages: [ChatMessage]
  let executionState: ChatExecutionState
  let activeRunIDs: [String]
  let queuedEventIDs: [String]
  var persistedEventIDs: Set<String> = []

  static let empty = ChatHistory(
    messages: [], executionState: .idle, activeRunIDs: [], queuedEventIDs: [])
  var canStop: Bool { !activeRunIDs.isEmpty || !queuedEventIDs.isEmpty }
}

struct SendReceipt: Sendable {
  let threadID: String
  let runID: String?
  let clientEventID: String
}

enum ChatServiceError: LocalizedError, Sendable {
  case noDefaultAgent
  case noDefaultModel
  case invalidContract(String)
  case settingsChanged
  case operationInProgress
  case sendUncertain(String)

  var errorDescription: String? {
    switch self {
    case .noDefaultAgent:
      "This workspace has no default agent. Complete setup on the Okou website, then refresh."
    case .noDefaultModel:
      "This workspace has no default model. Choose one on the Okou website, then refresh."
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
