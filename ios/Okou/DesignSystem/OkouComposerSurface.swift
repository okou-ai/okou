import SwiftUI

/// The catalog and chat share one surface without replacing the mounted editor on expansion.
struct OkouComposerSurface<Content: View, Leading: View, Trailing: View>: View {
  var isExpanded = false
  @ViewBuilder let content: () -> Content
  @ViewBuilder let leading: () -> Leading
  @ViewBuilder let trailing: () -> Trailing

  @State private var trailingWidth = OkouControl.minimumTarget
  private let actionSize = OkouControl.minimumTarget
  private var cornerRadius: CGFloat {
    isExpanded ? 28 : OkouControl.composerCompactHeight / 2
  }

  var body: some View {
    content()
      .padding(.leading, isExpanded ? 18 : actionSize + OkouSpace.sm)
      .padding(.trailing, isExpanded ? 18 : trailingWidth + OkouSpace.sm)
      .padding(.top, isExpanded ? 17 : OkouSpace.six)
      .padding(.bottom, isExpanded ? 62 : OkouSpace.six)
      .frame(
        minHeight: isExpanded ? 116 : OkouControl.composerCompactHeight,
        alignment: isExpanded ? .topLeading : .leading
      )
      .glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius))
      .overlay(alignment: isExpanded ? .bottomLeading : .leading) {
        leading()
          .padding(.bottom, isExpanded ? OkouSpace.six : 0)
      }
      .overlay(alignment: isExpanded ? .bottomTrailing : .trailing) {
        trailing()
          .onGeometryChange(for: CGFloat.self) {
            $0.size.width
          } action: {
            trailingWidth = $0
          }
          .padding(.leading, isExpanded ? actionSize + OkouSpace.xs : 0)
          .padding(.bottom, isExpanded ? OkouSpace.six : 0)
      }
  }
}
