import UIKit

/// The system back button keeps its native behaviour (swipe back, the long-press history menu,
/// the glass circle) but draws Okou's Lucide chevron instead of the SF Symbol. The SF chevron
/// was half again as tall and heavier than every Lucide glyph beside it (19 pt against the
/// 20 pt Lucide set's 11–15 pt artwork), so a pushed page's back button never matched the
/// header's menu or a sheet's close.
enum OkouNavigationBar {
  @MainActor static func applyBackIndicator() {
    guard let chevron = OkouIcon.uiImage("chevron-left") else { return }
    let bar = UINavigationBar.appearance()
    bar.backIndicatorImage = chevron
    bar.backIndicatorTransitionMaskImage = chevron
  }

  /// The system search field keeps its interaction (rising into the bar while typing) but
  /// draws the app's glyphs: Lucide `search` and `circle-x` in `OkouColor.placeholder`, as the
  /// sidebar's `OkouSearchBar` draws them, instead of the SF Symbols.
  @MainActor static func applySearchField() {
    let grey = UIColor(OkouColor.placeholder)
    let bar = UISearchBar.appearance()
    if let glass = OkouIcon.uiImage("search")?.withTintColor(grey, renderingMode: .alwaysOriginal) {
      bar.setImage(glass, for: .search, state: .normal)
    }
    if let clear = OkouIcon.uiImage("circle-x")?.withTintColor(grey, renderingMode: .alwaysOriginal)
    {
      bar.setImage(clear, for: .clear, state: .normal)
    }
    // The ✕ that ends search while typing stays the system's: iOS draws it in the bar's own
    // glass button, and no public API sizes or swaps its glyph.
  }
}
