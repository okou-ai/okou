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

private struct ComposerConnectorPresentation: ViewModifier {
  let store: ComposerConnectorStore

  func body(content: Content) -> some View {
    content
      .connectorAuthorization(store: store.authorization, failureTitle: "Could not open connector")
      .sheet(
        item: Binding(get: { store.webDestination }, set: { store.webDestination = $0 }),
        onDismiss: { Task { await store.refresh() } },
        content: { page in
          ConnectorSafariView(url: page.url) { store.webDestination = nil }
        })
  }
}
