import SwiftUI
import UIKit

/// Geist is shared with Web; the scale follows native Dynamic Type, not CSS pixels.
enum OkouTypography {
  static let sans = "Geist-Regular"
  static let mono = "GeistMono-Regular"

  static func font(
    ofSize size: CGFloat, weight: UIFont.Weight = .regular, monospaced: Bool = false
  ) -> UIFont {
    let name = monospaced ? mono : sans
    let base = UIFont(name: name, size: size) ?? UIFont.systemFont(ofSize: size, weight: weight)
    let descriptor = base.fontDescriptor.addingAttributes([
      .traits: [UIFontDescriptor.TraitKey.weight: weight.rawValue]
    ])
    return UIFont(descriptor: descriptor, size: size)
  }

  static func font(
    forTextStyle style: UIFont.TextStyle, compatibleWith traits: UITraitCollection? = nil
  ) -> UIFont {
    let native = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
    return font(ofSize: native.pointSize, weight: style == .headline ? .semibold : .regular)
  }
}

extension Font {
  /// `.serif` is the native serif (New York), which is the face the web's `ui-serif` stack
  /// resolves to on Apple platforms; the web uses it only for quiet run-section labels.
  static func okou(_ style: Font.TextStyle, design: Font.Design = .default) -> Font {
    if design == .serif {
      return .system(style, design: .serif)
    }
    let size: CGFloat
    switch style {
    case .largeTitle: size = 34
    case .title: size = 28
    case .title2: size = 22
    case .title3: size = 20
    case .headline, .body: size = 17
    case .callout: size = 16
    case .subheadline: size = 15
    case .footnote: size = 13
    case .caption: size = 12
    case .caption2: size = 11
    @unknown default: size = 17
    }
    let font = Font.custom(
      design == .monospaced ? OkouTypography.mono : OkouTypography.sans,
      size: size, relativeTo: style)
    return style == .headline ? font.weight(.semibold) : font
  }

  /// Point sizes supplied by ScaledMetric or native icon/layout measurements are already scaled.
  static func okou(
    size: CGFloat, weight: Font.Weight = .regular, design: Font.Design = .default
  ) -> Font {
    .custom(
      design == .monospaced ? OkouTypography.mono : OkouTypography.sans,
      fixedSize: size
    ).weight(weight)
  }
}
