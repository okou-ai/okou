import CCStateSwiftUI
import ChatData
import SwiftUI

/// The chat's feedback above its bottom controls: the latest finished action, or a sync problem, in
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
    ZStack(alignment: .bottom) {
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

private struct ChatFeedbackAnchor: PreferenceKey {
  static var defaultValue: Anchor<CGRect>? { nil }

  static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) {
    value = nextValue() ?? value
  }
}

extension EnvironmentValues {
  @Entry var chatFeedbackHeight: CGFloat = 0
}

extension View {
  /// Anchor to the whole bottom bar, including a growing composer and its accessory controls.
  func chatFeedbackAnchor() -> some View {
    anchorPreference(key: ChatFeedbackAnchor.self, value: .bounds) { $0 }
  }

  func chatFeedbackOverlay(store: WorkspaceStore, isPresented: Bool) -> some View {
    modifier(ChatFeedbackOverlay(store: store, isPresented: isPresented))
  }
}

private struct ChatFeedbackOverlay: ViewModifier {
  let store: WorkspaceStore
  let isPresented: Bool
  @State private var feedbackHeight: CGFloat = 0

  func body(content: Content) -> some View {
    content
      .environment(\.chatFeedbackHeight, feedbackHeight)
      .overlayPreferenceValue(ChatFeedbackAnchor.self) { anchor in
        GeometryReader { geometry in
          if isPresented, let anchor {
            ChatFeedbackBanner(store: store)
              .onGeometryChange(for: CGFloat.self) {
                $0.size.height
              } action: {
                feedbackHeight = $0
              }
              .frame(maxHeight: .infinity, alignment: .bottom)
              .padding(.bottom, max(0, geometry.size.height - geometry[anchor].minY))
              .onDisappear { feedbackHeight = 0 }
          }
        }
      }
  }
}
