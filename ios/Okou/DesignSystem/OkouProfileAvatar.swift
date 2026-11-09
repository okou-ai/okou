import SwiftUI
import UIKit

/// The signed-in person's photo from their account, in a circle with a hairline edge so a
/// white photo still reads on a white surface. Without a photo it shows the account glyph.
struct OkouProfileAvatar: View {
  let imageURL: URL?
  let hasImage: Bool
  let size: CGFloat
  var cachedImage: UIImage? = nil
  var usesSharedImage = false

  var body: some View {
    Group {
      if hasImage, let cachedImage {
        Image(uiImage: cachedImage).resizable().scaledToFill()
      } else if hasImage, usesSharedImage {
        OkouColor.stateHover
      } else if let imageURL, hasImage {
        AsyncImage(url: imageURL) { phase in
          if let image = phase.image {
            image.resizable().scaledToFill()
          } else {
            OkouColor.stateHover
          }
        }
      } else {
        OkouIcon("circle-user-round", size: size * 0.75)
          .foregroundStyle(OkouColor.mutedForeground)
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .overlay { Circle().strokeBorder(OkouColor.border, lineWidth: 0.5) }
    .accessibilityHidden(true)
  }
}
