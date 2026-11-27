import CCStateSwiftUI
import SwiftUI

extension View {
  func connectorAuthorizationPresentation(store: ComposerConnectorStore) -> some View {
    modifier(ComposerConnectorPresentation(store: store))
  }

  @ViewBuilder
  func connectorSearch(
    text: Binding<String>, enabled: Bool, prompt: LocalizedStringKey
  ) -> some View {
    if enabled { searchable(text: text, prompt: Text(prompt)) } else { self }
  }
}

/// The web page a connector action opens, kept in the session Store.
private struct ComposerConnectorPresentation: ViewModifier {
  let store: ComposerConnectorStore
  @ResolvedValue private var status: ComposerConnectorStore.Status?

  init(store: ComposerConnectorStore) {
    self.store = store
    _status = ResolvedValue(store.statusValue)
  }

  func body(content: Content) -> some View {
    let destination = (status ?? store.status).webDestination
    content
      .connectorAuthorization(store: store.authorization, failureTitle: "Could not open connector")
      .sheet(
        item: Binding(get: { destination }, set: { store.webDestination = $0 }),
        onDismiss: { Task { await store.refresh() } },
        content: { page in
          ConnectorSafariView(url: page.url) { store.webDestination = nil }
        })
  }
}
