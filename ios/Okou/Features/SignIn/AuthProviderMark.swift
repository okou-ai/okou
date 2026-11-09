import ClerkKit
import SwiftUI

/// A sign-in provider's mark. The providers Okou offers ship in the app, so their buttons are
/// never blank on a slow or failing network; a provider added in Clerk later loads Clerk's
/// copy and shows a neutral glyph until it arrives.
struct AuthProviderMark: View {
  let provider: OAuthProvider

  private var bundled: String? {
    switch provider {
    case .apple: "AuthProvider-apple"
    case .google: "AuthProvider-google"
    case .microsoft: "AuthProvider-microsoft"
    case .slack: "AuthProvider-slack"
    default: nil
    }
  }

  var body: some View {
    if let bundled {
      // The Apple mark is a template and takes the button's text colour, as Apple asks.
      Image(bundled).resizable().scaledToFit().foregroundStyle(OkouColor.foreground)
    } else {
      AsyncImage(url: provider.iconImageUrl) { image in
        image.resizable()
          .renderingMode(provider.supportsTintedIconMask ? .template : .original)
          .scaledToFit().foregroundStyle(OkouColor.foreground)
      } placeholder: {
        OkouIcon("circle-user-round", size: OkouIconSize.inline).foregroundStyle(
          OkouColor.mutedForeground)
      }
    }
  }
}
