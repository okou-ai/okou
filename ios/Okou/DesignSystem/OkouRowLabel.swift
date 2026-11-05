import SwiftUI

/// The title of a grouped-list row with a leading graphic (icon, partner logo, avatar,
/// workspace mark). Every graphic sits in the same 28 pt slot, so row text starts on one
/// edge across a sheet and across the app, whatever the graphic's own size. A card led by a
/// larger mark (the workspace in Settings) gives all its rows that mark's slot, so their text
/// still shares one edge.
struct OkouRowLabel<Leading: View>: View {
  let title: Text
  let leading: Leading
  @ScaledMetric(relativeTo: .body) private var slot = OkouControl.rowLeadingSlot

  init(
    _ title: Text, slot: CGFloat = OkouControl.rowLeadingSlot,
    @ViewBuilder leading: () -> Leading
  ) {
    self.title = title
    self.leading = leading()
    _slot = ScaledMetric(wrappedValue: slot, relativeTo: .body)
  }

  var body: some View {
    HStack(spacing: OkouSpace.md) {
      leading
        .frame(width: slot, height: slot)
        .accessibilityHidden(true)
      title
    }
  }
}

extension OkouRowLabel where Leading == OkouIcon {
  init(
    _ title: LocalizedStringKey, okouSymbol: String, slot: CGFloat = OkouControl.rowLeadingSlot
  ) {
    self.init(Text(title), slot: slot) { OkouIcon(okouSymbol, size: OkouIconSize.standard) }
  }
}

/// A grouped row with a trailing value, as in the system Settings app: the title keeps its one
/// line and the value yields, truncating in the middle, in body-size supporting text. Without
/// this, a long value (an email address) squeezed the title onto two lines.
struct OkouValueRow<Label: View>: View {
  let label: Label
  let value: Text

  init(value: Text, @ViewBuilder label: () -> Label) {
    self.value = value
    self.label = label()
  }

  var body: some View {
    HStack(spacing: OkouSpace.md) {
      label
        .lineLimit(1)
        .layoutPriority(1)
      Spacer(minLength: OkouSpace.sm)
      value
        .font(.okou(.body))
        .foregroundStyle(OkouColor.mutedForeground)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }
}
