import ChatData
import SwiftUI

/// The page's header on the ground: back, the title over what the page is, and how many cards are
/// left to handle, counting the one in front, in a quiet chip as tall as the back button. The chip
/// is a part-white fill with a hairline, without glass or shadow, so it reads as information beside
/// a control.
struct ForYouHeader: View {
  /// The cards still to handle, the one in front first.
  let remaining: [String]
  let isBusy: Bool
  let back: () -> Void
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The header's second line, a step behind the title.
  private static let secondary: Double = 0.72
  /// The chip's fill: the card's own white (its dark grey at night), part way, with a hairline, so
  /// it stands on the warm ground as a quiet panel rather than as glass.
  private static let chipFill: Double = 0.6

  var body: some View {
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
      if !remaining.isEmpty {
        remainingChip
      }
    }
    .foregroundStyle(OkouColor.foreground)
    .padding(.horizontal, OkouSpace.lg).padding(.top, OkouSpace.sm)
  }

  /// "5 left": the number and the word at one size, the number in the heavier weight, and its
  /// digits rolling as a card is handled or comes back.
  private var remainingChip: some View {
    let count = Text(remaining.count, format: .number).fontWeight(.semibold)
      .foregroundStyle(OkouColor.foreground)
    return Text("\(count) left")
      .font(.okou(.subheadline)).monospacedDigit()
      .foregroundStyle(OkouColor.foreground.opacity(Self.secondary))
      .contentTransition(.numericText(value: Double(remaining.count)))
      .animation(reduceMotion ? nil : OkouMotion.transition, value: remaining.count)
      .padding(.horizontal, OkouSpace.md)
      .frame(height: OkouControl.minimumTarget)
      .background {
        let shape = RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous)
        shape.fill(OkouColor.card.opacity(Self.chipFill))
          .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
      }
      .accessibilityElement(children: .combine)
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
  /// The content height a card takes in the deck, so the skeleton stands exactly where the card
  /// will; without it the skeleton takes its own.
  var height: CGFloat?

  /// The skeleton draws the card it stands for: two lines of title, four of reason, and two
  /// directions at the foot, each a white button with its action line, label and description.
  private static let titleLine: CGFloat = 18
  private static let textLine: CGFloat = 12
  private static let shortEnd: CGFloat = 96
  private static let actionLine: CGFloat = 88

  var body: some View {
    VStack(alignment: .leading, spacing: OkouSpace.xl) {
      VStack(alignment: .leading, spacing: OkouSpace.md) {
        OkouSkeletonBlock(height: Self.titleLine)
        OkouSkeletonBlock(height: Self.titleLine).padding(.trailing, Self.shortEnd)
        VStack(alignment: .leading, spacing: OkouSpace.ten) {
          ForEach(0..<3, id: \.self) { _ in OkouSkeletonBlock(height: Self.textLine) }
          OkouSkeletonBlock(height: Self.textLine).padding(.trailing, Self.shortEnd * 1.5)
        }
        .padding(.top, OkouSpace.sm)
      }
      if height != nil { Spacer(minLength: 0) }
      VStack(spacing: OkouSpace.sm) {
        ForEach(0..<2, id: \.self) { _ in direction }
      }
    }
    .frame(height: height, alignment: .top)
    .okouShimmer()
    .accessibilityRepresentation { ProgressView() }
  }

  private var direction: some View {
    let shape = RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous)
    return VStack(alignment: .leading, spacing: OkouSpace.ten) {
      OkouSkeletonBlock(width: Self.actionLine, height: Self.textLine * 0.75)
      OkouSkeletonBlock(height: Self.textLine).padding(.trailing, Self.shortEnd)
      OkouSkeletonBlock(height: Self.textLine).padding(.trailing, Self.shortEnd / 2)
    }
    .padding(OkouSpace.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ForYouView.directionFill, in: shape)
    .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
  }
}

/// The layers of the deck under the card in front: solid cards on the scene, each a little
/// narrower, lower and more shaded than the one above it.
struct ForYouDeckLayers: View {
  let count: Int
  let ground: Color
  /// How far each layer peeks below the one above it.
  let drop: CGFloat
  /// How much narrower each layer is than the one above it.
  let inset: CGFloat
  /// How much more each deeper layer is shaded.
  let shade: Double

  var body: some View {
    ZStack(alignment: .bottom) {
      ForEach(Array((1...count).reversed()), id: \.self) { layer in
        RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
          .fill(ground)
          .overlay {
            RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
              .fill(OkouMediaColor.scrim.opacity(Double(layer) * shade))
          }
          .overlay {
            RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
              .strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline)
          }
          .scaleEffect(x: 1 - CGFloat(layer) * inset, y: 1, anchor: .bottom)
          .offset(y: CGFloat(layer) * drop)
      }
    }
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
  /// How many pages come before the first card.
  let lead: Int

  private static let before = "#before"
  private static let after = "#after"

  init(_ cards: [ForYouCard]) {
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
}
