import ChatData
import SwiftUI

/// The page's header on the cover: back, the title, and where the reader is in the deck. Its
/// text and glass follow the theme, as the cover dims at night.
struct ForYouHeader: View {
  let count: Int
  /// The card the pager is closest to, and its exact place while it moves (-1 to the count,
  /// as it wraps round the deck).
  let live: Int
  let position: CGFloat
  let isBusy: Bool
  let canPage: Bool
  /// Whether the count and the segments show. While a direction is written they step aside,
  /// keeping their room, so only the card and the input hold the eye.
  var showsPlace = true
  let back: () -> Void
  let show: (Int) -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The header's second line, a step behind the title on the picture.
  private static let secondary: Double = 0.72
  private static let segmentRest: Double = 0.22
  private static let segmentLit: Double = 0.78

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: OkouSpace.ten) {
        Button(action: back) {
          OkouToolbarIcon("chevron-left").modifier(OkouGlassControl(shape: .circle))
        }
        .buttonStyle(.plain).accessibilityLabel("Back").accessibilityIdentifier("for-you-back")
        .disabled(isBusy)
        VStack(alignment: .leading, spacing: OkouSpace.two) {
          Text("For you").font(.okou(.title2).weight(.semibold))
          Text("Okou’s picks to handle").font(.okou(.footnote))
            .foregroundStyle(OkouColor.foreground.opacity(Self.secondary))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if count > 1 {
          // The count sits in the same clear glass as the back button beside it, and its digits
          // roll as the cards page.
          Text(verbatim: "\(live + 1) / \(count)")
            .font(.okou(.footnote).weight(.semibold)).monospacedDigit()
            .contentTransition(.numericText(value: Double(live)))
            .animation(reduceMotion ? nil : OkouMotion.transition, value: live)
            .padding(.horizontal, OkouSpace.md)
            .frame(minHeight: OkouSpace.xxxl)
            .glassEffect(.regular, in: Capsule())
            .opacity(showsPlace ? 1 : 0)
            .accessibilityHidden(!showsPlace)
        }
      }
      if count > 1 {
        progress.opacity(showsPlace ? 1 : 0).accessibilityHidden(!showsPlace)
      }
    }
    .animation(reduceMotion ? nil : OkouMotion.transition, value: showsPlace)
    .foregroundStyle(OkouColor.foreground)
    .padding(.horizontal, OkouSpace.lg).padding(.top, OkouSpace.sm)
  }

  /// One segment per card, as stories mark their place. The lit segment follows the finger:
  /// it hands its light to the next one in proportion to the swipe instead of jumping at the
  /// halfway point.
  private var progress: some View {
    let start = max(0, min(live - 2, count - 5))
    return HStack(spacing: OkouSpace.xs) {
      ForEach(start..<min(start + 5, count), id: \.self) { index in
        // Distance round the deck, so the first segment lights as the last card wraps to it.
        let distance = abs(position - CGFloat(index))
        let lit = max(0, 1 - min(distance, CGFloat(count) - distance))
        Button {
          show(index)
        } label: {
          Capsule()
            .fill(OkouColor.foreground.opacity(Self.segmentRest))
            .overlay {
              Capsule().fill(OkouColor.foreground.opacity(Self.segmentLit * Double(lit)))
            }
            .frame(height: OkouSpace.three).frame(
              maxWidth: .infinity, minHeight: OkouControl.minimumTarget
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show suggestion \(index + 1) of \(count)")
        .accessibilityAddTraits(index == live ? .isSelected : [])
      }
    }
    .disabled(!canPage)
  }
}

/// The panel once every card is settled, with what this visit settled: a sent direction leads
/// to its chat, a dismissal can come back.
struct ForYouCaughtUp: View {
  let handled: [ForYouStore.Handled]
  let undo: (ForYouStore.Undo) -> Void
  let open: (String) -> Void
  let done: () -> Void

  var body: some View {
    VStack(spacing: OkouSpace.md) {
      Image("ForYouRest").resizable().scaledToFit().frame(height: 104).accessibilityHidden(true)
      Text("All caught up").font(.okou(.title3).weight(.semibold))
        .accessibilityAddTraits(.isHeader).accessibilityIdentifier("for-you-empty")
      Text("Okou will bring the next thing here when there is something worth your time.")
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
        .multilineTextAlignment(.center)
      if !handled.isEmpty { recap }
      Button("Back to chats", action: done)
        .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        .padding(.top, OkouSpace.xs)
        .accessibilityIdentifier("for-you-done")
    }
    .frame(maxWidth: .infinity)
  }

  private var recap: some View {
    VStack(alignment: .leading, spacing: 0) {
      OkouListDivider()
      Text("Handled just now").font(.okou(.footnote).weight(.semibold))
        .foregroundStyle(OkouColor.mutedForeground).padding(.top, OkouSpace.md)
      ForEach(handled) { item in
        HStack(spacing: OkouSpace.ten) {
          VStack(alignment: .leading, spacing: OkouSpace.two) {
            Text(verbatim: item.title).font(.okou(.subheadline)).lineLimit(1)
            Text(verbatim: item.detail).font(.okou(.footnote))
              .foregroundStyle(OkouColor.mutedForeground).lineLimit(1)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          // A row's action is the card's bare text action, so the recap stays a quiet list.
          if let action = item.undo {
            Button("Undo") { undo(action) }
              .buttonStyle(ChatCardButtonStyle(emphasis: .detail)).fixedSize()
          } else if let id = item.threadID {
            Button("Open chat") { open(id) }
              .buttonStyle(ChatCardButtonStyle(emphasis: .detail)).fixedSize()
          }
        }
        .frame(minHeight: OkouControl.groupedRow)
      }
    }
  }
}

/// The first load draws a card's outline in skeleton grey, shimmering as one, where the card
/// will appear: its source, title, reason and two directions.
struct ForYouLoadingCard: View {
  private static let chip: CGFloat = 140
  private static let titleEnd: CGFloat = 180
  /// A direction's height: a Body label over two Subheadline lines.
  private static let option: CGFloat = 100

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.xl) {
      VStack(alignment: .leading, spacing: OkouSpace.sm) {
        OkouSkeletonBlock(width: Self.chip, height: OkouControl.inlineActionHeight)
        OkouSkeletonBlock(height: OkouSpace.xxl)
        OkouSkeletonBlock(width: Self.titleEnd, height: OkouSpace.xxl)
        OkouSkeletonBlock(height: OkouSpace.xl).padding(.top, OkouSpace.xs)
      }
      VStack(spacing: OkouSpace.ten) {
        ForEach(0..<2, id: \.self) { _ in
          OkouSkeletonBlock(height: Self.option, radius: OkouRadius.control)
        }
      }
    }
    .okouShimmer()
    .accessibilityRepresentation { ProgressView() }
  }
}

/// The deck as the pager lays it out. With more than one card, the last card waits again before
/// the first and the first again after the last, so a swipe past either end carries on round the
/// deck, as the web's stack turns. Coming to rest on either copy hands over to the card itself.
struct ForYouLoop {
  struct Page: Identifiable {
    let id: String
    let card: ForYouCard
  }

  let pages: [Page]
  let count: Int
  /// How many pages come before the first card.
  let lead: Int

  private static let before = "#before"
  private static let after = "#after"

  init(_ cards: [ForYouCard]) {
    count = cards.count
    let own = cards.map { Page(id: $0.id, card: $0) }
    guard cards.count > 1, let first = cards.first, let last = cards.last else {
      pages = own
      lead = 0
      return
    }
    pages =
      [Page(id: last.id + Self.before, card: last)] + own
      + [Page(id: first.id + Self.after, card: first)]
    lead = 1
  }

  /// The card a page shows, for an id the pager reports.
  static func cardID(_ pageID: String?) -> String? {
    guard let pageID else { return nil }
    for suffix in [before, after] where pageID.hasSuffix(suffix) {
      return String(pageID.dropLast(suffix.count))
    }
    return pageID
  }

  /// The card nearest a position, counting round the deck: -1 is the last card, `count` the
  /// first.
  func index(nearest position: CGFloat) -> Int {
    guard count > 0 else { return 0 }
    return (Int(position.rounded()) % count + count) % count
  }

  /// A position that runs from the first card to the last and back over the wrap, for what
  /// moves with the deck as a whole, such as the cover's drift.
  func unwrapped(_ position: CGFloat) -> CGFloat {
    let last = CGFloat(max(count - 1, 0))
    if position > last { return last * (CGFloat(count) - position) }
    if position < 0 { return last * -position }
    return position
  }
}
