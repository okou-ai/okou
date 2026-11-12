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
      "Register the icon in DesignSystem/Foundations/icons.json: \(name)")
    return "Lucide-" + name
  }

  /// The compiled vector is intrinsically menu-sized; UIKit ignores SwiftUI frames.
  nonisolated static func uiImage(_ name: String) -> UIImage? {
    UIImage(named: assetName(for: name))?.withRenderingMode(.alwaysTemplate)
  }
}

/// A glyph on the first line of the text beside it, in an `HStack` aligned on
/// `.firstTextBaseline`. A glyph has no baseline of its own, so placed directly it sits on the
/// text's baseline and rides high; this centres it in an empty line of the same font, whose
/// baseline is the text's, so it stays mid-line at every text size and on the first line when
/// the text wraps.
struct OkouLineIcon<Glyph: View>: View {
  let font: Font
  let width: CGFloat
  @ViewBuilder let glyph: () -> Glyph

  init(
    font: Font, width: CGFloat = OkouIconSize.standard, @ViewBuilder glyph: @escaping () -> Glyph
  ) {
    self.font = font
    self.width = width
    self.glyph = glyph
  }

  var body: some View {
    Text(verbatim: " ")
      .font(font)
      .hidden()
      .frame(width: width)
      .overlay { glyph() }
      .accessibilityHidden(true)
  }
}

extension OkouLineIcon where Glyph == OkouIcon {
  init(_ name: String, font: Font, size: CGFloat = OkouIconSize.standard) {
    self.init(font: font, width: size) { OkouIcon(name, size: size) }
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
