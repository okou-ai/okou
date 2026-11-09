import SwiftUI

/// The web's running indicator (`running-indicator.tsx`): a breathing dot with a ring that
/// spreads once per 2.4 s cycle. Every indicator shares one clock, and `phaseOffset` lets a
/// list trail row by row (the web uses rowIndex / 12), so running chats move as a wave.
struct OkouRunningIndicator: View {
  var phaseOffset: Double = 0
  @ScaledMetric(relativeTo: .body) private var size = OkouIconSize.runningIndicator
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private static let cycle = OkouMotion.runningCycle

  var body: some View {
    TimelineView(.animation(paused: reduceMotion)) { context in
      let phase = Self.phase(at: context.date, offset: phaseOffset)
      let center = reduceMotion ? (scale: 0.76, opacity: 0.5) : Self.center(phase)
      let ripple = reduceMotion ? (scale: 0.8, opacity: 0.0) : Self.ripple(phase)
      ZStack {
        Circle()
          .fill(OkouStatusColor.running)
          .frame(width: size - 5, height: size - 5)
          .scaleEffect(center.scale)
          .opacity(center.opacity)
        Circle()
          .strokeBorder(OkouStatusColor.running, lineWidth: 1)
          .frame(width: size - 3, height: size - 3)
          .scaleEffect(ripple.scale)
          .opacity(ripple.opacity)
      }
      .frame(width: size, height: size)
    }
    .accessibilityHidden(true)
  }

  private static func phase(at date: Date, offset: Double) -> Double {
    let value = date.timeIntervalSinceReferenceDate / cycle - offset
    return value - value.rounded(.down)
  }

  /// `running-indicator-center`: 0.64 / 34 % at rest, 0.88 / 52 % at 52 % of the cycle.
  private static func center(_ phase: Double) -> (scale: Double, opacity: Double) {
    let rising = phase < 0.52
    let eased = easeInOut(rising ? phase / 0.52 : (phase - 0.52) / 0.48)
    let amount = rising ? eased : 1 - eased
    return (0.64 + 0.24 * amount, 0.34 + 0.18 * amount)
  }

  /// `running-indicator-ripple`: hidden until 45 %, appears by 52 %, then spreads to 1.56× and
  /// fades with ease-out.
  private static func ripple(_ phase: Double) -> (scale: Double, opacity: Double) {
    if phase < 0.45 { return (0.8, 0) }
    if phase < 0.52 { return (0.8, 0.34 * (phase - 0.45) / 0.07) }
    let progress = (phase - 0.52) / 0.48
    let eased = 1 - (1 - progress) * (1 - progress)
    return (0.8 + 0.76 * eased, 0.34 * (1 - eased))
  }

  /// Close to the web's cubic-bezier(0.33, 0, 0.66, 1).
  private static func easeInOut(_ value: Double) -> Double {
    0.5 - cos(.pi * min(max(value, 0), 1)) / 2
  }
}
