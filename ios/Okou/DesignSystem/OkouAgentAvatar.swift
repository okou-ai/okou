import Foundation
import SwiftUI

/// Persisted Web avatar identities, composed from the same versioned vector layers.
struct OkouAvatarComposition: Equatable {
  var behind: [String] = []
  let head: [String]
  var front: [String] = []
  var headOffset: CGFloat = 0
  var contentOffset: CGFloat = 0
  var scale: CGFloat = 1.25

  static func resolve(_ value: String?) -> Self? {
    guard let value else { return nil }
    if value.hasPrefix("preset:") {
      let presets = ["r1s0h1c5f1h", "r2s1h3c3f1m", "r4s2h5c4f3d", "r3s3h4c1f4h", "r5s4h2c2f5m"]
      let index = Int(value.dropFirst(7)) ?? 0
      return legacy(presets.indices.contains(index) ? presets[index] : presets[0])
    }
    if value.hasPrefix("svg:") { return legacy(String(value.dropFirst(4))) }
    guard value.hasPrefix(OkouAvatarAssets.baseURL + "?"),
      let components = URLComponents(string: value)
    else { return nil }
    func field(_ name: String, in allowed: [String]) -> String? {
      guard let result = components.queryItems?.first(where: { $0.name == name })?.value,
        allowed.contains(result)
      else { return nil }
      return result
    }
    guard let face = field("face", in: OkouAvatarAssets.faces),
      let hair = field("hair", in: OkouAvatarAssets.hairs),
      let expression = field("expression", in: OkouAvatarAssets.expressions),
      let skin = field("skin", in: OkouAvatarAssets.skins),
      let color = field("hairColor", in: OkouAvatarAssets.hairColors)
    else { return nil }
    let feminine = [
      "high-bun", "geometric-long", "long-center-part", "triple-bun", "topknot-locks",
      "low-pigtails", "ribbon-updo",
    ]
    guard expression != "full-beard" || !feminine.contains(hair) else { return nil }
    let key = [face, hair, expression, skin, color].joined(separator: "|")
    let hash = key.utf16.reduce(0) { ($0 * 31 + Int($1)) % 1_000_003 }
    let sweater =
      field("sweater", in: OkouAvatarAssets.sweaters)
      ?? OkouAvatarAssets.sweaters[hash % OkouAvatarAssets.sweaters.count]
    let chins: [String: CGFloat] = [
      "round": 314, "square": 334, "round-angled-ears": 318, "tall": 353, "wide": 307, "oval": 334,
    ]
    let tops: [String: [CGFloat]] = [
      "high-bun": [22, 3], "geometric-long": [116, 81], "center-part": [114, 116],
      "curly-cap": [74, 92], "long-center-part": [116, 116], "sparse": [99, 96],
      "triple-bun": [43, 68], "rounded-crop": [116, 116], "halo": [85, 116],
      "topknot-locks": [17, 56], "low-pigtails": [116, 116], "ribbon-updo": [45, 51],
    ]
    guard let chin = chins[face], let hairTops = tops[hair] else { return nil }
    let headOffset = 327.6 - chin
    let top = hairTops[face == "square" ? 1 : 0] + headOffset
    let base = "hairs/\(face)/\(hair)-\(color)"
    return Self(
      behind: ["neck/\(skin).svg"],
      head: [
        "\(base)-rear.svg", "faces/\(face)-\(skin).svg", "\(base)-front.svg",
        "expressions/\(expression)-\(face)\(expression == "calm" ? "-" + skin : "").svg",
      ],
      front: ["sweater/\(sweater).svg"], headOffset: headOffset / 380,
      contentOffset: -top / 760, scale: sqrt(0.92 / ((380 - top) / 380)))
  }

  private static func legacy(_ body: String) -> Self? {
    guard
      body.range(of: "^r[1-5]s[0-4]h[1-5]c[1-5]f[1-5][dmh]$", options: .regularExpression) != nil
    else { return nil }
    let parts = Array(body).map(String.init)
    return Self(head: [
      "head-r\(parts[1])-s\(parts[3]).svg", "face-r\(parts[1])-f\(parts[9])-\(parts[10]).svg",
      "hair-r\(parts[1])-h\(parts[5])-c\(parts[7]).svg",
    ])
  }

  static func assetName(_ path: String) -> String {
    "AgentAvatar-"
      + path.replacingOccurrences(of: ".svg", with: "").replacingOccurrences(of: "/", with: "-")
  }
}

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
      } else if let composition = OkouAvatarComposition.resolve(avatarURL) {
        ZStack {
          layers(composition.behind)
          layers(composition.head).offset(y: size * composition.headOffset)
          layers(composition.front)
        }
        .offset(y: size * composition.contentOffset)
        .scaleEffect(composition.scale)
      } else if let url = avatarURL.flatMap(URL.init(string:)),
        ["https", "http"].contains(url.scheme)
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

  private func layers(_ paths: [String]) -> some View {
    ZStack {
      ForEach(paths, id: \.self) { path in
        Image(OkouAvatarComposition.assetName(path)).resizable().scaledToFit()
      }
    }.frame(width: size, height: size)
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
