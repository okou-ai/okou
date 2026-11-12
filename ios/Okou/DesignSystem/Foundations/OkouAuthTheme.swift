import ClerkKitUI
import SwiftUI
import UIKit

enum OkouAuthTheme {
  /// Neutral ink, as the app's tint: brand-text is a text role and reads brown as a fill.
  static let primary = OkouColor.foreground

  @MainActor
  static func makeTheme() -> ClerkTheme {
    // This SDK shares primary between text links and filled controls. Its public
    // theme cannot separate the two, so primary is ink, and filled controls take the
    // inverse: white on ink in light appearance, ink on near-white in dark.
    let authForeground = Color(
      uiColor: UIColor { traits in
        UIColor(
          traits.userInterfaceStyle == .dark ? OkouColor.primaryForeground : OkouColor.onFilled
        )
        .resolvedColor(with: traits)
      })
    var colors = ClerkTheme.Colors(
      primary: primary,
      switchTint: OkouColor.primary400,
      background: OkouColor.background,
      input: OkouColor.input,
      danger: OkouColor.destructive,
      foreground: OkouColor.foreground,
      mutedForeground: OkouColor.mutedForeground,
      primaryForeground: authForeground,
      inputForeground: OkouColor.foreground,
      neutral: OkouColor.foreground,
      ring: OkouColor.ring,
      muted: OkouColor.muted,
      secondaryButtonBackground: OkouColor.card,
      secondaryButtonForeground: OkouColor.foreground,
      border: OkouColor.border)
    colors.primaryPressed = OkouColor.foregroundHover
    colors.border = OkouColor.border
    colors.buttonBorder = OkouColor.border
    colors.inputBorder = OkouColor.controlBorder
    colors.inputBorderFocused = OkouColor.primary
    colors.dangerInputBorder = OkouColor.destructive
    let fonts = ClerkTheme.Fonts(fontFamily: OkouTypography.sans)
    return ClerkTheme(
      colors: colors, fonts: fonts,
      design: .init(borderRadius: OkouRadius.control))
  }
}
