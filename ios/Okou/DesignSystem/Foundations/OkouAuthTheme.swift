import ClerkKitUI
import SwiftUI
import UIKit

enum OkouAuthTheme {
  static let primary = OkouColor.brandText

  @MainActor
  static func makeTheme() -> ClerkTheme {
    // This SDK shares primary between text links and filled controls. Its public
    // theme cannot separate the two, so retain Web's readable provider pair.
    let authForeground = Color(
      uiColor: UIColor { traits in
        UIColor(
          traits.userInterfaceStyle == .dark ? OkouColor.primaryForeground : OkouColor.onFilled
        )
        .resolvedColor(with: traits)
      })
    var colors = ClerkTheme.Colors(
      primary: OkouColor.brandText,
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
    colors.primaryPressed = OkouColor.brandTextHover
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
