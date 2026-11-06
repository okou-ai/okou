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

/// A provider button's content: the provider's own mark in a fixed 20 pt slot on the leading
/// edge and the title centred across the button, balanced by an empty slot on the trailing
/// edge, so every provider's title sits on the same centre line whatever its mark.
struct OkouProviderLabel<Mark: View>: View {
  let title: Text
  @ViewBuilder let mark: () -> Mark

  init(_ title: Text, @ViewBuilder mark: @escaping () -> Mark) {
    self.title = title
    self.mark = mark
  }

  var body: some View {
    HStack {
      mark()
        .frame(width: OkouIconSize.providerMark, height: OkouIconSize.providerMark)
        .accessibilityHidden(true)
      Spacer(minLength: OkouSpace.sm)
      title
      Spacer(minLength: OkouSpace.sm)
      Color.clear.frame(width: OkouIconSize.providerMark, height: OkouIconSize.providerMark)
    }
  }
}
