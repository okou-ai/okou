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
  struct Placement {
    var bar: Anchor<CGRect>?
    var controls: [Anchor<CGRect>] = []
  }

  static var defaultValue: Placement { Placement() }

  static func reduce(value: inout Placement, nextValue: () -> Placement) {
    let next = nextValue()
    value.bar = next.bar ?? value.bar
    value.controls.append(contentsOf: next.controls)
  }
}

extension EnvironmentValues {
  @Entry var chatFeedbackClearance: CGFloat = 0
}

extension View {
  /// Keep the layout boundary separate from controls whose hidden rows still reserve space.
  func chatFeedbackAnchor() -> some View {
    transformAnchorPreference(key: ChatFeedbackAnchor.self, value: .bounds) { placement, bounds in
      placement.bar = bounds
    }
  }

  func chatFeedbackContentAnchor(isPresented: Bool = true) -> some View {
    transformAnchorPreference(key: ChatFeedbackAnchor.self, value: .bounds) { placement, bounds in
      if isPresented { placement.controls.append(bounds) }
    }
  }

  func chatFeedbackOverlay(store: WorkspaceStore, isPresented: Bool) -> some View {
    modifier(ChatFeedbackOverlay(store: store, isPresented: isPresented))
  }
}

private struct ChatFeedbackOverlay: ViewModifier {
  let store: WorkspaceStore
  let isPresented: Bool
  @State private var feedbackClearance: CGFloat = 0

  func body(content: Content) -> some View {
    content
      .environment(\.chatFeedbackClearance, feedbackClearance)
      .overlayPreferenceValue(ChatFeedbackAnchor.self) { anchors in
        GeometryReader { geometry in
          if isPresented, let bar = anchors.bar {
            let barTop = geometry[bar].minY
            let visibleTop =
              anchors.controls.map { geometry[$0] }
              .filter { !$0.isEmpty }.map(\.minY).min() ?? barTop
            let hiddenTopSpace = max(0, visibleTop - barTop)
            ChatFeedbackBanner(store: store)
              .onGeometryChange(for: CGFloat.self) {
                max(0, $0.size.height - hiddenTopSpace)
              } action: {
                feedbackClearance = $0
              }
              .frame(maxHeight: .infinity, alignment: .bottom)
              .padding(.bottom, max(0, geometry.size.height - visibleTop))
              .onDisappear { feedbackClearance = 0 }
          }
        }
      }
  }
}
