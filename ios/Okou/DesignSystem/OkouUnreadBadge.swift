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
          .overlay { Circle().stroke(OkouColor.background, lineWidth: OkouSpace.two) }
          .offset(x: OkouSpace.xs, y: -OkouSpace.xs)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
  }
}
