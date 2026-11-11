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
      .overlay(alignment: .bottomLeading) {
        leading()
          .padding(.bottom, isExpanded ? OkouSpace.six : 0)
      }
      .overlay(alignment: .bottomTrailing) {
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

/// A value the open composer can change (the chat's model), beside the mic and send as Claude
/// and ChatGPT place theirs: the value in subheadline medium `foreground`, its detail in
/// subheadline `muted-foreground` ("GPT 6.1 Sol High"), a step under the 17 pt draft so it
/// never reads as part of it, and a chevron that says it opens a choice, on the 44 pt action
/// height. The value keeps its width and the detail gives way first.
struct OkouComposerValueLabel: View {
  let title: String
  var detail: String?

  var body: some View {
    HStack(spacing: OkouSpace.xs) {
      Text(verbatim: title)
        .font(.okou(.subheadline).weight(.medium))
        .foregroundStyle(OkouColor.foreground)
        .layoutPriority(1)
      if let detail {
        Text(verbatim: detail)
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
      }
      OkouIcon("chevron-down", size: OkouIconSize.badge)
        .foregroundStyle(OkouColor.mutedForeground)
    }
    .lineLimit(1)
    .padding(.horizontal, OkouSpace.sm)
    .frame(minHeight: OkouControl.minimumTarget)
    .contentShape(Rectangle())
  }
}
