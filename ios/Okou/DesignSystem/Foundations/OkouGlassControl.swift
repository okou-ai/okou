import SwiftUI

/// Glass icon and pill controls drawn on an exact 44 pt shape, so every one reads at the
/// same size. `.buttonStyle(.glass)` draws a smaller circle inside its 44 pt frame, which
/// sat beside 44 pt UIKit glass buttons (the chat "…" menu) at a visibly different size.
/// Every bar control is the same clear glass, the sidebar's new chat included.
struct OkouGlassControl: ViewModifier {
  enum Shape { case circle, capsule }
  /// What the glass stands on. Clear glass takes the colour of whatever is behind it, which is
  /// right over a page or a bar. Over a strongly coloured picture (a cover or a photo) it turns the
  /// picture's colour and the controls melt into it, so there the glass holds a veil of the page's
  /// own background: still glass at its edges and in its touch response, but it reads as a
  /// control lifted off the scene, in both themes. A `Glass.tint` of the background does not do
  /// this: a light tint on light glass leaves the picture's colour as it was.
  enum Surface { case page, scene }
  let shape: Shape
  var surface: Surface = .page

  /// How much of the page's background veils the glass over a picture.
  private static let sceneVeil: Double = 0.85

  private var veil: Color {
    switch surface {
    case .page: .clear
    case .scene: OkouColor.background.opacity(Self.sceneVeil)
    }
  }

  func body(content: Content) -> some View {
    switch shape {
    case .circle:
      content
        .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
        .background(veil, in: Circle())
        .glassEffect(.regular.interactive(), in: Circle())
        .contentShape(Circle())
    case .capsule:
      content
        .frame(height: OkouControl.minimumTarget)
        .background(veil, in: Capsule())
        .glassEffect(.regular.interactive(), in: Capsule())
        .contentShape(Capsule())
    }
  }
}

/// A prompt on a glass capsule that stands in for an input until it opens ("What do you have in
/// mind?"). Its text takes the glass's own vibrancy through the hierarchical `.secondary`
/// style instead of a fixed grey: on a plain page it reads as the placeholder does, and over a
/// picture or a coloured scene the system adapts it to what the glass picks up, so it never washes
/// out. A fixed colour would be drawn as it is, whatever the glass sits on.
struct OkouGlassPrompt: View {
  let title: LocalizedStringKey
  let surface: OkouGlassControl.Surface

  init(_ title: LocalizedStringKey, on surface: OkouGlassControl.Surface = .page) {
    self.title = title
    self.surface = surface
  }

  var body: some View {
    Text(title)
      .font(.okou(.body)).foregroundStyle(.secondary).lineLimit(1)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, OkouSpace.lg)
      .modifier(OkouGlassControl(shape: .capsule, surface: surface))
  }
}
