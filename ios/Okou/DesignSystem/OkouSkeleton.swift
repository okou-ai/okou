import SwiftUI

/// A placeholder block in the web's `skeleton` grey (gray-200), breathing as the web's
/// `okou-skeleton-pulse` does: opacity 1 → 0.7 → 1 over two seconds. Still under Reduce Motion.
struct OkouSkeletonBlock: View {
  var width: CGFloat? = nil
  let height: CGFloat
  var radius: CGFloat = OkouRadius.small
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dimmed = false

  var body: some View {
    RoundedRectangle(cornerRadius: radius, style: .continuous)
      .fill(OkouColor.skeleton)
      .frame(width: width, height: height)
      .opacity(dimmed ? OkouMotion.skeletonDim : 1)
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(.easeInOut(duration: OkouMotion.skeletonPulse / 2).repeatForever()) {
          dimmed = true
        }
      }
  }
}

/// A chat while its first messages load, as the web draws it: two exchanges of a user bubble
/// on the trailing side and an answer under a small avatar, the second shorter, instead of a
/// spinner in an empty page.
struct OkouChatSkeleton: View {
  var body: some View {
    GeometryReader { geometry in
      let width = geometry.size.width
      VStack(alignment: .leading, spacing: OkouSpace.xxl) {
        exchange(width: width, compact: false)
        exchange(width: width, compact: true)
      }
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .accessibilityElement()
    .accessibilityLabel("Loading chat")
  }

  @ViewBuilder
  private func exchange(width: CGFloat, compact: Bool) -> some View {
    HStack {
      Spacer(minLength: 0)
      OkouSkeletonBlock(
        width: width * (compact ? 0.45 : 0.6), height: OkouControl.skeletonBubble,
        radius: OkouRadius.control)
    }
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      OkouSkeletonBlock(
        width: OkouAvatarSize.message, height: OkouAvatarSize.message, radius: OkouRadius.small)
      OkouSkeletonBlock(width: width * (compact ? 0.85 : 0.9), height: OkouControl.skeletonLine)
      OkouSkeletonBlock(width: width * (compact ? 0.6 : 0.75), height: OkouControl.skeletonLine)
      if !compact {
        OkouSkeletonBlock(width: width * 0.4, height: OkouControl.skeletonLine)
      }
    }
  }
}
