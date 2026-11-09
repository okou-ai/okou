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
          .offset(x: OkouSpace.xs, y: -OkouSpace.xs)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    // Keep the cutout within the glyph and badge, leaving the host material intact.
    .compositingGroup()
  }
}
