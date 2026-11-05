import SwiftUI

/// A filter chip for a row that scrolls sideways (connector categories). The selected chip is
/// filled with the foreground colour; the others are cards with a hairline edge. Every chip
/// has the same height whatever its text.
struct OkouChip: View {
  let title: Text
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      title
        .font(.okou(.subheadline).weight(.medium))
        .lineLimit(1)
        .foregroundStyle(isSelected ? OkouColor.background : OkouColor.foreground)
        .padding(.horizontal, OkouSpace.lg)
        .frame(height: OkouControl.chipHeight)
        .background(isSelected ? OkouColor.foreground : OkouColor.card, in: Capsule())
        .overlay {
          Capsule().strokeBorder(
            isSelected ? Color.clear : OkouColor.controlBorder, lineWidth: OkouSpace.hairline)
        }
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

/// A partner or connector mark on a quiet square tile, the way app catalogs show apps: the
/// tile, not the mark, sets the size, so logos of any shape line up. Its corner follows the
/// tile's size, like an app icon's.
struct OkouLogoTile<Content: View>: View {
  let size: CGFloat
  @ViewBuilder let content: Content

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: size * 0.27, style: .continuous)
    content
      .frame(width: size, height: size)
      .background(OkouColor.stateHover, in: shape)
      .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
      .accessibilityHidden(true)
  }
}

/// The trailing control on a catalog card: "+" adds straight from the list without opening
/// the item; once added it turns into a filled check. Drawn at 32 pt inside a 44 pt target.
struct OkouAddIndicator: View {
  let isAdded: Bool

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
    OkouIcon(isAdded ? "check" : "plus", size: OkouIconSize.inline)
      .foregroundStyle(isAdded ? OkouColor.background : OkouColor.foreground)
      .frame(width: OkouControl.addControl, height: OkouControl.addControl)
      .background(isAdded ? OkouColor.foreground : Color.clear, in: shape)
      .overlay {
        shape.strokeBorder(
          isAdded ? Color.clear : OkouColor.controlBorder, lineWidth: OkouSpace.hairline)
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Rectangle())
  }
}

extension View {
  /// A segmented control that switches a whole page (Discover / Custom): the large size, so
  /// it reads as the page's top-level choice rather than a row setting.
  func okouSegmented() -> some View {
    pickerStyle(.segmented).controlSize(.large)
  }
}
