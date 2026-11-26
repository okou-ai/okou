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
