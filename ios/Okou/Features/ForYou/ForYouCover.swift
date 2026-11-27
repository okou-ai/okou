import SwiftUI

/// The page's ground: the grouped ground the white cards stand on, as a sheet's rows do, warmed
/// at the top by a wash of the brand's subtle amber that fades out down the page, with the
/// brand's line texture (the thinking mark's brush) drawn round its four corners and fading out
/// towards the middle, where the card is. The texture is the brush itself, unrepeated, so its
/// lines frame the header, the dock and the card's sides without a seam. While a direction is
/// written the ground recedes under the page's canvas.
struct ForYouCover: View {
  /// Recedes under the page's canvas, so the card and the input stand alone and the glass and
  /// keyboard over it read plain.
  var veiled = false
  @Environment(\.colorScheme) private var colorScheme

  static let ground = OkouGroupedColor.background
  /// The warm wash at the top: the brand's subtle amber over the grouped ground, strongest under
  /// the status bar, a trace by the card's middle and gone at the foot.
  private static let warmth = LinearGradient(
    stops: [
      .init(color: OkouColor.brandSubtle.opacity(0.55), location: 0),
      .init(color: OkouColor.brandSubtle.opacity(0.25), location: 0.42),
      .init(color: OkouColor.brandSubtle.opacity(0), location: 1)
    ], startPoint: .top, endPoint: .bottom)
  /// The brush's ink: the brand amber, faint, so it reads as texture rather than drawing.
  private static let dayInk: Double = 0.12
  private static let nightInk: Double = 0.08
  /// Each corner's brush is this share of the page's width: small enough that its marks read as
  /// lines rather than paint.
  private static let brushShare: CGFloat = 0.55
  /// How much of the page's canvas lies over the ground while it is veiled.
  private static let veil: Double = 0.8

  var body: some View {
    GeometryReader { geometry in
      let size = geometry.size
      let side = size.width * Self.brushShare
      // One brush per corner, each turned a quarter from the last so the lines run round the
      // page, and set half off its edges.
      ZStack {
        brush(side).rotationEffect(.degrees(0))
          .position(x: side * 0.3, y: side * 0.35)
        brush(side).rotationEffect(.degrees(90))
          .position(x: size.width - side * 0.3, y: side * 0.35)
        brush(side).rotationEffect(.degrees(270))
          .position(x: side * 0.3, y: size.height - side * 0.35)
        brush(side).rotationEffect(.degrees(180))
          .position(x: size.width - side * 0.3, y: size.height - side * 0.35)
      }
      .frame(width: size.width, height: size.height)
      // Strongest at the page's edges, gone well before the middle.
      .mask {
        EllipticalGradient(
          stops: [
            .init(color: .clear, location: 0), .init(color: .clear, location: 0.42),
            .init(color: .black.opacity(0.6), location: 0.62), .init(color: .black, location: 0.8)
          ], center: .center, startRadiusFraction: 0, endRadiusFraction: 0.75)
      }
      .opacity(colorScheme == .dark ? Self.nightInk : Self.dayInk)
    }
    .background(Self.warmth)
    .background(Self.ground)
    .overlay { OkouColor.background.opacity(veiled ? Self.veil : 0) }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }

  /// One brush, faded out towards its own edges so the square it is cut from never shows.
  private func brush(_ side: CGFloat) -> some View {
    Image("OkouThinkingTexture").resizable()
      .foregroundStyle(OkouColor.primary)
      .frame(width: side, height: side * 803 / 800)
      .mask {
        RadialGradient(
          stops: [
            .init(color: .black, location: 0), .init(color: .black.opacity(0.7), location: 0.55),
            .init(color: .clear, location: 1)
          ], center: .center, startRadius: 0, endRadius: side / 2)
      }
  }
}
