import SwiftUI

/// A live dictation waveform, as ChatGPT and Voice Memos draw one: a bar per level sample,
/// the newest entering at the trailing edge while the strip glides toward the leading edge
/// and fades out there. Slots before the first sample are dots on the baseline, so the
/// strip has its full length from the first frame. The newest bar grows into its height
/// instead of popping, and the strip moves every frame rather than once per sample.
struct OkouLiveWaveform: View {
  /// Loudness from 0 to 1, oldest first.
  let levels: [Float]
  /// When the newest level arrived; the strip moves one bar per `interval`.
  let lastSampleAt: Date
  let interval: TimeInterval
  var isLive = true
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    TimelineView(.animation(paused: !isLive || reduceMotion)) { context in
      Canvas { canvas, size in
        draw(in: &canvas, size: size, now: context.date)
      }
    }
    .mask {
      HStack(spacing: 0) {
        LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
          .frame(width: OkouSpace.xxl)
        Color.black
      }
    }
    .accessibilityHidden(true)
  }

  private func draw(in canvas: inout GraphicsContext, size: CGSize, now: Date) {
    let bar = OkouControl.waveformBar
    let step = bar + OkouControl.waveformGap
    var progress: CGFloat = 1
    if isLive && !reduceMotion {
      progress = min(max(now.timeIntervalSince(lastSampleAt) / interval, 0), 1)
    }
    let shortest = bar
    let tallest = size.height
    let slots = Int(size.width / step) + 2
    for slot in 0..<slots {
      let x = size.width - bar - (CGFloat(slot) + progress) * step
      if x < -bar { break }
      let index = levels.count - 1 - slot
      var height = shortest
      var color = OkouColor.mutedForeground.opacity(0.35)
      if index >= 0 {
        // A gentle curve lifts quiet speech without flattening loud speech.
        let level = CGFloat(pow(levels[index], 0.8))
        height = shortest + level * (tallest - shortest)
        if slot == 0 {
          // The newest bar rises over the first half of its interval.
          height = shortest + (height - shortest) * min(progress * 2, 1)
        }
        color = OkouColor.foreground
      }
      let rect = CGRect(x: x, y: (size.height - height) / 2, width: bar, height: height)
      canvas.fill(Path(roundedRect: rect, cornerRadius: bar / 2), with: .color(color))
    }
  }
}
