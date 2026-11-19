import SwiftUI

struct ChatThreadFeedback: Identifiable {
  enum Kind {
    case operation, error
  }

  let id = UUID()
  let threadID: String
  let message: String
  let actionTitle: String?
  let actionHint: String
  let persists: Bool
  let requiresNavigation: Bool
  /// The action targets a chat its own pending change hides from the list (a delete retry).
  let actsOnHiddenChat: Bool
  let isWorking: Bool
  let kind: Kind
  let action: @MainActor () async -> Void

  init(
    threadID: String, message: String, actionTitle: String?, actionHint: String = "",
    persists: Bool = false, requiresNavigation: Bool = false, actsOnHiddenChat: Bool = false,
    isWorking: Bool = false, kind: Kind = .operation,
    action: @escaping @MainActor () async -> Void
  ) {
    self.threadID = threadID
    self.message = message
    self.actionTitle = actionTitle
    self.actionHint = actionHint
    self.persists = persists
    self.requiresNavigation = requiresNavigation
    self.actsOnHiddenChat = actsOnHiddenChat
    self.isWorking = isWorking
    self.kind = kind
    self.action = action
  }
}

struct ChatThreadFeedbackView: View {
  let store: WorkspaceStore
  let feedback: ChatThreadFeedback

  var body: some View {
    ChatFeedbackSurface(
      message: feedback.message,
      icon: feedback.kind == .error ? "circle-alert" : "circle-check",
      isWorking: feedback.isWorking,
      actionTitle: feedback.actionTitle,
      actionEnabled: (feedback.actsOnHiddenChat
        ? store.list.canWrite(feedback.threadID) : store.list.canUpdate(feedback.threadID))
        && !store.needsUpgrade
        && (!feedback.requiresNavigation || !store.isCreating),
      actionHint: feedback.actionHint,
      autoDismissAfter: feedback.persists ? nil : .seconds(6),
      action: {
        store.dismissThreadFeedback(feedback.id)
        Task { await feedback.action() }
      },
      dismiss: {
        store.dismissThreadFeedback(feedback.id)
      }
    )
  }
}
