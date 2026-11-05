import SwiftUI

/// A read failed inside a list, a sheet or a card (web `LoadErrorRow`): one muted sentence in
/// the place of the content it stands for, and a quiet text action to try again. A failed read
/// is not an alarm, so it is never red; red stays for actions the reader started.
struct OkouLoadErrorRow: View {
  let message: String
  var actionTitle: LocalizedStringKey = "Try again"
  var isRetrying = false
  var retry: (@MainActor () async -> Void)? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: OkouSpace.md) {
      Text(message)
        .font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let retry {
        Button {
          Task { await retry() }
        } label: {
          if isRetrying {
            Text("Refreshing…")
          } else {
            Text(actionTitle)
          }
        }
        .buttonStyle(.plain)
        .font(.okou(.subheadline).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        .frame(minWidth: OkouControl.minimumTarget, minHeight: OkouControl.inlineActionHeight)
        .contentShape(Rectangle())
        .disabled(isRetrying)
      }
    }
    .accessibilityElement(children: .contain)
  }
}

/// One quiet loading line for a list, sheet or card: a small muted spinner and what is loading.
/// Every sheet uses this instead of a bare `ProgressView("…")`, so loading reads the same app-wide.
struct OkouLoadingRow: View {
  let title: LocalizedStringKey

  init(_ title: LocalizedStringKey) {
    self.title = title
  }

  var body: some View {
    HStack(spacing: OkouSpace.sm) {
      ProgressView()
        .controlSize(.small)
        .tint(OkouColor.mutedForeground)
      Text(title)
        .font(.okou(.subheadline))
        .foregroundStyle(OkouColor.mutedForeground)
    }
    .frame(maxWidth: .infinity, minHeight: OkouControl.inlineActionHeight, alignment: .leading)
    .accessibilityElement(children: .combine)
  }
}
