import SwiftUI

/// The transcript's thinking mark. The brush and keyframes come from Web's
/// `okou-thinking-mark-textured-dd139799c2a2.svg`; the silhouette is our shared brand mark.
struct OkouThinkingMark: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .subheadline) private var slot = OkouIconSize.inline
  @State private var started = Date.now

  private static let palette = [
    (ground: OkouBrand.color(0xFFA500), ink: OkouBrand.color(0xFF602F)),
    (ground: OkouBrand.color(0xFF602F), ink: OkouBrand.color(0xFFC6E2)),
    (ground: OkouBrand.color(0x3363D3), ink: OkouBrand.color(0xB4DEF5)),
    (ground: OkouBrand.color(0x008D76), ink: OkouBrand.color(0xBFE123))
  ]

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { timeline in
      artwork(at: reduceMotion ? 0 : max(0, timeline.date.timeIntervalSince(started)))
    }
    .frame(width: slot, height: slot)
    .accessibilityHidden(true)
  }

  private func artwork(at seconds: Double) -> some View {
    // Each palette holds for 1.44 s, then blends into the next over 0.56 s.
    let phase = seconds.truncatingRemainder(dividingBy: 8) / 2
    let index = Int(phase)
    let from = Self.palette[index]
    let to = Self.palette[(index + 1) % Self.palette.count]
    let blend = max(0, (phase - Double(index) - 0.72) / 0.28)
    let halfCycles = (seconds / 1.4).truncatingRemainder(dividingBy: 2)
    let breath = UnitCurve.easeInOut.value(at: 1 - abs(1 - halfCycles))
    let sweep = (seconds / 5.6).truncatingRemainder(dividingBy: 1)

    // Web centers a 17 pt canvas in a 16 pt slot. The mark spans x=5…44 in its 48-unit SVG.
    let canvas = slot * 17 / 16
    let width = canvas * 39 / 48
    let maskSize = width / OkouBrand.symbolArtworkRatio
    return ZStack {
      from.ground.mix(with: to.ground, by: blend, in: .device)
      Image("OkouThinkingTexture")
        .resizable()
        .foregroundStyle(from.ink.mix(with: to.ink, by: blend, in: .device))
        .opacity(reduceMotion ? 0.7 : 0.18 + 0.82 * breath)
      if sweep > 0.12 && sweep < 0.44 {
        sheen(phase: sweep, width: width)
      }
    }
    .frame(width: width, height: width * 803 / 800)
    .mask { Image(OkouBrand.symbol).resizable().frame(width: maskSize, height: maskSize) }
    .scaleEffect(1 + 0.06 * breath)
    .offset(x: canvas / 96)
  }

  private func sheen(phase: Double, width: CGFloat) -> some View {
    let position = UnitCurve.easeInOut.value(at: (phase - 0.12) / 0.32)
    let fade = min(1, (phase - 0.12) / 0.06, (0.44 - phase) / 0.06)
    return LinearGradient(
      stops: [
        .init(color: .white.opacity(0), location: 0.24),
        .init(color: .white.opacity(0.72), location: 0.48),
        .init(color: .white.opacity(0.9), location: 0.52),
        .init(color: .white.opacity(0), location: 0.76)
      ],
      startPoint: .topLeading, endPoint: UnitPoint(x: 1, y: 0.36)
    )
    .offset(x: width * (2.4 * position - 1.2))
    .opacity(0.65 * UnitCurve.easeInOut.value(at: fade))
  }
}
