import SwiftUI

struct ChatThreadFeedback: Identifiable {
  let id = UUID()
  let threadID: String
  let message: String
  let actionTitle: String?
  let persists: Bool
  let action: @MainActor () async -> Void

  init(
    threadID: String, message: String, actionTitle: String?, persists: Bool = false,
    action: @escaping @MainActor () async -> Void
  ) {
    self.threadID = threadID
    self.message = message
    self.actionTitle = actionTitle
    self.persists = persists
    self.action = action
  }
}

struct ChatThreadFeedbackView: View {
  let store: WorkspaceStore
  let feedback: ChatThreadFeedback

  var body: some View {
    HStack(spacing: 12) {
      Text(feedback.message)
        .font(.subheadline)
        .fixedSize(horizontal: false, vertical: true)
      if let title = feedback.actionTitle {
        Button(title) {
          store.dismissThreadFeedback(feedback.id)
          Task { await feedback.action() }
        }
        .font(.subheadline.weight(.semibold))
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityIdentifier("chat-feedback-action")
        .disabled(!store.list.canUpdate(feedback.threadID) || store.needsUpgrade)
      }
      Button {
        store.dismissThreadFeedback(feedback.id)
      } label: {
        Image(systemName: "xmark").frame(width: 44, height: 44)
      }
      .accessibilityLabel("Dismiss chat feedback")
    }
    .padding(.leading, 16)
    .padding(.trailing, 4)
    .padding(.vertical, 8)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
    .padding(.horizontal, 16)
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
