import SwiftUI

/// The catalog and chat share one surface without replacing the mounted editor on expansion.
struct OkouComposerSurface<Content: View, Leading: View, Trailing: View>: View {
  var isExpanded = false
  @ViewBuilder let content: () -> Content
  @ViewBuilder let leading: () -> Leading
  @ViewBuilder let trailing: () -> Trailing

  private let actionSize = OkouControl.minimumTarget
  private var cornerRadius: CGFloat {
    isExpanded ? 28 : OkouControl.composerCompactHeight / 2
  }

  var body: some View {
    content()
      .padding(.leading, isExpanded ? 18 : actionSize + OkouSpace.sm)
      // Only the primary action shares the compact input's line. Hidden expansion
      // controls keep their toolbar geometry without reserving space in the editor.
      .padding(.trailing, isExpanded ? 18 : actionSize + OkouSpace.sm)
      .padding(.top, isExpanded ? 17 : OkouSpace.six)
      .padding(.bottom, isExpanded ? 62 : OkouSpace.six)
      .frame(
        minHeight: isExpanded ? 116 : OkouControl.composerCompactHeight,
        alignment: isExpanded ? .topLeading : .leading
      )
      .glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius))
      .overlay(alignment: .bottom) {
        HStack(spacing: OkouSpace.xs) {
          leading()
            .frame(maxWidth: .infinity, alignment: .leading)
          trailing()
            .fixedSize(horizontal: true, vertical: false)
        }
        // Resolve motion at the toolbar so fading controls inherit its animated
        // position while the keyboard raises the surface.
        .geometryGroup()
        .padding(.bottom, isExpanded ? OkouSpace.six : 0)
      }
  }
}

/// A quiet model note above the composer: supporting text, an optional Fast mark and a
/// disclosure chevron. Its 44 pt target stays separate from the glass input surface.
struct OkouComposerValueLabel: View {
  let title: String
  var isFast = false

  var body: some View {
    HStack(spacing: OkouSpace.xs) {
      Text(verbatim: title)
        .font(.okou(.footnote))
        .layoutPriority(1)
      if isFast {
        OkouIcon("zap", size: OkouIconSize.badge)
      }
      OkouIcon("chevron-down", size: OkouIconSize.badge)
    }
    .foregroundStyle(OkouColor.mutedForeground)
    .lineLimit(1)
    .padding(.horizontal, OkouSpace.sm)
    .frame(minHeight: OkouControl.minimumTarget)
    .contentShape(Rectangle())
  }
}
