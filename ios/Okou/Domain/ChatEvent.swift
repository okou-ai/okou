import Foundation

enum ChatEventType: String, Decodable, Sendable {
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

  var isTerminal: Bool { self == .runCompleted || self == .runFailed || self == .runCancelled }
}

/// Facts used by the projection; HTTP pagination and synchronization cursors stay outside it.
struct ChatEvent: Sendable {
  let id: String
  let runId: String?
  let revokesEventId: String?
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
