import SwiftUI
import UIKit

/// The page's scenery: the cover picture at one fixed scale across the top, continued below by
/// the colour of its own sea, so the cards and the dock stand on the same scene as the header.
/// A taller card only covers more of it; the picture never resizes, so it keeps one size and
/// one sharpness while the cards change. At night the whole scene dims.
struct ForYouCover: View {
  /// How far the scene has drifted sideways behind the cards, in points.
  let drift: CGFloat
  /// Hears where the train's lower edge is on screen, so the cards can stay below it.
  var onHorizon: (CGFloat) -> Void = { _ in }
  @Environment(\.colorScheme) private var colorScheme

  private static let aspect: CGFloat = 1024 / 410
  /// The picture takes this share of the page's height (never less than the screen's width),
  /// which sets the train just under the header.
  private static let share: CGFloat = 0.4
  /// The train's lower edge, as a share of the picture's height.
  private static let trainEdgeShare: CGFloat = 0.7

  private static func pictureHeight(_ size: CGSize) -> CGFloat {
    max(size.width / aspect, size.height * share)
  }
  /// The cover dims at night so the page's light header and status bar read on it.
  private static let nightDim: Double = 0.4

  var body: some View {
    GeometryReader { geometry in
      let height = Self.pictureHeight(geometry.size)
      let width = height * Self.aspect
      let travel = max(0, width - geometry.size.width)
      VStack(spacing: 0) {
        Image("ForYouCover").resizable().scaledToFill()
          .frame(width: width, height: height)
          .onGeometryChange(for: CGFloat.self) { proxy in
            let frame = proxy.frame(in: .global)
            return frame.minY + frame.height * Self.trainEdgeShare
          } action: { line in
            onHorizon(line)
          }
          .offset(x: -min(travel, drift))
          .frame(width: geometry.size.width, height: height, alignment: .leading)
          .clipped()
          // The picture's textured lower edge melts into the plain sea below it.
          .overlay(alignment: .bottom) {
            LinearGradient(
              colors: [Self.sea.opacity(0), Self.sea], startPoint: .top, endPoint: .bottom
            )
            .frame(height: OkouSpace.xxxl)
          }
        Self.sea
      }
    }
    .overlay {
      if colorScheme == .dark {
        OkouMediaColor.scrim.opacity(Self.nightDim)
      }
    }
    .ignoresSafeArea()
    .accessibilityHidden(true)
  }

  /// The average colour of the picture's lowest band, its sea, read once from the asset itself,
  /// so the scene continues without a seam and without a colour of its own. Without the picture
  /// the page keeps its ground.
  private static let sea: Color = {
    guard let image = UIImage(named: "ForYouCover")?.cgImage,
      let space = CGColorSpace(name: CGColorSpace.sRGB)
    else { return OkouColor.background }
    let band = max(1, image.height / 12)
    let width = 32
    let height = 4
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn: Bool = pixels.withUnsafeMutableBytes { buffer in
      guard
        let cropped = image.cropping(
          to: CGRect(x: 0, y: image.height - band, width: image.width, height: band)),
        let context = CGContext(
          data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
          bytesPerRow: width * 4, space: space,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.interpolationQuality = .high
      context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return OkouColor.background }
    let count = Double(width * height)
    func channel(_ offset: Int) -> Double {
      stride(from: offset, to: pixels.count, by: 4).reduce(0) { $0 + Double(pixels[$1]) }
        / count / 255
    }
    return Color(.sRGB, red: channel(0), green: channel(1), blue: channel(2))
  }()
}
