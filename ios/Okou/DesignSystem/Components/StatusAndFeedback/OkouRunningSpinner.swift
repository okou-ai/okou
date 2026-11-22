import SwiftUI

/// A chat at work, in the sidebar: a `running` arc turning on a faint track of the same blue,
/// once per `OkouMotion.runningSpin`. Its shape, not its shade, sets it apart from the unread
/// dot, so a working chat still reads in a still frame. It is drawn, not a system spinner, so
/// under Reduce Motion it holds still as a longer arc instead of turning. Every spinner shares
/// one clock, so a list of working chats turns together.
struct OkouRunningSpinner: View {
  var size: CGFloat = OkouIconSize.runningIndicator
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    let side = size * scale
    let line = max(OkouSpace.one + OkouSpace.hairline, side / 7)
    TimelineView(.animation(paused: reduceMotion)) { context in
      ZStack {
        Circle()
          .stroke(OkouStatusColor.running.opacity(0.2), lineWidth: line)
        Circle()
          .trim(from: 0, to: reduceMotion ? 0.7 : 0.28)
          .stroke(OkouStatusColor.running, style: StrokeStyle(lineWidth: line, lineCap: .round))
          .rotationEffect(.degrees(reduceMotion ? -90 : Self.turn(at: context.date) * 360 - 90))
      }
      .padding(line / 2)
      .frame(width: side, height: side)
    }
    .accessibilityHidden(true)
  }

  private static func turn(at date: Date) -> Double {
    let value = date.timeIntervalSinceReferenceDate / OkouMotion.runningSpin
    return value - value.rounded(.down)
  }
}

/// A working chat inside a folded project: a small `OkouRunningSpinner` over the folder's
/// top-right corner, where `OkouUnreadBadge` puts its dot, with a cut ring that keeps it clear of
/// the strokes it covers. The project row shows one badge, and unread wins.
struct OkouRunningBadge: ViewModifier {
  let isVisible: Bool

  func body(content: Content) -> some View {
    content.overlay(alignment: .topTrailing) {
      if isVisible {
        OkouRunningSpinner(size: OkouIconSize.runningBadge)
          .background {
            Circle()
              .padding(-OkouSpace.two)
              .blendMode(.destinationOut)
          }
          .offset(x: OkouSpace.three, y: -OkouSpace.three)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    .compositingGroup()
  }
}
