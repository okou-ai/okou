import CCStateSwiftUI
import SwiftUI

extension View {
  /// Presents the store's authorization attempt and reports a failed activation under
  /// `failureTitle`.
  func connectorAuthorization(
    store: ConnectorActionStore, failureTitle: LocalizedStringKey
  ) -> some View {
    modifier(ConnectorAuthorizationPresentation(store: store, failureTitle: failureTitle))
  }
}

private struct ConnectorAuthorizationPresentation: ViewModifier {
  @Environment(\.scenePhase) private var scenePhase
  let store: ConnectorActionStore
  let failureTitle: LocalizedStringKey
  /// The attempt and an activation failure, kept in the workspace session's Store.
  @ResolvedValue private var resolvedPresentation: ConnectorActionStore.Presentation?

  init(store: ConnectorActionStore, failureTitle: LocalizedStringKey) {
    self.store = store
    self.failureTitle = failureTitle
    _resolvedPresentation = ResolvedValue(store.presentationValue)
  }

  func body(content: Content) -> some View {
    let presentation = resolvedPresentation ?? store.presentation
    let form = presentation.active.flatMap { $0.presentsForm ? $0 : nil }
    let failure = presentation.activationError
    content
      .sheet(
        item: Binding(
          get: { form },
          set: { if $0 == nil, store.active?.presentsForm == true { store.cancel() } })
      ) { flow in
        ConnectorAuthorizationSheet(flow: flow, store: store)
          .okouSheetBackground()
      }
      .background {
        ConnectorBrowserHost(store: store, flow: presentation.active)
          .frame(width: 0, height: 0)
          .accessibilityHidden(true)
      }
      .alert(
        failureTitle,
        isPresented: Binding(
          get: { failure != nil }, set: { if !$0 { store.dismissActivationError() } })
      ) {
        Button("OK") { store.dismissActivationError() }
      } message: {
        Text(failure ?? "")
      }
      .onOpenURL { store.receiveProviderReturn($0) }
      .onChange(of: scenePhase) { _, phase in
        store.authorizationSceneChanged(
          isActive: phase == .active, isBackground: phase == .background)
      }
  }
}

/// Keep browser launches scoped to the active authorization attempt.
private struct ConnectorBrowserHost: View {
  let store: ConnectorActionStore
  let flow: ConnectorAuthorizationFlow?

  var body: some View {
    ConnectorBrowserView(ownerID: flow?.id, url: flow?.browserURL) { url in
      if let flow { store.browserOpenFailed(flow: flow, url: url) }
    }
  }
}
