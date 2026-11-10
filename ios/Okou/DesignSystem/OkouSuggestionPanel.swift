import SwiftUI

/// Shared chrome for suggestions anchored above an editor. The editor retains focus.
struct OkouSuggestionPanel<Content: View>: View {
  let title: LocalizedStringKey
  let availableHeight: CGFloat
  let dismissLabel: LocalizedStringKey
  let dismissIdentifier: String
  let dismiss: () -> Void
  @ViewBuilder let content: (CGFloat) -> Content

  @State private var headerHeight = OkouControl.minimumTarget

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 0) {
        Text(title)
          .font(.okou(.footnote).weight(.medium))
          .foregroundStyle(OkouColor.mutedForeground)
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: OkouSpace.sm)
        Button(action: dismiss) {
          OkouIcon("x", size: OkouIconSize.inline)
            .foregroundStyle(OkouColor.mutedForeground)
            .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(dismissLabel)
        .accessibilityIdentifier(dismissIdentifier)
      }
      .padding(.leading, OkouSpace.lg)
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGFloat.self) {
        $0.size.height
      } action: {
        headerHeight = $0
      }
      content(max(0, availableHeight - headerHeight))
        .frame(maxHeight: max(0, availableHeight - headerHeight), alignment: .top)
        .clipped()
    }
    .frame(maxHeight: availableHeight, alignment: .top)
    .fixedSize(horizontal: false, vertical: true)
    .modifier(OkouFloatingPanelStyle())
  }
}

/// A text-first candidate; absent metadata leaves the complete width to its title.
struct OkouSuggestionRow: View {
  let title: String
  var detail: String?
  var command: String?

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.two) {
      HStack(alignment: .firstTextBaseline, spacing: OkouSpace.sm) {
        Text(verbatim: title)
          .font(.okou(.body))
          .foregroundStyle(OkouColor.foreground)
          .lineLimit(command == nil ? 2 : 1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .layoutPriority(1)
        if let command {
          Text(verbatim: command)
            .font(.okou(.caption, design: .monospaced))
            .foregroundStyle(OkouColor.mutedForeground)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      if let detail, !detail.isEmpty {
        Text(verbatim: detail)
          .font(.okou(.footnote))
          .foregroundStyle(OkouColor.mutedForeground)
          .lineLimit(1)
      }
    }
    .frame(
      minHeight: detail?.isEmpty == false ? OkouControl.minimumTarget : OkouSpace.xxxl,
      alignment: .leading)
  }
}
