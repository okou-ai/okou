import SwiftUI
import UIKit

struct OkouWorkspaceLogo: View {
  let workspaceID: String
  let name: String
  var imageURL: URL?
  var hasImage = false
  var size: CGFloat = OkouAvatarSize.workspace
  var cachedImage: UIImage?
  var usesSharedImage = false
  var metadataKnown = true

  /// FNV-1a over UTF-16, matching Web's identity-hash.ts exactly.
  nonisolated static func colorwayIndex(for workspaceID: String) -> Int {
    let hash = workspaceID.utf16.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
    return Int(hash % 8)
  }

  nonisolated static func defaultAssetName(for workspaceID: String) -> String {
    "WorkspaceDefault-\(colorwayIndex(for: workspaceID))"
  }

  /// Each colourway's `letter` in core/src/workspace-logo.ts, in the same order: the ground's
  /// own hue, solved to 4.5:1 against the texture. `sync-workspace-assets.py --check` keeps
  /// them equal.
  nonisolated static let letterHexes: [UInt32] = [
    0x6E485B, 0x480000, 0x395766, 0xD9ECFF, 0x675900, 0x6E2F00, 0x465900, 0xEAFFFE
  ]

  nonisolated static func letterColor(for workspaceID: String) -> UIColor {
    let hex = letterHexes[colorwayIndex(for: workspaceID)]
    return UIColor(
      red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
      blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
  }

  /// Web's `workspaceInitial`: the first letter or number as one grapheme, capitalised unless its
  /// capital spells more than one (ß). Generated `workspace-xxxxxxxx` names and names without a
  /// letter keep the texture alone.
  nonisolated static func initial(for name: String) -> String? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.range(of: "^workspace-[0-9a-f]{8}$", options: [.regularExpression, .caseInsensitive])
      != nil
    {
      return nil
    }
    guard let first = trimmed.first(where: { $0.isLetter || $0.isNumber }) else { return nil }
    let upper = String(first).uppercased()
    return upper.count == 1 ? upper : String(first)
  }

  /// Half the tile; CJK glyphs fill their em box, so they take 0.88 of that, as on Web.
  nonisolated static func initialPointSize(_ initial: String, tile: CGFloat) -> CGFloat {
    let wide = initial.unicodeScalars.contains {
      switch $0.properties.generalCategory {
      case .otherLetter:
        return (0x1100...0x11FF).contains($0.value) || (0x3040...0x30FF).contains($0.value)
          || (0x3400...0x9FFF).contains($0.value) || (0xAC00...0xD7AF).contains($0.value)
          || (0xF900...0xFAFF).contains($0.value) || (0x20000...0x3134F).contains($0.value)
      default: return false
      }
    }
    return tile * (wide ? 0.44 : 0.5)
  }

  var body: some View {
    Group {
      if !metadataKnown {
        OkouColor.stateHover
      } else if hasImage, let cachedImage {
        Image(uiImage: cachedImage).resizable().scaledToFill()
      } else if hasImage, usesSharedImage {
        OkouColor.stateHover
      } else if hasImage, let imageURL {
        // A neutral tile while loading: showing the default mark first made the same
        // workspace look like a different one until its own logo arrived.
        AsyncImage(url: imageURL) { phase in
          switch phase {
          case .success(let image): image.resizable().scaledToFill()
          case .failure: defaultLogo
          default: OkouColor.stateHover
          }
        }
      } else {
        defaultLogo
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size / 4, style: .continuous))
    .accessibilityLabel(name)
  }

  private var defaultLogo: some View {
    Image(Self.defaultAssetName(for: workspaceID)).resizable().scaledToFill()
      .overlay {
        if let initial = Self.initial(for: name) {
          Text(verbatim: initial)
            .font(.okou(size: Self.initialPointSize(initial, tile: size), weight: .semibold))
            .foregroundStyle(Color(uiColor: Self.letterColor(for: workspaceID)))
            .accessibilityHidden(true)
        }
      }
  }
}

/// A workspace's logo as a glass control, the sidebar's workspace button. The logo is round
/// so it sits concentric in the 44 pt glass circle, the same circle as the bar's other glass
/// buttons.
struct OkouWorkspaceGlassLogo: View {
  let workspaceID: String
  let name: String
  var imageURL: URL?
  var hasImage = false
  var cachedImage: UIImage?
  var usesSharedImage = false
  var metadataKnown = true

  var body: some View {
    OkouWorkspaceLogo(
      workspaceID: workspaceID, name: name, imageURL: imageURL, hasImage: hasImage,
      size: OkouAvatarSize.glassControl, cachedImage: cachedImage,
      usesSharedImage: usesSharedImage, metadataKnown: metadataKnown
    )
    .clipShape(Circle())
    .modifier(OkouGlassControl(shape: .circle))
  }
}

/// The system menu renders the same retained bitmap as the sidebar, without another request.
@MainActor
enum OkouWorkspaceMenuLogos {
  static func image(workspaceID: String, name: String, hasImage: Bool, cachedImage: UIImage?)
    -> Image
  {
    let image =
      hasImage ? cachedImage : UIImage(named: OkouWorkspaceLogo.defaultAssetName(for: workspaceID))
    let initial = hasImage ? nil : OkouWorkspaceLogo.initial(for: name)
    return Image(
      uiImage: tile(
        image, initial: initial, ink: OkouWorkspaceLogo.letterColor(for: workspaceID))
    )
    .renderingMode(.original)
  }

  private static func tile(_ image: UIImage?, initial: String?, ink: UIColor) -> UIImage {
    let side = OkouAvatarSize.menu
    let bounds = CGRect(x: 0, y: 0, width: side, height: side)
    return UIGraphicsImageRenderer(size: bounds.size).image { _ in
      UIBezierPath(roundedRect: bounds, cornerRadius: side / 4).addClip()
      guard let image, image.size.width > 0, image.size.height > 0 else {
        UIColor(OkouColor.stateHover).setFill()
        UIRectFill(bounds)
        return
      }
      // Fill the tile and crop the overflow, as `scaledToFill` does for the view.
      let scale = max(side / image.size.width, side / image.size.height)
      let width = image.size.width * scale
      let height = image.size.height * scale
      image.draw(
        in: CGRect(x: (side - width) / 2, y: (side - height) / 2, width: width, height: height))
      guard let initial else { return }
      let text = NSAttributedString(
        string: initial,
        attributes: [
          .font: OkouTypography.font(
            ofSize: OkouWorkspaceLogo.initialPointSize(initial, tile: side), weight: .semibold),
          .foregroundColor: ink
        ])
      let glyph = text.size()
      text.draw(at: CGPoint(x: (side - glyph.width) / 2, y: (side - glyph.height) / 2))
    }
    .withRenderingMode(.alwaysOriginal)
  }
}
