import Foundation
import SwiftUI

struct OkouAgentAvatar: View {
  let avatarURL: String?
  let name: String
  var isDefault = false
  var size: CGFloat = OkouAvatarSize.message
  nonisolated static let defaultURL =
    "https://static.vm0.io/public/default-agent-avatar-ceb298b79964.svg"

  var body: some View {
    Group {
      if isDefault || avatarURL == Self.defaultURL {
        // Wherever the default agent appears, Okou moves, as it does on Web.
        OkouAvatar(size: size)
      } else if let url = avatarURL.flatMap(URL.init(string:)),
        ["https", "http"].contains(url.scheme),
        url.pathExtension.lowercased() != "svg"
      {
        AsyncImage(url: url) { phase in
          if let image = phase.image { image.resizable().scaledToFill() } else { placeholder }
        }
      } else {
        placeholder
      }
    }
    .frame(width: size, height: size)
    .clipped()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
  }

  /// The initial on a neutral tile with a hairline edge, so it reads as a mark, not a letter
  /// floating on the page.
  private var placeholder: some View {
    let shape = RoundedRectangle(cornerRadius: size / 4, style: .continuous)
    return Text(String(name.prefix(1)).uppercased())
      .font(.okou(size: size * 0.45, weight: .medium))
      .foregroundStyle(OkouColor.mutedForeground)
      .frame(width: size, height: size)
      .background(OkouColor.stateHover, in: shape)
      .overlay { shape.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
  }
}
