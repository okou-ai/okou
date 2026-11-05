import SwiftUI

/// Glass icon and pill controls drawn on an exact 44 pt shape, so every one reads at the
/// same size. `.buttonStyle(.glass)` draws a smaller circle inside its 44 pt frame, which
/// sat beside 44 pt UIKit glass buttons (the chat "…" menu) at a visibly different size.
/// Every bar control is the same clear glass, the sidebar's new chat included.
struct OkouGlassControl: ViewModifier {
  enum Shape { case circle, capsule }
  let shape: Shape

  func body(content: Content) -> some View {
    switch shape {
    case .circle:
      content
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .glassEffect(.regular.interactive(), in: Circle())
        .contentShape(Circle())
    case .capsule:
      content
        .frame(height: OkouControl.minimumTarget)
        .glassEffect(.regular.interactive(), in: Capsule())
        .contentShape(Capsule())
    }
  }
}
