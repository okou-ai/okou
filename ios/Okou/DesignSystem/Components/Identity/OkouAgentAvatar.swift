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
        Image(OkouBrand.assistantAvatar).resizable().scaledToFit()
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

/// An agent in a sideways rail of avatars (the sidebar's pinned agents), proportioned on
/// Instagram's story tray (measured 2026-11: ~79 pt photo, ~11.5 pt name in one line, about
/// ten characters, then "…"): a 56 pt avatar over its name in one 11 pt line, a blue dot when
/// it has unread chats, and the selected state as a soft tile behind both. One line always,
/// so a long name further along the rail never makes every tile taller.
struct OkouAgentTile: View {
  let avatarURL: String?
  let name: String
  let isDefault: Bool
  var isSelected = false
  var hasUnread = false

  var body: some View {
    VStack(spacing: OkouSpace.six) {
      OkouAgentAvatar(
        avatarURL: avatarURL, name: name, isDefault: isDefault, size: OkouAvatarSize.rail
      )
      .overlay(alignment: .topTrailing) {
        if hasUnread {
          Circle()
            .fill(OkouStatusColor.running)
            .frame(width: OkouControl.unreadDot + 2, height: OkouControl.unreadDot + 2)
            .overlay { Circle().strokeBorder(OkouColor.sidebar, lineWidth: 2) }
            .offset(x: OkouSpace.two, y: -OkouSpace.two)
        }
      }
      Text(name)
        .font(.okou(.caption2).weight(isSelected ? .medium : .regular))
        .foregroundStyle(isSelected ? OkouColor.foreground : OkouColor.sidebarForeground)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(maxWidth: .infinity)
    }
    .padding(.horizontal, OkouSpace.xs)
    .padding(.vertical, OkouSpace.sm)
    .frame(width: OkouControl.agentTile)
    .background(
      isSelected ? OkouColor.stateSelected : Color.clear,
      in: RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous)
    )
    .contentShape(RoundedRectangle(cornerRadius: OkouRadius.control, style: .continuous))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name)
    .accessibilityValue(hasUnread ? Text("Unread") : Text(verbatim: ""))
    .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
  }
}
