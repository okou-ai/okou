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

/// A sideways-scrolling row of filter chips. Its first chip starts on the page's content edge
/// and the row scrolls out to the screen edges instead of being clipped at the inset.
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

/// The page-level switch (Discover / Custom): the large segmented control's shape — a full
/// width 48 pt capsule track with equal segments and the selected one inset 2 pt — in the
/// web segment control's colours: a `segment-track` track, the selected segment raised in
/// `segment-selected` with the web's soft shadow, supporting text for the others.
struct OkouSegmentControl<Value: Hashable>: View {
  @Binding var selection: Value
  let options: [(value: Value, title: LocalizedStringKey)]

  var body: some View {
    HStack(spacing: 0) {
      ForEach(options.indices, id: \.self) { index in
        segment(options[index])
      }
    }
    .padding(OkouSpace.two)
    .frame(height: OkouControl.segmentHeight)
    .background(OkouColor.segmentTrack, in: Capsule())
  }

  private func segment(_ option: (value: Value, title: LocalizedStringKey)) -> some View {
    let isSelected = option.value == selection
    return Button {
      selection = option.value
    } label: {
      Text(option.title)
        .font(.okou(.subheadline).weight(.medium))
        .foregroundStyle(isSelected ? OkouColor.foreground : OkouColor.mutedForeground)
        .lineLimit(1)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
          if isSelected {
            Capsule().fill(OkouColor.segmentSelected)
              .shadow(
                color: .black.opacity(OkouElevation.segmentOpacity),
                radius: OkouElevation.segmentRadius, y: OkouElevation.segmentY)
          }
        }
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
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

/// The trailing control on a catalog card, as the web draws it: "+" in an outlined square adds
/// straight from the list without opening the item; once added it turns into a chevron with
/// no edge, and the whole card opens the item to manage it. Drawn at 32 pt inside a 44 pt
/// target.
struct OkouAddIndicator: View {
  let isAdded: Bool

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
    OkouIcon(isAdded ? "chevron-right" : "plus", size: OkouIconSize.inline)
      .foregroundStyle(OkouColor.mutedForeground)
      .frame(width: OkouControl.addControl, height: OkouControl.addControl)
      .overlay {
        shape.strokeBorder(
          isAdded ? Color.clear : OkouColor.controlBorder, lineWidth: OkouSpace.hairline)
      }
      .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
      .contentShape(Rectangle())
  }
}
