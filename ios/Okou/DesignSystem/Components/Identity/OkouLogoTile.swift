import SwiftUI

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
