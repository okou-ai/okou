import SwiftUI

/// A placeholder shape in the web's `skeleton` grey (gray-200). It does not move on its own:
/// the group it belongs to shimmers as one (`okouShimmer()`), so a light passes over every
/// block of a skeleton together.
struct OkouSkeletonBlock: View {
  var width: CGFloat? = nil
  /// Without a size the block fills the frame it is offered (a picture's place).
  var height: CGFloat? = nil
  var radius: CGFloat = OkouRadius.small

  var body: some View {
    RoundedRectangle(cornerRadius: radius, style: .continuous)
      .fill(OkouColor.skeleton)
      .frame(width: width, height: height)
  }
}

/// A loading skeleton's motion, as feeds and media apps draw it: one soft, slightly slanted
/// band of light crosses every block of the group at once, left to right, every
/// `OkouMotion.shimmer` seconds with a short rest, so the group reads as one thing arriving.
/// The band only lifts the grey a little — it never washes a block out. Under Reduce Motion
/// nothing travels: the group breathes as the web's `okou-skeleton-pulse` does (1 → 0.7 → 1
/// over two seconds).
///
/// `masked` keeps the light on the group's own shapes (grey blocks); a picture's place is a
/// translucent state layer, so its light covers the whole frame and the frame clips it.
struct OkouShimmer: ViewModifier {
  var masked = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dimmed = false

  func body(content: Content) -> some View {
    content
      .overlay {
        if !reduceMotion {
          if masked {
            OkouShimmerBand().mask { content }
          } else {
            OkouShimmerBand()
          }
        }
      }
      .opacity(dimmed ? OkouMotion.skeletonDim : 1)
      .onAppear {
        guard reduceMotion else { return }
        withAnimation(.easeInOut(duration: OkouMotion.skeletonPulse / 2).repeatForever()) {
          dimmed = true
        }
      }
  }
}

/// The travelling light of `OkouShimmer`.
private struct OkouShimmerBand: View {
  @State private var phase: CGFloat = 0

  var body: some View {
    GeometryReader { geometry in
      let band = max(geometry.size.width * OkouMotion.shimmerBand, OkouSpace.xxxl * 3)
      // The band starts beyond the leading edge and leaves past the trailing one, with a short
      // rest before it comes round again.
      let travel = geometry.size.width + band * 2.5
      LinearGradient(
        stops: [
          .init(color: .clear, location: 0),
          .init(color: OkouColor.background.opacity(OkouMotion.shimmerStrength), location: 0.5),
          .init(color: .clear, location: 1),
        ],
        startPoint: .leading, endPoint: .trailing
      )
      .frame(width: band, height: geometry.size.height * 2)
      .rotationEffect(.degrees(OkouMotion.shimmerSlant))
      .offset(x: -band + travel * phase, y: -geometry.size.height / 2)
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
    .onAppear {
      withAnimation(.linear(duration: OkouMotion.shimmer).repeatForever(autoreverses: false)) {
        phase = 1
      }
    }
  }
}

extension View {
  /// Gives a skeleton its one shared loading motion (`OkouShimmer`).
  func okouShimmer(masked: Bool = true) -> some View { modifier(OkouShimmer(masked: masked)) }
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
      .okouShimmer()
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
