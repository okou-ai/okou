import SwiftUI

/// The app's search bar: a 44 pt clear glass capsule (`OkouGlassControl(.capsule)`) with the
/// Lucide `search` glyph and the placeholder in `OkouColor.placeholder`. The sidebar's button
/// that opens search; the search page keeps the system field (and its interaction), drawn with
/// the same glyphs and greys by `OkouNavigationBar.applySearchField()`.
struct OkouSearchBar<Content: View>: View {
  @ViewBuilder let content: () -> Content

  var body: some View {
    HStack(spacing: OkouSpace.sm) {
      OkouIcon("search", size: OkouIconSize.standard)
        .foregroundStyle(OkouColor.placeholder)
      content()
    }
    .font(.okou(.body))
    .padding(.horizontal, OkouSpace.lg)
    .frame(maxWidth: .infinity)
    .modifier(OkouGlassControl(shape: .capsule))
  }
}

extension OkouSearchBar where Content == AnyView {
  /// The bar as a button's label: the prompt alone, in placeholder grey.
  init(prompt: LocalizedStringKey) {
    self.content = {
      AnyView(
        HStack(spacing: 0) {
          Text(prompt).foregroundStyle(OkouColor.placeholder).lineLimit(1)
          Spacer(minLength: 0)
        })
    }
  }
}
