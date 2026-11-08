import SwiftUI

struct OkouAppearance: ViewModifier {
  @AppStorage(OkouAppearancePreference.storageKey) private var appearance =
    OkouAppearancePreference.system.rawValue

  func body(content: Content) -> some View {
    content
      .preferredColorScheme(OkouAppearancePreference(rawValue: appearance)?.colorScheme)
      .font(.okou(.body))
      .foregroundStyle(OkouColor.foreground)
      .tint(OkouColor.foreground)
      .scrollEdgeEffectStyle(.soft, for: .top)
      // No blur at the bottom anywhere: content passes plainly under the floating composer,
      // search capsule and buttons, which carry their own glass.
      .scrollEdgeEffectHidden(true, for: .bottom)
      .environment(\.defaultMinListRowHeight, OkouControl.minimumTarget)
      .background(OkouColor.background)
  }
}
