import CoreText
import Foundation
import SwiftUI

/// Widgets draw in Geist, as the App does. The extension ships no fonts of its own: it registers
/// the App's copies from the containing bundle (`Okou.app/PlugIns/OkouWidgets.appex`).
enum OkouWidgetFonts {
  static let sans = "Geist-Regular"
  static let mono = "GeistMono-Regular"

  static func register() {
    let app = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
    for name in ["Geist", "GeistMono"] {
      let url = app.appendingPathComponent(name + ".ttf")
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }
}

extension Font {
  static func okouWidget(
    _ size: CGFloat, weight: Font.Weight = .regular, mono: Bool = false,
    relativeTo style: Font.TextStyle = .body
  ) -> Font {
    .custom(mono ? OkouWidgetFonts.mono : OkouWidgetFonts.sans, size: size, relativeTo: style)
      .weight(weight)
  }
}
