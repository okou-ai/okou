import SwiftUI
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

  /// Navigation searches keep their system interaction and use the app's glyphs and greys.
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
  }
}
