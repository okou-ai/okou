import SwiftUI

struct ChatCardSurface: ViewModifier {
  func body(content: Content) -> some View {
    content.modifier(OkouSurfaceStyle(radius: OkouRadius.chat))
  }
}

/// A transcript card's heading, as the web draws it (`AssistantErrorCard`): a 16 pt glyph in
/// neutral supporting grey on the title's first line, no tile behind it; the title in callout medium and
/// every detail line in one supporting style. Callers do not restyle the details.
struct ChatCardHeader<Details: View>: View {
  let title: String
  let icon: String
  var titleLineLimit: Int? = nil
  @ViewBuilder let details: () -> Details
  /// One line of callout Geist, so the glyph centres on the title's first line.
  @ScaledMetric(relativeTo: .callout) private var titleLineHeight: CGFloat = 21

  var body: some View {
    HStack(alignment: .top, spacing: OkouSpace.ten) {
      OkouIcon(icon, size: OkouIconSize.inline)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(height: titleLineHeight)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: OkouSpace.two) {
        Group {
          if let titleLineLimit {
            Text(title).lineLimit(titleLineLimit)
          } else {
            Text(title)
          }
        }
        .font(.okou(.callout).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        details()
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
      }
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

struct ChatActionCard<Information: View, Actions: View>: View {
  @ViewBuilder let information: () -> Information
  @ViewBuilder let actions: () -> Actions
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .body) private var minimumContentHeight: CGFloat = 120
  @ScaledMetric(relativeTo: .body) private var minimumActionHeight = OkouControl.minimumTarget
  @ScaledMetric(relativeTo: .body) private var horizontalActionWidth: CGFloat = 208

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        verticalContent
      } else {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: OkouSpace.md) {
            information().frame(maxWidth: .infinity, alignment: .leading)
            actions().frame(width: horizontalActionWidth)
          }
          // Async labels must not choose a different responsive layout or text-column width.
          .frame(minWidth: 608, idealWidth: 608, maxWidth: .infinity, minHeight: 64)
          verticalContent
        }
      }
    }
    .buttonStyle(ChatCardButtonStyle())
    .padding(.horizontal, OkouSpace.lg)
    .padding(.vertical, OkouSpace.md)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(ChatCardSurface())
  }

  private var verticalContent: some View {
    VStack(alignment: .leading, spacing: OkouSpace.md) {
      information().frame(minHeight: 64, alignment: .leading)
      actions().frame(minHeight: minimumActionHeight, alignment: .leading)
    }
    .frame(maxWidth: .infinity, minHeight: minimumContentHeight, alignment: .topLeading)
  }
}

/// A card's actions: the web's small outline button (`gray-400` edge, background fill), the
/// card's one committing action filled with `primary`, or a bare text `detail`. Pressing lays
/// the pressed state over the fill; a destructive role (Discard, Deny) is drawn in red.
struct ChatCardButtonStyle: ButtonStyle {
  /// `primary` is the card's one committing action, such as Send or Allow.
  enum Emphasis { case standard, detail, primary }
  var emphasis: Emphasis = .standard
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .body) private var minimumHeight = OkouControl.minimumTarget

  func makeBody(configuration: Configuration) -> some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.small, style: .continuous)
    var width: CGFloat? = .infinity
    if emphasis == .detail {
      width = nil
    }
    return configuration.label
      .font(.okou(.subheadline).weight(.medium))
      .foregroundStyle(labelColor(role: configuration.role))
      .padding(.horizontal, OkouSpace.md)
      .padding(.vertical, OkouSpace.sm)
      .frame(maxWidth: width, minHeight: minimumHeight)
      .background(fill(pressed: configuration.isPressed), in: shape)
      .overlay {
        if emphasis == .standard {
          shape
            .fill(configuration.isPressed ? OkouColor.statePressed : Color.clear)
            .allowsHitTesting(false)
          shape
            .strokeBorder(OkouColor.gray400, lineWidth: OkouSpace.hairline)
            .allowsHitTesting(false)
        }
      }
      .opacity(opacity(pressed: configuration.isPressed))
      .contentShape(shape)
      .animation(reduceMotion ? nil : OkouMotion.press, value: configuration.isPressed)
  }

  private func labelColor(role: ButtonRole?) -> Color {
    if emphasis == .primary {
      return OkouColor.primaryForeground
    }
    if role == .destructive {
      return OkouColor.destructive
    }
    return OkouColor.foreground
  }

  private func fill(pressed: Bool) -> Color {
    switch emphasis {
    case .primary:
      if pressed {
        return OkouColor.primaryPressed
      }
      return OkouColor.primary
    case .standard:
      return OkouColor.background
    case .detail:
      return Color.clear
    }
  }

  private func opacity(pressed: Bool) -> Double {
    if !isEnabled {
      return 0.5
    }
    if emphasis == .detail && pressed {
      return 0.6
    }
    return 1
  }
}
