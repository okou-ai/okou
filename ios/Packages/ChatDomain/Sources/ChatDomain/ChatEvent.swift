import Foundation

public enum ChatEventType: String, Decodable, Sendable {
  case inputPrompt = "input.prompt"
  case inputAutomation = "input.automation"
  case inputBudget = "input.budget"
  case inputRejected = "input.rejected"
  case outputMessage = "output.message"
  case outputError = "output.error"
  case outputFollowups = "output.followups"
  case runCompleted = "run.completed"
  case runFailed = "run.failed"
  case runCancelled = "run.cancelled"
  case controlInterrupt = "control.interrupt"
  case controlRevoke = "control.revoke"
  case usageRecorded = "usage.recorded"

  public var isTerminal: Bool {
    self == .runCompleted || self == .runFailed || self == .runCancelled
  }
}

/// Facts used by the projection; HTTP pagination and synchronization cursors stay outside it.
public struct ChatEvent: Sendable {
  public let id: String
  public let runId: String?
  public let revokesEventId: String?
  public let createdAt: Date
  public let eventType: ChatEventType
  public let payload: Payload?

  public init(
    id: String,
    runId: String? = nil,
    revokesEventId: String? = nil,
    createdAt: Date,
    eventType: ChatEventType,
    payload: Payload? = nil
  ) {
    self.id = id
    self.runId = runId
    self.revokesEventId = revokesEventId
    self.createdAt = createdAt
    self.eventType = eventType
    self.payload = payload
  }

  public struct Payload: Decodable, Sendable {
    public let content: String?
    public let error: String?
    public let userMessage: UserMessage?

    public init(
      content: String? = nil,
      error: String? = nil,
      userMessage: UserMessage? = nil
    ) {
      self.content = content
      self.error = error
      self.userMessage = userMessage
    }
  }
  public struct UserMessage: Decodable, Sendable {
    public let version: Int
    public let parts: [Part]

    public init(
      version: Int,
      parts: [Part]
    ) {
      self.version = version
      self.parts = parts
    }
    public struct Part: Decodable, Sendable {
      public let type: String
      public let text: String?
      public let titleSnapshot: String?
      public let nameSnapshot: String?
      public let filenameSnapshot: String?
      public let workflowName: String?

      public init(
        type: String,
        text: String? = nil,
        titleSnapshot: String? = nil,
        nameSnapshot: String? = nil,
        filenameSnapshot: String? = nil,
        workflowName: String? = nil
      ) {
        self.type = type
        self.text = text
        self.titleSnapshot = titleSnapshot
        self.nameSnapshot = nameSnapshot
        self.filenameSnapshot = filenameSnapshot
        self.workflowName = workflowName
      }
    }
  }
}
