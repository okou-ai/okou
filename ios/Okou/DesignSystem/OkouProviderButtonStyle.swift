import SwiftUI

struct OkouProviderButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.okou(.body).weight(.medium))
      .foregroundStyle(OkouColor.foreground)
      .padding(.horizontal, OkouSpace.lg).padding(.vertical, OkouSpace.md)
      .frame(maxWidth: .infinity, minHeight: OkouControl.largeHeight)
      .background(OkouColor.card, in: RoundedRectangle(cornerRadius: OkouRadius.control))
      .overlay {
        RoundedRectangle(cornerRadius: OkouRadius.control)
          .fill(configuration.isPressed ? OkouColor.statePressed : .clear).allowsHitTesting(false)
      }
      .overlay {
        RoundedRectangle(cornerRadius: OkouRadius.control)
          .strokeBorder(OkouColor.controlBorder, lineWidth: OkouSpace.hairline).allowsHitTesting(
            false)
      }
      .contentShape(RoundedRectangle(cornerRadius: OkouRadius.control))
      .opacity(isEnabled ? 1 : 0.5)
  }
}
