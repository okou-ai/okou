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
  public let failureReason: String?
  public let payload: Payload?
  public let inputError: String?
  public let outputError: String?

  public init(
    id: String,
    runId: String? = nil,
    revokesEventId: String? = nil,
    createdAt: Date,
    eventType: ChatEventType,
    failureReason: String? = nil,
    payload: Payload? = nil,
    inputError: String? = nil,
    outputError: String? = nil
  ) {
    self.id = id
    self.runId = runId
    self.revokesEventId = revokesEventId
    self.createdAt = createdAt
    self.eventType = eventType
    self.failureReason = failureReason
    self.payload = eventType.isTerminal ? nil : payload
    self.inputError = eventType == .inputRejected ? inputError : nil
    self.outputError = eventType == .outputError ? outputError : nil
  }

  public struct Payload: Decodable, Sendable {
    public let content: String?
    public let userMessage: UserMessage?

    public init(
      content: String? = nil,
      userMessage: UserMessage? = nil
    ) {
      self.content = content
      self.userMessage = userMessage
    }
  }
  public typealias UserMessage = ChatUserMessage
}
