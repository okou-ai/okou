import SwiftUI

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
