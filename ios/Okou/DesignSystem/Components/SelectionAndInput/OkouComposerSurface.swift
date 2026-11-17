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
      .overlay(alignment: .bottomLeading) {
        leading()
          .padding(.bottom, isExpanded ? OkouSpace.six : 0)
      }
      .overlay(alignment: .bottomTrailing) {
        trailing()
          // Resolve motion at the toolbar so fading controls inherit its animated
          // position while the keyboard raises the surface.
          .geometryGroup()
          .padding(.leading, isExpanded ? actionSize + OkouSpace.xs : 0)
          .padding(.bottom, isExpanded ? OkouSpace.six : 0)
      }
  }
}

/// The open composer's model control, beside the mic as Web's narrow composer draws it: the
/// model's company mark, or `cpu` for a model the catalog does not know, on the 44 pt toolbar
/// target. The name, effort and Fast belong to its VoiceOver value and the model sheet.
struct OkouComposerModelMark: View {
  enum Mark {
    /// Okou's own mark, for Auto and built-in models.
    case okou
    /// A company's mark asset, drawn edge to edge.
    case company(String)
    case icon(String)
  }

  let mark: Mark
  @ScaledMetric(relativeTo: .body) private var brandSize = OkouIconSize.toolbarMark

  var body: some View {
    Group {
      switch mark {
      case .okou:
        brand(OkouBrand.symbol, size: brandSize / OkouBrand.symbolArtworkRatio)
      case .company(let asset):
        brand(asset, size: brandSize)
      case .icon(let name):
        OkouIcon(name, size: OkouIconSize.toolbar)
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
    .frame(width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
    .contentShape(Circle())
  }

  private func brand(_ asset: String, size: CGFloat) -> some View {
    Image(asset)
      .resizable()
      .renderingMode(.template)
      .scaledToFit()
      .frame(width: size, height: size)
      .accessibilityHidden(true)
  }
}
