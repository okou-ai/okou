import ChatData
import SwiftUI

/// The page's header on the ground: back, and the title over what the page is. It shows no
/// count and no place in the deck: the reader settles one card at a time, and the layers under
/// the card already say that more wait there.
struct ForYouHeader: View {
  let isBusy: Bool
  let back: () -> Void

  /// The header's second line, a step behind the title.
  private static let secondary: Double = 0.72

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
    }
    .foregroundStyle(OkouColor.foreground)
    .padding(.horizontal, OkouSpace.lg).padding(.top, OkouSpace.sm)
  }
}

/// The panel once every card is settled: the rest picture, one line and the way back to chats.
struct ForYouCaughtUp: View {
  let done: () -> Void

  var body: some View {
    VStack(spacing: OkouSpace.md) {
      Image("ForYouRest").resizable().scaledToFit().frame(height: 104).accessibilityHidden(true)
      Text("All caught up").font(.okou(.title3).weight(.semibold))
        .accessibilityAddTraits(.isHeader).accessibilityIdentifier("for-you-empty")
      Text("Okou will bring the next thing here when there is something worth your time.")
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
        .multilineTextAlignment(.center)
      Button("Back to chats", action: done)
        .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        .padding(.top, OkouSpace.xs)
        .accessibilityIdentifier("for-you-done")
    }
    .frame(maxWidth: .infinity)
  }
}

/// The compact bottom sheet shown when tapping For you while there are no pending items.
struct ForYouEmptySheet: View {
  static let detentHeight: CGFloat = 316

  private static let warmth = LinearGradient(
    stops: [
      .init(color: OkouColor.brandSubtle.opacity(0.45), location: 0),
      .init(color: OkouColor.brandSubtle.opacity(0), location: 0.65)
    ], startPoint: .top, endPoint: .bottom)

  var body: some View {
    VStack(spacing: OkouSpace.md) {
      Image("ForYouRest").resizable().scaledToFit().frame(height: 104).accessibilityHidden(true)
      Text("All caught up").font(.okou(.title3).weight(.semibold))
        .accessibilityAddTraits(.isHeader).accessibilityIdentifier("for-you-empty")
      Text("Okou will bring the next thing here when there is something worth your time.")
        .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
        .multilineTextAlignment(.center)
        .frame(maxWidth: OkouControl.emptyStateWidth)
    }
    .padding(.horizontal, OkouControl.pageInset)
    .padding(.top, OkouSpace.xxl)
    .padding(.bottom, OkouSpace.lg)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Self.warmth)
  }
}

/// The first load draws a card's outline in skeleton grey, shimmering as one, where the card
/// will appear: its source, title, reason and two directions.
struct ForYouLoadingCard: View {
  /// The content height a card takes in the deck, so the skeleton stands exactly where the card
  /// will; without it the skeleton takes its own.
  var height: CGFloat?

  /// The skeleton draws the card it stands for: two lines of title, four of reason, and two
  /// directions at the foot, each a button with its label and description.
  private static let titleLine: CGFloat = 18
  private static let textLine: CGFloat = 12
  private static let shortEnd: CGFloat = 96

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
      OkouSkeletonBlock(height: Self.textLine).padding(.trailing, Self.shortEnd)
      OkouSkeletonBlock(height: Self.textLine).padding(.trailing, Self.shortEnd / 2)
    }
    .padding(OkouSpace.lg)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ForYouView.directionFill, in: shape)
    .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
  }
}

/// The layers of the deck under the card in front: the card's own fill and hairline, each a little
/// narrower, lower and fainter than the one above it, under one soft shadow.
struct ForYouDeckLayers: View {
  let count: Int
  let ground: Color
  /// How far each layer peeks below the one above it.
  let drop: CGFloat
  /// How much narrower each layer is than the one above it.
  let inset: CGFloat
  /// How much less of each deeper layer shows.
  let fade: Double

  /// The one soft shadow the stack casts on the ground, as a stack of paper does.
  private static let shadowRadius: CGFloat = 10
  private static let shadowY: CGFloat = 4
  private static let shadowOpacity: Double = 0.06

  var body: some View {
    ZStack(alignment: .bottom) {
      ForEach(Array((1...count).reversed()), id: \.self) { layer in
        let shape = RoundedRectangle(cornerRadius: OkouRadius.sheet, style: .continuous)
        // The card's own fill and hairline, never shaded darker: each layer behind is a little
        // narrower and fainter, so its edge reads as the next card and not as a shadow.
        shape.fill(ground)
          .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
          .opacity(1 - Double(layer) * fade)
          .scaleEffect(x: 1 - CGFloat(layer) * inset, y: 1, anchor: .bottom)
          .offset(y: CGFloat(layer) * drop)
      }
    }
    // One shadow under the whole stack instead of a band under each layer.
    .compositingGroup()
    .shadow(
      color: .black.opacity(Self.shadowOpacity), radius: Self.shadowRadius, y: Self.shadowY)
  }
}
