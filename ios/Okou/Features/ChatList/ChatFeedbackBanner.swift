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
  @LoadableValue private var listRead: Loadable<Void>

  init(store: WorkspaceStore) {
    self.store = store
    _navigationStatus = LoadableStatus(task: store.list.navigationValue)
    _listRead = LoadableValue(task: store.list.listValue)
  }

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var synchronizationState: ChatSynchronizationState? {
    if navigationStatus == .hasError { return .updateFailed }
    if listRead.state == .loading { return .updating }
    if listRead.error != nil { return .updateFailed }
    return store.synchronizationState
  }

  var body: some View {
    ZStack(alignment: .top) {
      if let feedback = store.threadFeedback {
        ChatThreadFeedbackView(store: store, feedback: feedback)
          .id(feedback.id)
          .transition(.opacity)
          .zIndex(1)
      } else {
        ChatSyncStatusView(
          state: synchronizationState
        ) {
          if navigationStatus == .hasError { await store.refreshNavigation() }
          if listRead.error != nil || store.synchronizationState?.isFailure == true {
            await store.retrySynchronization()
          }
        }
      }
    }
    .padding(.horizontal, OkouSpace.lg)
    .animation(reduceMotion ? nil : OkouMotion.press, value: store.threadFeedback?.id)
  }
}
