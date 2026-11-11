import SwiftUI

/// Text whose work is still going, such as a working chat's title in the sidebar: the text in the
/// placeholder grey with a band of the full text colour sweeping left to right once every
/// `OkouMotion.shimmerText` seconds. It is the web's `ShimmerText` made stronger for a list,
/// where a row is small and read at a glance: a lighter resting grey, a band about a third of
/// the text wide and a faster sweep, so a working chat is obvious without a separate mark. Only
/// the gradient moves, never the glyphs, so the words stay sharp and in place. Under Reduce
/// Motion nothing travels: the text breathes as a skeleton does (1 → 0.7 → 1 over two seconds).
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

  /// Placeholder grey flat to 30 %, the full text colour across 42–58 % (a core about a third
  /// of the text wide) and back by 70 %, on a gradient twice the text's width.
  private static let resting = OkouColor.placeholder
  private static let stops: [Gradient.Stop] = [
    .init(color: resting, location: 0), .init(color: resting, location: 0.3),
    .init(color: OkouColor.foreground, location: 0.42),
    .init(color: OkouColor.foreground, location: 0.58),
    .init(color: resting, location: 0.7), .init(color: resting, location: 1),
  ]

  /// The band's centre travels 0 → 2 text widths per cycle; once it has left, the next band
  /// (one cycle behind, two widths to the left) takes over, so the loop has no seam and a band
  /// is crossing the text for nearly all of every cycle.
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
