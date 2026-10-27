import SwiftUI

struct ChatCardSurface: ViewModifier {
  @Environment(\.colorScheme) private var colorScheme

  func body(content: Content) -> some View {
    content
      .background(
        Color(uiColor: colorScheme == .dark ? .secondarySystemBackground : .systemBackground),
        in: RoundedRectangle(cornerRadius: 16)
      )
      .overlay {
        RoundedRectangle(cornerRadius: 16)
          .strokeBorder(Color(uiColor: .separator).opacity(0.4), lineWidth: 0.5)
          .allowsHitTesting(false)
      }
  }
}

struct ChatCardHeader<Details: View>: View {
  let title: String
  let systemImage: String
  var titleLineLimit: Int? = nil
  @ViewBuilder let details: () -> Details
  @ScaledMetric(relativeTo: .subheadline) private var titleSize: CGFloat = 15
  @ScaledMetric(relativeTo: .subheadline) private var bodySize: CGFloat = 14
  @ScaledMetric(relativeTo: .body) private var iconSize: CGFloat = 40
  @ScaledMetric(relativeTo: .body) private var symbolSize: CGFloat = 22

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.system(size: symbolSize))
        .foregroundStyle(.secondary)
        .frame(width: iconSize, height: iconSize)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Group {
          if let titleLineLimit {
            Text(title).lineLimit(titleLineLimit, reservesSpace: true)
          } else {
            Text(title)
          }
        }
        .font(.system(size: titleSize, weight: .medium)).foregroundStyle(.primary)
        details().font(.system(size: bodySize)).foregroundStyle(.secondary)
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
  @ScaledMetric(relativeTo: .body) private var minimumActionHeight: CGFloat = 44

  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        verticalContent
      } else {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 12) {
            information().frame(maxWidth: .infinity, alignment: .leading)
            actions()
          }
          .frame(minWidth: 608, minHeight: 64)
          verticalContent
        }
      }
    }
    .buttonStyle(ChatCardButtonStyle())
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .modifier(ChatCardSurface())
  }

  private var verticalContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      information().frame(minHeight: 64, alignment: .leading)
      actions().frame(minHeight: minimumActionHeight, alignment: .leading)
    }
    .frame(maxWidth: .infinity, minHeight: minimumContentHeight, alignment: .topLeading)
  }
}

struct ChatCardButtonStyle: ButtonStyle {
  enum Emphasis { case standard, detail }
  var emphasis: Emphasis = .standard
  @Environment(\.isEnabled) private var isEnabled
  @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15
  @ScaledMetric(relativeTo: .body) private var minimumHeight: CGFloat = 44

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: fontSize, weight: .medium))
      .foregroundStyle(isEnabled ? Color.primary : Color.secondary)
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: emphasis == .standard ? .infinity : nil, minHeight: minimumHeight)
      .background(
        emphasis == .standard ? Color(uiColor: .systemBackground) : .clear,
        in: RoundedRectangle(cornerRadius: 8)
      )
      .overlay {
        if emphasis == .standard {
          RoundedRectangle(cornerRadius: 8)
            .strokeBorder(Color(uiColor: .separator).opacity(0.4), lineWidth: 0.5)
            .allowsHitTesting(false)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: 8))
      .opacity(configuration.isPressed ? 0.65 : 1)
  }
}
