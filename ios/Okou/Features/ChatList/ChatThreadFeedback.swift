import SwiftUI

struct ChatThreadFeedback: Identifiable {
  enum Kind {
    case operation, error
  }

  let id = UUID()
  let threadID: String
  let message: String
  let actionTitle: String?
  let persists: Bool
  let requiresNavigation: Bool
  let kind: Kind
  let action: @MainActor () async -> Void

  init(
    threadID: String, message: String, actionTitle: String?, persists: Bool = false,
    requiresNavigation: Bool = false, kind: Kind = .operation,
    action: @escaping @MainActor () async -> Void
  ) {
    self.threadID = threadID
    self.message = message
    self.actionTitle = actionTitle
    self.persists = persists
    self.requiresNavigation = requiresNavigation
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
      actionTitle: feedback.actionTitle,
      actionEnabled: store.list.canUpdate(feedback.threadID) && !store.needsUpgrade
        && (!feedback.requiresNavigation || !store.isCreating),
      action: {
        store.dismissThreadFeedback(feedback.id)
        Task { await feedback.action() }
      },
      dismiss: {
        store.dismissThreadFeedback(feedback.id)
      }
    )
    .task(id: feedback.id) {
      UIAccessibility.post(notification: .announcement, argument: feedback.message)
      guard !feedback.persists else { return }
      do {
        try await Task.sleep(for: .seconds(UIAccessibility.isVoiceOverRunning ? 20 : 4))
        store.dismissThreadFeedback(feedback.id)
      } catch {}
    }
  }
}
