import SwiftUI
import UIKit

struct OkouWorkspaceLogo: View {
  let workspaceID: String
  let name: String
  var imageURL: URL? = nil
  var hasImage = false
  var size: CGFloat = OkouAvatarSize.workspace

  /// FNV-1a over UTF-16, matching Web's identity-hash.ts exactly.
  nonisolated static func defaultAssetName(for workspaceID: String) -> String {
    let hash = workspaceID.utf16.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
    return "WorkspaceDefault-\(hash % 8)"
  }

  var body: some View {
    Group {
      if hasImage, let imageURL {
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
  }
}

/// A workspace's logo as a glass control, the sidebar's workspace button. The logo is round
/// so it sits concentric in the 44 pt glass circle, the same circle as the bar's other glass
/// buttons.
struct OkouWorkspaceGlassLogo: View {
  let workspaceID: String
  let name: String
  var imageURL: URL? = nil
  var hasImage = false

  var body: some View {
    OkouWorkspaceLogo(
      workspaceID: workspaceID, name: name, imageURL: imageURL, hasImage: hasImage,
      size: OkouAvatarSize.glassControl
    )
    .clipShape(Circle())
    .modifier(OkouGlassControl(shape: .circle))
  }
}

/// Workspace logos for the system menu, which draws images, not views: each tile is drawn once
/// with the logo's own rounded corners, as the web's switcher puts a logo on every row. An
/// uploaded logo shows a neutral tile until it has loaded, as `OkouWorkspaceLogo` does.
@MainActor
@Observable
final class OkouWorkspaceMenuLogos {
  private struct Key: Hashable {
    let workspaceID: String
    let imageURL: URL?
  }

  private var tiles: [Key: UIImage] = [:]

  func image(workspaceID: String, imageURL: URL?, hasImage: Bool) -> Image {
    let key = Key(workspaceID: workspaceID, imageURL: hasImage ? imageURL : nil)
    return Image(uiImage: tiles[key] ?? Self.tile(nil)).renderingMode(.original)
  }

  func load(workspaceID: String, imageURL: URL?, hasImage: Bool) async {
    let key = Key(workspaceID: workspaceID, imageURL: hasImage ? imageURL : nil)
    guard tiles[key] == nil else { return }
    guard let imageURL = key.imageURL else {
      let name = OkouWorkspaceLogo.defaultAssetName(for: workspaceID)
      tiles[key] = Self.tile(UIImage(named: name))
      return
    }
    guard let (data, _) = try? await URLSession.shared.data(from: imageURL),
      let image = UIImage(data: data)
    else { return }
    tiles[key] = Self.tile(image)
  }

  private static func tile(_ image: UIImage?) -> UIImage {
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
    }
    .withRenderingMode(.alwaysOriginal)
  }
}
