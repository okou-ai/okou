import SwiftUI

struct ChatSettingsLoadingView: View {
  let title: LocalizedStringKey

  var body: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text(title).font(.subheadline).foregroundStyle(.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
    .allowsHitTesting(false)
  }
}

struct ChatSettingsActionLabel: View {
  let title: LocalizedStringKey
  var isBusy = false

  var body: some View {
    HStack(spacing: 8) {
      if isBusy { ProgressView().controlSize(.small) }
      Text(title)
    }
    .frame(maxWidth: .infinity, minHeight: 24)
  }
}
