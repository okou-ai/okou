import SwiftUI

/// A sheet's first load, centred where its content will appear: a small muted spinner over
/// one line of supporting text.
struct ChatSettingsLoadingView: View {
  let title: LocalizedStringKey

  var body: some View {
    VStack(spacing: OkouSpace.md) {
      ProgressView().tint(OkouColor.mutedForeground)
      Text(title).font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .allowsHitTesting(false)
  }
}

/// The title of a sheet's primary action (`OkouButtonStyle(isPrimary: true)`), with a spinner
/// in the label's colour while it works.
struct ChatSettingsActionLabel: View {
  let title: LocalizedStringKey
  var isBusy = false

  var body: some View {
    HStack(spacing: OkouSpace.sm) {
      if isBusy {
        ProgressView().controlSize(.small).tint(OkouColor.primaryForeground)
      }
      Text(title)
    }
    .frame(maxWidth: .infinity)
  }
}
