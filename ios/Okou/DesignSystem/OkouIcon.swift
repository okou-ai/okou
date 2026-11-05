import SwiftUI
import UIKit

/// Lucide artwork shared with Web. The visual size is separate from the hit target.
struct OkouIcon: View {
  let name: String
  @ScaledMetric(relativeTo: .body) private var scaledSize: CGFloat = 20

  init(_ name: String, size: CGFloat = OkouIconSize.standard) {
    self.name = name
    _scaledSize = ScaledMetric(wrappedValue: size, relativeTo: .body)
  }

  var body: some View {
    Image(Self.assetName(for: name))
      .resizable()
      .renderingMode(.template)
      .scaledToFit()
      .frame(width: scaledSize, height: scaledSize)
      .accessibilityHidden(true)
  }

  nonisolated static func assetName(for name: String) -> String {
    assert(
      OkouIconAssets.names.contains(name),
      "Register the icon in DesignSystem/icons.json: \(name)")
    return "Lucide-" + name
  }

  /// The compiled vector is intrinsically menu-sized; UIKit ignores SwiftUI frames.
  nonisolated static func uiImage(_ name: String) -> UIImage? {
    UIImage(named: assetName(for: name))?.withRenderingMode(.alwaysTemplate)
  }
}

/// Fixed-action glyphs scale moderately without outgrowing native circular controls.
struct OkouToolbarIcon: View {
  let name: String
  init(_ name: String) { self.name = name }
  var body: some View {
    OkouIcon(name, size: OkouIconSize.toolbar)
      .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
  }
}

@MainActor
extension Label where Title == Text, Icon == OkouIcon {
  init(_ title: LocalizedStringKey, okouSymbol: String, iconSize: CGFloat = OkouIconSize.standard) {
    self.init {
      Text(title)
    } icon: {
      OkouIcon(okouSymbol, size: iconSize)
    }
  }

  // Disfavored like SwiftUI's own String overloads, so a literal title resolves to the
  // LocalizedStringKey initializer and is extracted and localized.
  @_disfavoredOverload
  init<S: StringProtocol>(_ title: S, okouSymbol: String, iconSize: CGFloat = OkouIconSize.standard)
  {
    self.init {
      Text(title)
    } icon: {
      OkouIcon(okouSymbol, size: iconSize)
    }
  }
}

@MainActor
extension Button where Label == SwiftUI.Label<Text, OkouIcon> {
  init(
    _ title: LocalizedStringKey, okouSymbol: String, role: ButtonRole? = nil,
    action: @escaping () -> Void
  ) {
    self.init(role: role, action: action) { SwiftUI.Label(title, okouSymbol: okouSymbol) }
  }

  @_disfavoredOverload
  init<S: StringProtocol>(
    _ title: S, okouSymbol: String, role: ButtonRole? = nil, action: @escaping () -> Void
  ) {
    self.init(role: role, action: action) { SwiftUI.Label(title, okouSymbol: okouSymbol) }
  }
}

/// An empty, failed or unavailable screen or panel, drawn as quietly as the web's
/// (`load-error.tsx`): a muted glyph on a soft circle, a 17 pt medium title, a 15 pt muted
/// description at a readable width, and at most one or two outline actions. It sets its own
/// type and colours, so a parent's font or foreground never makes it loud; a failed read is
/// not an alarm, so it is never red.
struct OkouEmptyState<Actions: View>: View {
  let title: Text
  let icon: String
  var description: Text? = nil
  let actions: Actions

  init(
    _ title: LocalizedStringKey, icon: String, description: Text? = nil,
    @ViewBuilder actions: () -> Actions
  ) {
    self.init(title: Text(title), icon: icon, description: description, actions: actions)
  }

  /// A title that is content rather than copy, such as a file name.
  init(
    verbatim title: String, icon: String, description: Text? = nil,
    @ViewBuilder actions: () -> Actions
  ) {
    self.init(title: Text(verbatim: title), icon: icon, description: description, actions: actions)
  }

  private init(
    title: Text, icon: String, description: Text?, @ViewBuilder actions: () -> Actions
  ) {
    self.title = title
    self.icon = icon
    self.description = description
    self.actions = actions()
  }

  var body: some View {
    VStack(spacing: OkouSpace.lg) {
      OkouIcon(icon, size: OkouIconSize.emptyState)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(width: OkouControl.emptyStateMark, height: OkouControl.emptyStateMark)
        .background(OkouColor.stateHover, in: Circle())
        .accessibilityHidden(true)
      VStack(spacing: OkouSpace.xs) {
        title
          .font(.okou(.body).weight(.medium))
          .foregroundStyle(OkouColor.foreground)
          .accessibilityAddTraits(.isHeader)
        if let description {
          description
            .font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .multilineTextAlignment(.center)
      HStack(spacing: OkouSpace.sm) { actions }
        .fixedSize()
    }
    .frame(maxWidth: OkouControl.emptyStateWidth)
    .padding(OkouSpace.xxl)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

extension OkouEmptyState where Actions == EmptyView {
  init(_ title: LocalizedStringKey, icon: String, description: Text? = nil) {
    self.init(title, icon: icon, description: description) { EmptyView() }
  }
}
