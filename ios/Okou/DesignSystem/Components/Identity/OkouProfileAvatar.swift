import SwiftUI
import UIKit

/// The signed-in person's photo from their account, in a circle with a hairline edge so a
/// white photo still reads on a white surface. Without a photo it shows the web's
/// `UserAvatar` fallback: the name's initial on the muted fill.
struct OkouProfileAvatar: View {
  let imageURL: URL?
  let hasImage: Bool
  let size: CGFloat
  /// The account's name (or email); its first letter stands in for a missing photo.
  var name: String? = nil
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
        initial
      }
    }
    .frame(width: size, height: size)
    .clipShape(Circle())
    .overlay { Circle().strokeBorder(OkouColor.border, lineWidth: 0.5) }
    .accessibilityHidden(true)
  }

  /// The initial in medium supporting text, about a third of the circle as on the web. Until
  /// the account has a name the circle stays empty, so no stand-in letter shows and changes.
  private var initial: some View {
    ZStack {
      OkouColor.muted
      if let letter = name?.trimmingCharacters(in: .whitespacesAndNewlines).first {
        Text(String(letter).uppercased())
          .font(.okou(size: size * 0.36, weight: .medium))
          .foregroundStyle(OkouColor.mutedForeground)
      }
    }
  }
}
