import SwiftUI

struct OkouAppearance: ViewModifier {
  func body(content: Content) -> some View {
    content.tint(.primary)
  }
}

struct NeutralProminentButtonStyle: PrimitiveButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    Button(role: configuration.role, action: configuration.trigger) {
      configuration.label
        .foregroundStyle(isEnabled ? Color(uiColor: .systemBackground) : Color.secondary)
    }
    .buttonStyle(.borderedProminent)
    .tint(.primary)
  }
}
