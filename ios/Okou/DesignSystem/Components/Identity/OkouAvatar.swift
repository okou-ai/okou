import SwiftUI

/// Okou, the default agent: Web's `OkouAvatar`, drawn natively from the same 21-mood rig in a
/// continuous-corner square over the brand texture, with the iOS widget's crop (the bun just
/// inside the top edge, cut at the collar).
///
/// It plays its mood by default; `.still` holds the mood's most readable frame, and Reduce
/// Motion always does. An avatar off screen stops drawing and resumes where it left off.
struct OkouAvatar: View {
  enum Motion {
    case animated, still
  }

  let size: CGFloat
  var mood: OkouAvatarMood = .idle
  var motion: Motion = .animated
  /// Accessible name. Leave it out when adjacent text, or the view around it, already names Okou.
  var label: String?

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Time played before the avatar last left the screen, and when it came back.
  @State private var played: TimeInterval = 0
  @State private var resumed: Date?

  /// The frame is a 40-unit square; the artwork overhangs it, 48 units wide, 4 left and 1.5 up.
  static let frameUnits: CGFloat = 40
  static let artwork = CGRect(x: -4, y: -1.5, width: 48, height: 48)
  /// Web's corner: 30% of the side with Figma's iOS smoothing, which is the native continuous
  /// corner.
  static let cornerRatio: CGFloat = 0.3
  /// The brand tile behind Okou, bundled at Web's 180% centred scale.
  static let texture = "OkouAvatarTexture"

  var body: some View {
    let animated = motion == .animated && !reduceMotion
    ZStack {
      Image(Self.texture).resizable()
      if animated {
        TimelineView(.animation(minimumInterval: OkouMotion.avatarFrame, paused: resumed == nil)) {
          timeline in
          OkouAvatarCanvas(
            mood: mood,
            time: mood.hero + played + (resumed.map { timeline.date.timeIntervalSince($0) } ?? 0))
        }
      } else {
        OkouAvatarCanvas(mood: mood, time: mood.hero)
      }
    }
    .frame(width: size, height: size)
    .clipShape(RoundedRectangle(cornerRadius: size * Self.cornerRatio, style: .continuous))
    .onAppear { resumed = .now }
    .onDisappear {
      if let resumed { played += Date.now.timeIntervalSince(resumed) }
      resumed = nil
    }
    .modifier(OkouAvatarAccessibility(label: label))
  }
}

private struct OkouAvatarAccessibility: ViewModifier {
  let label: String?

  func body(content: Content) -> some View {
    if let label {
      content.accessibilityElement(children: .ignore).accessibilityLabel(label)
        .accessibilityAddTraits(.isImage)
    } else {
      content.accessibilityHidden(true)
    }
  }
}

/// One frame of the rig, drawn into the avatar's square.
private struct OkouAvatarCanvas: View {
  let mood: OkouAvatarMood
  let time: Double

  var body: some View {
    Canvas { context, size in
      let unit = size.width / OkouAvatar.frameUnits
      let art = OkouAvatar.artwork
      let scale = art.width / OkouAvatarArtwork.view
      let placement = OkouAvatarArtwork.svg(
        OkouAvatarArtwork.scale(unit), OkouAvatarArtwork.translate(art.minX, art.minY),
        OkouAvatarArtwork.scale(scale))
      let renderer = OkouAvatarRenderer(
        frame: OkouAvatarRig.frame(mood, at: time),
        lineWidth: OkouAvatarArtwork.line * unit * scale)
      renderer.draw(OkouAvatarArtwork.scene, in: context, parent: placement)
    }
  }
}

/// Draws the artwork tree with a frame's state applied, as the browser draws Web's SVG.
struct OkouAvatarRenderer {
  let frame: OkouAvatarFrame
  /// The on-screen weight of a facial line, in points.
  let lineWidth: CGFloat

  func draw(_ node: OkouAvatarNode, in context: GraphicsContext, parent: CGAffineTransform) {
    let opacity = node.id.flatMap { frame.opacities[$0] } ?? node.opacity
    guard opacity > 0 else { return }
    let transform = (node.id.flatMap { frame.transforms[$0] } ?? node.transform)
      .concatenating(parent)
    var context = context
    if let clip = node.clip, node.id != "torso-clip" || frame.torsoClipped {
      let outline =
        switch clip {
        case .outline(let path): path
        case .shape(let id): frame.paths[id] ?? Path()
        }
      context.clip(to: outline.applying(transform))
    }
    if opacity < 1 {
      // A group fades as one picture, as SVG group opacity does.
      context.opacity = opacity
      context.drawLayer { layer in drawContent(node, in: layer, transform: transform) }
    } else {
      drawContent(node, in: context, transform: transform)
    }
  }

  private func drawContent(
    _ node: OkouAvatarNode, in context: GraphicsContext, transform: CGAffineTransform
  ) {
    switch node.content {
    case .group(let children):
      for child in children { draw(child, in: context, parent: transform) }
    case .shape(let shape):
      let path = node.id.flatMap { frame.paths[$0] } ?? shape.path
      var local = context
      local.concatenate(transform)
      if let fill = shape.fill { local.fill(path, with: .color(fill)) }
      guard let stroke = shape.stroke else { return }
      if shape.isLine {
        // Stroked after the transform, so squash and stretch never thin or thicken it.
        context.stroke(
          path.applying(transform), with: .color(stroke),
          style: StrokeStyle(lineWidth: lineWidth, lineCap: shape.cap, lineJoin: shape.join))
      } else {
        local.stroke(
          path, with: .color(stroke),
          style: StrokeStyle(lineWidth: shape.width, lineCap: shape.cap, lineJoin: shape.join))
      }
    }
  }
}
