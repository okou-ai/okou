import CCStateSwiftUI
import ChatData
import SwiftUI

struct OnboardingSourcesContent: View {
  let store: OnboardingStore
  @LoadableValue private var sources: Loadable<[OnboardingSource]>

  init(store: OnboardingStore) {
    self.store = store
    _sources = LoadableValue(task: store.resources.sources)
  }

  var body: some View {
    Section {
      switch sources {
      case .loading: OkouLoadingRow("Loading connectors…")
      case .hasError(let error):
        OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
          store.retry(.sources)
        }
      case .hasData(let sources):
        ForEach(sources) { source in
          let connected = store.connectors.connectors.contains {
            $0.target.connectorSlug == source.slug
          }
          Button {
            if source.authMethods.contains(where: { $0.grantKind != "managed" }) {
              store.connectors.connect(target: .builtin(source.slug))
            } else {
              store.connectors.openWeb(path: "connectors/\(source.slug)/connect")
            }
          } label: {
            HStack(spacing: OkouSpace.md) {
              ConnectorLogo(icon: source.icon)
                .frame(width: OkouControl.rowLeadingSlot, height: OkouControl.rowLeadingSlot)
              VStack(alignment: .leading, spacing: OkouSpace.two) {
                Text(source.label).foregroundStyle(OkouColor.foreground)
                Text(connected ? String(localized: "Connected") : source.description)
                  .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
                  .lineLimit(2)
              }
              Spacer(minLength: OkouSpace.sm)
              OkouAddIndicator(isAdded: connected)
            }
          }
          .accessibilityIdentifier("onboarding-connect-\(source.slug)")
        }
      }
      if let error = store.connectors.authorization.activationError {
        Text(error).foregroundStyle(OkouColor.destructive)
      }
    }
    .task { await store.connectors.refresh() }
  }
}
