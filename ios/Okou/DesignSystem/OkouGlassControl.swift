import SwiftUI

/// Glass icon and pill controls drawn on an exact 44 pt shape, so every one reads at the
/// same size. `.buttonStyle(.glass)` draws a smaller circle inside its 44 pt frame, which
/// sat beside 44 pt UIKit glass buttons (the chat "…" menu) at a visibly different size.
///
/// `isProminent` is the one primary action in a bar (the sidebar's new chat): the same
/// shape, tinted with the foreground colour, its glyph in the background colour.
struct OkouGlassControl: ViewModifier {
  enum Shape { case circle, capsule }
  let shape: Shape
  var isProminent = false

  func body(content: Content) -> some View {
    switch shape {
    case .circle:
      glyph(content)
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .glassEffect(glass, in: Circle())
        .contentShape(Circle())
    case .capsule:
      glyph(content)
        .frame(height: OkouControl.minimumTarget)
        .glassEffect(glass, in: Capsule())
        .contentShape(Capsule())
    }
  }

  private var glass: Glass {
    if isProminent {
      return .regular.tint(OkouColor.foreground).interactive()
    }
    return .regular.interactive()
  }

  @ViewBuilder private func glyph(_ content: Content) -> some View {
    if isProminent {
      content.foregroundStyle(OkouColor.background)
    } else {
      content
    }
  }
}
