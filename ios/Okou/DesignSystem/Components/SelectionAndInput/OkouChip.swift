import SwiftUI

/// A filter chip for a row that scrolls sideways (connector categories): a 36 pt capsule in
/// the web directory's colours — `gray-50` with a `gray-400` hairline and supporting text;
/// the selected chip takes the shared `state-selected` layer and the text colour. The weight
/// never changes, so selecting a chip does not widen it and shift the row.
struct OkouChip: View {
  let title: Text
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      title
        .font(.okou(.subheadline).weight(.medium))
        .lineLimit(1)
        .foregroundStyle(isSelected ? OkouColor.foreground : OkouColor.mutedForeground)
        .padding(.horizontal, OkouSpace.lg)
        .frame(height: OkouControl.chipHeight)
        .background(isSelected ? OkouColor.stateSelected : OkouColor.gray50, in: Capsule())
        .overlay { Capsule().strokeBorder(OkouColor.gray400, lineWidth: OkouSpace.hairline) }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }
}

/// A sideways-scrolling row of chips or tiles (filters, pinned agents). Its first chip starts on the page's content edge and
/// the row scrolls out to the screen edges instead of being clipped at the inset.
struct OkouChipRail<Content: View>: View {
  var inset: CGFloat = OkouSpace.lg
  @ViewBuilder let content: Content

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: OkouSpace.sm) { content }
        .padding(.horizontal, inset)
    }
    .scrollIndicators(.hidden)
  }
}
