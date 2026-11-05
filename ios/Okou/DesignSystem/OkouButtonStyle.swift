import SwiftUI

/// A filled primary action or the web's outline button (background fill, gray-400 edge).
/// `isCompact` is for two actions side by side on a card (a connector's Connect and
/// Permissions): 15 pt text, 44 pt tall, one line.
struct OkouButtonStyle: ButtonStyle {
  let isPrimary: Bool
  var isCompact = false
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous)
    configuration.label
      .font(isCompact ? .okou(.subheadline).weight(.semibold) : .okou(.body).weight(.semibold))
      .lineLimit(isCompact ? 1 : nil)
      .foregroundStyle(labelColor(role: configuration.role))
      .padding(.horizontal, isCompact ? OkouSpace.md : OkouSpace.xl)
      .padding(.vertical, isCompact ? OkouSpace.sm : OkouSpace.md)
      .frame(
        maxWidth: .infinity,
        minHeight: isCompact ? OkouControl.minimumTarget : OkouControl.largeHeight
      )
      .background(fill(pressed: configuration.isPressed), in: shape)
      .overlay {
        shape
          .fill(!isPrimary && configuration.isPressed ? OkouColor.statePressed : .clear)
          .allowsHitTesting(false)
      }
      .overlay {
        shape.strokeBorder(isPrimary ? .clear : OkouColor.gray400, lineWidth: OkouSpace.hairline)
      }
      .contentShape(shape)
      .opacity(isEnabled ? 1 : 0.5)
      .animation(reduceMotion ? nil : OkouMotion.press, value: configuration.isPressed)
  }

  /// A destructive action keeps the outline and turns its label red (Remove, Delete).
  private func labelColor(role: ButtonRole?) -> Color {
    if isPrimary {
      return OkouColor.primaryForeground
    }
    if role == .destructive {
      return OkouColor.destructive
    }
    return OkouColor.foreground
  }

  private func fill(pressed: Bool) -> Color {
    if !isPrimary {
      return OkouColor.background
    }
    if pressed {
      return OkouColor.primaryPressed
    }
    return OkouColor.primary
  }
}

/// The label of a compact button: a 16 pt glyph 6 pt before the title, so two side-by-side
/// actions keep their whole titles (a 20 pt glyph and the system Label gap cut them off).
struct OkouCompactButtonLabel: View {
  let title: LocalizedStringKey
  let icon: String

  init(_ title: LocalizedStringKey, icon: String) {
    self.title = title
    self.icon = icon
  }

  var body: some View {
    HStack(spacing: OkouSpace.six) {
      OkouIcon(icon, size: OkouIconSize.inline)
        .accessibilityHidden(true)
      Text(title)
    }
  }
}
