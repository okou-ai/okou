import SwiftUI
import UIKit

/// What a result's picture area shows: the neutral ground under the shimmer while the
/// picture loads, the picture, or the kind's glyph on the ground when there is none.
enum OkouPreviewState {
  case loading
  case image(UIImage)
  case placeholder(icon: String)
}

/// What a result card's cover pictures, which sets how the picture sits in the one 16:9
/// cover.
enum OkouCoverShape {
  /// A website: the top of the page filling the cover.
  case page
  /// A deck: the first slide whole; a 4:3 slide sits in the middle on the neutral ground.
  case slide
  /// A document: the top of the first page filling the cover.
  case document
}

/// A result in the transcript (a website, slides, a document), in the web's
/// `SitePreviewCard` shape: a heading over a 16:9 cover of the site, the first slide or the
/// first page. The heading is every transcript card's (`ChatCardHeader`: the kind's 16 pt
/// glyph in brand text, the title, one detail line such as "Slides · PPTX · 2.3 MB"), so a
/// result reads like the cards around it. Without a cover the heading is the whole card.
/// Every cover has the same proportions and both heights depend only on the text size, so
/// results line up and the transcript never moves when the picture arrives.
struct OkouResultCard: View {
  let title: String
  let detail: String
  let icon: String
  var cover: OkouPreviewState? = nil
  var shape: OkouCoverShape = .page

  var body: some View {
    let outline = RoundedRectangle(cornerRadius: OkouRadius.chat, style: .continuous)
    VStack(spacing: 0) {
      ChatCardHeader(title: title, icon: icon, titleLineLimit: 1) {
        Text(detail).lineLimit(1)
      }
      .padding(.horizontal, OkouSpace.lg)
      .padding(.vertical, OkouSpace.md)
      if let cover {
        OkouColor.stateHover
          .aspectRatio(OkouControl.coverAspect, contentMode: .fit)
          .overlay(alignment: .top) { coverContent(cover) }
          .clipped()
          .overlay(alignment: .top) {
            OkouColor.border.frame(height: OkouSpace.hairline)
          }
      }
    }
    .frame(maxWidth: OkouControl.resultWidth)
    .clipShape(outline)
    .modifier(OkouSurfaceStyle(radius: OkouRadius.chat))
  }

  @ViewBuilder
  private func coverContent(_ state: OkouPreviewState) -> some View {
    switch state {
    case .loading:
      OkouPictureLoading()
    case .image(let image):
      if shape == .slide {
        Image(uiImage: image).resizable().scaledToFit()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        Image(uiImage: image).resizable().scaledToFill()
      }
    case .placeholder(let icon):
      OkouIcon(icon, size: OkouIconSize.mediaOverlay)
        .foregroundStyle(OkouColor.mutedForeground)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

/// A picture's place while it loads, as media apps draw it: the neutral ground with the
/// skeleton's slanted light crossing it, and nothing that guesses at the picture — a cover's
/// heading already says what is coming; a tile adds a faint glyph of its kind. Its content
/// is unknown, so it is not drawn as an outline, unlike a chat's skeleton.
struct OkouPictureLoading: View {
  var icon: String? = nil

  var body: some View {
    ZStack {
      Rectangle().fill(OkouColor.stateHover).okouShimmer(masked: false)
      if let icon {
        OkouIcon(icon, size: OkouIconSize.mediaOverlay)
          .foregroundStyle(OkouColor.mutedForeground.opacity(OkouMotion.skeletonDim))
      }
    }
    .accessibilityElement()
    .accessibilityLabel("Loading preview")
  }
}

/// A picture or video in the transcript, as the web's Markdown image: one fixed 200 × 180 pt
/// frame with the whole picture fitted inside on the neutral ground, nothing cropped, so a
/// run of them stays even and the transcript never jumps when one loads. While it loads it is
/// `OkouPictureLoading` with a faint picture glyph. The same corner and edge as a result
/// card. Video adds the play mark.
struct OkouResultTile: View {
  let state: OkouPreviewState
  var isVideo = false

  var body: some View {
    let outline = RoundedRectangle(cornerRadius: OkouRadius.chat, style: .continuous)
    OkouColor.stateHover
      .frame(width: OkouControl.mediaTileWidth, height: OkouControl.cardMediaHeight)
      .overlay { content }
      .overlay {
        // The play mark sits on the video's frame; without a frame the glyph says what it is.
        if isVideo, case .image = state {
          OkouIcon("circle-play", size: OkouIconSize.mediaOverlay)
            .foregroundStyle(OkouMediaColor.foreground)
            .background(OkouMediaColor.scrim.opacity(0.55), in: Circle())
        }
      }
      .clipShape(outline)
      .overlay { outline.strokeBorder(OkouColor.border, lineWidth: OkouSpace.hairline) }
  }

  @ViewBuilder
  private var content: some View {
    switch state {
    case .loading:
      OkouPictureLoading(icon: isVideo ? "video" : "image")
    case .image(let image):
      Image(uiImage: image).resizable().scaledToFit()
    case .placeholder(let icon):
      OkouIcon(icon, size: OkouIconSize.mediaOverlay)
        .foregroundStyle(OkouColor.mutedForeground)
    }
  }
}
