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
        ConnectorAuthenticationHost(store: store)
          .frame(width: 0, height: 0)
          .accessibilityHidden(true)
      }
      .onOpenURL { store.receiveProviderReturn($0) }
      .onChange(of: scenePhase) { _, phase in
        store.providerSceneActive(phase == .active)
      }
  }
}

/// Mount before an attempt starts so navigation and forms keep the same scene anchor.
private struct ConnectorAuthenticationHost: View {
  let store: ConnectorActionStore

  var body: some View {
    let flow = store.active
    ConnectorAuthenticationSessionView(
      ownerID: flow?.id,
      url: flow?.usesSystemAuthenticationSession == true ? flow?.browserURL : nil,
      callbackURL: flow?.session?.nativeCallbackUrl
    ) { url, callbackURL, error in
      if let flow {
        store.authenticationFinished(flow: flow, url: url, callbackURL: callbackURL, error: error)
      }
    }
  }
}
