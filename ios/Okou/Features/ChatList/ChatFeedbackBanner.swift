import SwiftUI

/// The chat's feedback under the header: the latest finished action, or a sync problem, in
/// the design system's `ChatFeedbackSurface`.
struct ChatFeedbackBanner: View {
  let store: WorkspaceStore
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack(alignment: .top) {
      if let feedback = store.threadFeedback {
        ChatThreadFeedbackView(store: store, feedback: feedback)
          .id(feedback.id)
          .transition(.opacity)
          .zIndex(1)
      } else {
        ChatSyncStatusView(state: store.synchronizationState) {
          await store.retrySynchronization()
        }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .animation(reduceMotion ? nil : OkouMotion.press, value: store.threadFeedback?.id)
  }
}
