import SwiftUI

/// A quiet unread marker on a glyph's top-right corner; the control owns its accessible value.
struct OkouUnreadBadge: ViewModifier {
  let isVisible: Bool

  func body(content: Content) -> some View {
    content.overlay(alignment: .topTrailing) {
      if isVisible {
        Circle()
          .fill(OkouStatusColor.running)
          .frame(width: OkouControl.unreadDot, height: OkouControl.unreadDot)
          .overlay {
            // Cut out the separator so the control's own glass shows through it.
            Circle()
              .stroke(OkouStatusColor.running, lineWidth: OkouSpace.two)
              .blendMode(.destinationOut)
          }
          // Over the glyph's top-right corner, as an iOS badged symbol: the cut ring keeps a
          // gap between the dot and the strokes it covers.
          .offset(x: OkouSpace.two, y: -OkouSpace.two)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    // Keep the cutout within the glyph and badge, leaving the host material intact.
    .compositingGroup()
  }
}
