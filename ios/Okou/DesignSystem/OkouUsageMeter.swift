import SwiftUI

/// An allowance row: name on the left, "80% remaining" on the right, a capacity bar that fills
/// with what is left, and when it resets. One direction ("remaining") everywhere, as Codex and
/// a battery read; the bar turns orange at 25 % and red when the limit is reached.
struct OkouUsageMeter: View {
  let title: LocalizedStringKey
  /// Percent remaining, 0–100.
  let remaining: Double
  var resetsAt: Date? = nil
  @ScaledMetric(relativeTo: .body) private var barHeight = OkouControl.meterHeight

  enum Tone { case normal, low, exhausted }

  static func tone(_ remaining: Double) -> Tone {
    if remaining <= 0 { return .exhausted }
    return remaining <= 25 ? .low : .normal
  }

  private var tone: Tone { Self.tone(remaining) }

  private var fill: Color {
    switch tone {
    case .normal: OkouColor.foreground
    case .low: OkouStatusColor.warning
    case .exhausted: OkouColor.destructive
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.six) {
      HStack(alignment: .firstTextBaseline) {
        Text(title).font(.okou(.body))
        Spacer(minLength: OkouSpace.sm)
        Group {
          if tone == .exhausted {
            Text("Limit reached").foregroundStyle(OkouColor.destructive)
          } else {
            Text("\(remaining, specifier: "%.0f")% remaining")
              .foregroundStyle(tone == .low ? OkouStatusColor.warning : OkouColor.mutedForeground)
          }
        }
        .font(.okou(.subheadline).monospacedDigit())
      }
      GeometryReader { geometry in
        ZStack(alignment: .leading) {
          Capsule().fill(OkouColor.nestedFill)
          Capsule().fill(fill)
            .frame(width: geometry.size.width * min(max(remaining, 0), 100) / 100)
        }
      }
      .frame(height: barHeight)
      if let resetsAt {
        TimelineView(.everyMinute) { context in
          Text(Self.resetText(resetsAt, now: context.date))
            .font(.okou(.caption))
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
    }
    .padding(.vertical, OkouSpace.xs)
    .accessibilityElement(children: .combine)
  }

  /// Under a day: "Resets in 2 hr 10 min"; otherwise the weekday and time, "Resets Thu 9:00 AM".
  static func resetText(_ date: Date, now: Date = .now) -> String {
    let interval = date.timeIntervalSince(now)
    if interval <= 60 { return String(localized: "Resets soon") }
    if interval < 24 * 3600 {
      let formatter = DateComponentsFormatter()
      formatter.unitsStyle = .short
      formatter.allowedUnits = interval < 3600 ? [.minute] : [.hour, .minute]
      formatter.maximumUnitCount = 2
      let value = formatter.string(from: interval) ?? ""
      return String(localized: "Resets in \(value)")
    }
    let value = date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    return String(localized: "Resets \(value)")
  }
}
