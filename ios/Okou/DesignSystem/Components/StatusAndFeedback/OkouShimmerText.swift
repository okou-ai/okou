import SwiftUI

/// Text whose work is still going, such as a working chat's title in the sidebar: the text in the
/// full text colour with a soft-edged band of placeholder grey sweeping left to right once
/// every `OkouMotion.shimmerText` seconds. The title stays readable at rest and only part of
/// it lightens at a time, fading in and out with no hard edge, so a working chat is
/// obvious without a separate mark. Only the gradient moves, never the glyphs, so the words
/// stay sharp and in place. Under Reduce Motion nothing travels: the text breathes as a
/// skeleton does (1 → 0.7 → 1 over two seconds).
struct OkouShimmerText: ViewModifier {
  var isActive = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func body(content: Content) -> some View {
    if isActive {
      TimelineView(.animation) { context in
        let time = context.date.timeIntervalSinceReferenceDate
        if reduceMotion {
          content.opacity(Self.breath(at: time))
        } else {
          content.foregroundStyle(Self.band(at: time))
        }
      }
    } else {
      content
    }
  }

  /// The full text colour to 28 %, fading to placeholder grey by 40 %, grey to 60 % and back by
  /// 72 %, on a gradient twice the text's width: a band nearly as wide as the text with a grey
  /// core about two fifths wide and soft edges either side.
  private static let resting = OkouColor.foreground
  private static let stops: [Gradient.Stop] = [
    .init(color: resting, location: 0), .init(color: resting, location: 0.28),
    .init(color: OkouColor.placeholder, location: 0.4),
    .init(color: OkouColor.placeholder, location: 0.6),
    .init(color: resting, location: 0.72), .init(color: resting, location: 1),
  ]

  /// The band's centre travels 0 → 2 text widths per cycle; once it has left, the next band
  /// (one cycle behind, two widths to the left) takes over, so the loop has no seam. Between
  /// crossings the title rests in its full colour for a moment.
  private static func band(at time: TimeInterval) -> LinearGradient {
    let progress = (time / OkouMotion.shimmerText).truncatingRemainder(dividingBy: 1)
    var center = progress * 2
    if center > 1.5 { center -= 2 }
    return LinearGradient(
      stops: stops, startPoint: UnitPoint(x: center - 1, y: 0.5),
      endPoint: UnitPoint(x: center + 1, y: 0.5))
  }

  private static func breath(at time: TimeInterval) -> Double {
    let phase = 0.5 - cos(2 * .pi * time / OkouMotion.skeletonPulse) / 2
    return 1 - (1 - OkouMotion.skeletonDim) * phase
  }
}

extension View {
  /// Marks text as still working (`OkouShimmerText`); `false` leaves it as it is.
  func okouShimmerText(_ isActive: Bool = true) -> some View {
    modifier(OkouShimmerText(isActive: isActive))
  }
}
