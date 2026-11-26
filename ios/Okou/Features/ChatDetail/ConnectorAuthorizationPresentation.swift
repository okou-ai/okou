import SwiftUI

extension View {
  func connectorAuthorization(store: ConnectorActionStore) -> some View {
    modifier(ConnectorAuthorizationPresentation(store: store))
  }
}

private struct ConnectorAuthorizationPresentation: ViewModifier {
  @Environment(\.scenePhase) private var scenePhase
  let store: ConnectorActionStore

  func body(content: Content) -> some View {
    content
      .sheet(
        item: Binding(
          get: { store.active.flatMap { $0.presentsForm ? $0 : nil } },
          set: { if $0 == nil, store.active?.presentsForm == true { store.cancel() } })
      ) { flow in
        ConnectorAuthorizationSheet(flow: flow, store: store)
          .okouSheetBackground()
      }
      .background {
        ConnectorBrowserHost(store: store)
          .frame(width: 0, height: 0)
          .accessibilityHidden(true)
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

  var body: some View {
    let flow = store.active
    ConnectorBrowserView(ownerID: flow?.id, url: flow?.browserURL) { url in
      if let flow { store.browserOpenFailed(flow: flow, url: url) }
    }
  }
}
