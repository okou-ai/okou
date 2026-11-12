import SwiftUI

/// A square tile at the head of a sideways media strip (Camera): its glyph over a
/// short label on the neutral `state-hover` fill, the same size and corner as the photo
/// thumbnails beside it.
struct OkouActionTile: View {
  let title: LocalizedStringKey
  let icon: String

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.chat, style: .continuous)
    VStack(spacing: OkouSpace.six) {
      OkouIcon(icon, size: OkouIconSize.standard)
        .accessibilityHidden(true)
      Text(title)
        .font(.okou(.subheadline))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .foregroundStyle(OkouColor.foreground)
    .padding(.horizontal, OkouSpace.xs)
    .frame(width: OkouControl.mediaTile, height: OkouControl.mediaTile)
    .background(OkouColor.stateHover, in: shape)
    .contentShape(shape)
  }
}

/// A photo in a sideways media strip: the image filling the tile's square, a hairline edge so
/// light photos keep their shape on white, and the selection mark in the corner.
struct OkouMediaThumbnail: View {
  let image: Image?
  let isSelected: Bool

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.chat, style: .continuous)
    Group {
      if let image {
        image.resizable().scaledToFill()
      } else {
        OkouColor.stateHover
      }
    }
    .frame(width: OkouControl.mediaTile, height: OkouControl.mediaTile)
    .clipShape(shape)
    .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
    .overlay(alignment: .topTrailing) {
      OkouSelectionMark(isSelected: isSelected).padding(OkouSpace.six)
    }
    .contentShape(shape)
  }
}

/// The pick mark on a photo: an open white ring over the image until it is picked, then the
/// web checkbox's checked state — an amber `primary` fill with an ink check.
struct OkouSelectionMark: View {
  let isSelected: Bool

  var body: some View {
    ZStack {
      if isSelected {
        Circle().fill(OkouColor.primary)
        OkouIcon("check", size: OkouIconSize.badge)
          .foregroundStyle(OkouColor.primaryForeground)
      } else {
        Circle().fill(OkouMediaColor.scrim.opacity(OkouMediaColor.markScrimOpacity))
        Circle().strokeBorder(OkouMediaColor.foreground, lineWidth: OkouControl.selectionMarkStroke)
      }
    }
    .frame(width: OkouControl.selectionMark, height: OkouControl.selectionMark)
    .accessibilityHidden(true)
  }
}
