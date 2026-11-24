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

/// A prompt on a glass capsule that stands in for an input until it opens (For you's "What do you
/// have in mind?"). Its text takes the glass's own vibrancy through the hierarchical `.secondary`
/// style instead of a fixed grey: on a plain page it reads as the placeholder does, and over a
/// picture or a coloured scene the system adapts it to what the glass picks up, so it never washes
/// out. A fixed colour would be drawn as it is, whatever the glass sits on.
struct OkouGlassPrompt: View {
  let title: LocalizedStringKey

  init(_ title: LocalizedStringKey) {
    self.title = title
  }

  var body: some View {
    Text(title)
      .font(.okou(.body)).foregroundStyle(.secondary).lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, OkouSpace.lg)
      .modifier(OkouGlassControl(shape: .capsule))
  }
}
