import SwiftUI

struct ChatThreadFeedback: Identifiable {
  let id = UUID()
  let threadID: String
  let message: String
  let actionTitle: String?
  let persists: Bool
  let requiresNavigation: Bool
  let action: @MainActor () async -> Void

  init(
    threadID: String, message: String, actionTitle: String?, persists: Bool = false,
    requiresNavigation: Bool = false,
    action: @escaping @MainActor () async -> Void
  ) {
    self.threadID = threadID
    self.message = message
    self.actionTitle = actionTitle
    self.persists = persists
    self.requiresNavigation = requiresNavigation
    self.action = action
  }
}

struct ChatThreadFeedbackView: View {
  let store: WorkspaceStore
  let feedback: ChatThreadFeedback

  var body: some View {
    OkouToast(feedback.message, dismiss: { store.dismissThreadFeedback(feedback.id) }) {
      if let title = feedback.actionTitle {
        Button(title) {
          store.dismissThreadFeedback(feedback.id)
          Task { await feedback.action() }
        }
        .frame(minWidth: OkouControl.minimumTarget)
        .accessibilityIdentifier("chat-feedback-action")
        .disabled(
          !store.list.canUpdate(feedback.threadID) || store.needsUpgrade
            || (feedback.requiresNavigation && store.isCreating))
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .accessibilityElement(children: .contain)
    .task(id: feedback.id) {
      UIAccessibility.post(notification: .announcement, argument: feedback.message)
      guard !feedback.persists else { return }
      do {
        try await Task.sleep(for: .seconds(UIAccessibility.isVoiceOverRunning ? 20 : 8))
        store.dismissThreadFeedback(feedback.id)
      } catch {}
    }
  }
}
