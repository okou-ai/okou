import CCStateSwiftUI
import ChatData
import SwiftUI

/// The chat's feedback under the header: the latest finished action, or a sync problem, in
/// the design system's `ChatFeedbackSurface`.
struct ChatFeedbackBanner: View {
  let store: WorkspaceStore

  var body: some View {
    StoreProvider(store.list.stateStore) {
      ChatFeedbackBannerContent(store: store)
        .id(ObjectIdentifier(store))
    }
  }
}

private struct ChatFeedbackBannerContent: View {
  let store: WorkspaceStore
  @LoadableStatus<[AgentRecord]> private var navigationStatus: LoadableState

  init(store: WorkspaceStore) {
    self.store = store
    _navigationStatus = LoadableStatus(task: store.list.navigationValue)
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack(alignment: .top) {
      if let feedback = store.threadFeedback {
        ChatThreadFeedbackView(store: store, feedback: feedback)
          .id(feedback.id)
          .transition(.opacity)
          .zIndex(1)
      } else {
        ChatSyncStatusView(
          state: navigationStatus == .hasError ? .updateFailed : store.synchronizationState
        ) {
          if navigationStatus == .hasError { await store.refreshNavigation() }
          if store.synchronizationState?.isFailure == true { await store.retrySynchronization() }
        }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .animation(reduceMotion ? nil : OkouMotion.press, value: store.threadFeedback?.id)
  }
}
