import SwiftUI

struct OkouAppearance: ViewModifier {
  @AppStorage(OkouAppearancePreference.storageKey) private var appearance =
    OkouAppearancePreference.system.rawValue

  func body(content: Content) -> some View {
    content
      .preferredColorScheme(OkouAppearancePreference(rawValue: appearance)?.colorScheme)
      .modifier(OkouContentStyle())
      .background(OkouColor.background)
  }
}

/// The app's type, colours and scroll edges. A UIKit-hosted page applies it again: its host
/// starts from SwiftUI's default environment rather than the app root's.
struct OkouContentStyle: ViewModifier {
  func body(content: Content) -> some View {
    content
      .font(.okou(.body))
      .foregroundStyle(OkouColor.foreground)
      .tint(OkouColor.foreground)
      .scrollEdgeEffectStyle(.soft, for: .top)
      // No blur at the bottom anywhere: content passes plainly under the floating composer,
      // search capsule and buttons, which carry their own glass.
      .scrollEdgeEffectHidden(true, for: .bottom)
      .environment(\.defaultMinListRowHeight, OkouControl.minimumTarget)
  }
}
