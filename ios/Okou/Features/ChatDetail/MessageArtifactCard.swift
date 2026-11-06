import ChatDomain
import SwiftUI

/// A result in the transcript. Pictures and videos are fixed tiles; a website, slides or a
/// document is a card with its title over a cover; anything else is the card's header alone.
/// The shape comes from the resource as written in the message, never from loaded metadata,
/// so the row's height is known before anything loads.
struct MessageArtifactCard: View {
  let resource: ChatArtifact
  let label: String
  let destination: URL?
  let images: [ChatArtifact]
  let imageSources: [String]
  let viewer: MessageArtifactStore
  let loadsContent: Bool
  private struct LoadKey: Hashable {
    let resource: ChatArtifact
    let owner: ObjectIdentifier
    let enabled: Bool
    let retry: Int
  }
  private struct Prepared {
    let key: LoadKey
    let card: MessageArtifactStore.Card?
    let picture: UIImage?
    let error: String?
    /// The result is gone or not this person's: the card keeps its heading only.
    var unavailable = false
  }
  private enum Layout { case tile, cover, header }
  @State private var prepared: Prepared?
  @State private var retry = 0
  @Environment(\.openURL) private var openURL

  private var loadKey: LoadKey {
    LoadKey(
      resource: resource, owner: ObjectIdentifier(viewer), enabled: loadsContent, retry: retry)
  }
  private var current: Prepared? { prepared?.key == loadKey ? prepared : nil }
  private var error: String? { current?.error }
  private var artifact: ChatArtifact { current?.card?.artifact ?? resource }
  private var layout: Layout {
    if resource.kind == .image || resource.kind == .video { return .tile }
    return resource.hasCover ? .cover : .header
  }
  private var title: String {
    let text = label.trimmingCharacters(in: .whitespacesAndNewlines)
    // A bare link names the result by its address; the page's own title or the file's name
    // reads better.
    if text.isEmpty || text == "\u{fffc}" || URL(string: text)?.scheme != nil {
      return current?.card?.title ?? artifact.filename
    }
    return text
  }
  private var detail: String {
    if current?.unavailable == true, let error {
      return artifact.subtitle(showsAddress: false) + " · " + error
    }
    return error ?? artifact.subtitle(showsAddress: title != artifact.filename)
  }
  private var preview: OkouPreviewState {
    if let picture = current?.picture { return .image(picture) }
    if error == nil, loadsContent, current == nil { return .loading }
    return .placeholder(icon: artifact.symbol)
  }

  var body: some View {
    Button {
      if let destination {
        openURL(destination)
      } else {
        viewer.open(artifact, images: images, imageSources: imageSources)
      }
    } label: {
      switch layout {
      case .tile:
        OkouResultTile(state: preview, isVideo: resource.kind == .video)
      case .cover:
        // Nothing will ever fill the cover of a deleted result, so the card closes to its
        // heading rather than keep an empty frame; a passing failure keeps it, to retry.
        if current?.unavailable == true {
          OkouResultCard(title: title, detail: detail, icon: artifact.symbol)
        } else {
          OkouResultCard(
            title: title, detail: detail, icon: artifact.symbol, cover: preview,
            shape: resource.coverShape)
        }
      case .header:
        OkouResultCard(title: title, detail: detail, icon: artifact.symbol)
      }
    }
    .buttonStyle(.plain)
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityLabel("Preview \(title)")
    .accessibilityHint(detail)
    .accessibilityIdentifier("generated-result-card")
    .contextMenu {
      if error != nil { Button("Retry preview") { retry += 1 } }
    }
    .task(id: loadKey) {
      guard loadsContent else { return }
      let key = loadKey
      do {
        let value = try await viewer.card(resource, thumbnail: layout != .header)
        guard !Task.isCancelled else { return }
        prepared = Prepared(
          key: key, card: value, picture: value.thumbnail.flatMap(UIImage.init(data:)), error: nil)
      } catch {
        guard !Task.isCancelled else { return }
        if let status = MessageArtifactStore.cardStatus(for: error) {
          prepared = Prepared(key: key, card: nil, picture: nil, error: status, unavailable: true)
        } else {
          prepared = Prepared(
            key: key, card: nil, picture: nil,
            error: ChatRequestFailure.isTransient(error)
              ? String(localized: "Tap to load preview")
              : MessageArtifactStore.message(for: error))
        }
      }
    }
  }
}

extension ChatArtifact {
  private var format: String { (filename as NSString).pathExtension.lowercased() }

  var isSlides: Bool { isHTMLPresentation || ["ppt", "pptx", "key", "odp"].contains(format) }

  /// A website, slides or a document page: something whose first screen is worth a cover.
  var hasCover: Bool {
    if kind == .html || kind == .pdf || isSlides { return true }
    return kind == .file && ["doc", "docx", "pages", "odt", "rtf"].contains(format)
  }

  /// How the cover pictures the result, known from the result as the message writes it.
  var coverShape: OkouCoverShape {
    if isSlides { return .slide }
    return kind == .html ? .page : .document
  }

  var symbol: String {
    if isSlides { return "layers" }
    switch kind {
    case .image: return "image"
    case .video: return "video"
    case .audio: return "audio-lines"
    case .html: return "globe"
    case .csv, .json: return "table"
    case .pdf, .markdown, .text: return "file-text"
    case .file:
      switch format {
      case "xls", "xlsx", "numbers", "ods": return "table"
      default: return "file-text"
      }
    }
  }

  /// What the result is, in words a reader uses ("Slides", "Website"), before the file's
  /// format, the site's address or the size.
  private var kindName: String {
    if isSlides { return String(localized: "Slides") }
    switch kind {
    case .html: return String(localized: "Website")
    case .image: return String(localized: "Image")
    case .video: return String(localized: "Video")
    case .audio: return String(localized: "Audio")
    case .markdown, .text: return String(localized: "Document")
    case .pdf, .csv, .json: return format.isEmpty ? kind.rawValue.uppercased() : format.uppercased()
    case .file:
      switch format {
      case "doc", "docx", "pages", "odt", "rtf": return String(localized: "Document")
      case "xls", "xlsx", "numbers", "ods": return String(localized: "Spreadsheet")
      case "": return String(localized: "File")
      default: return format.uppercased()
      }
    }
  }

  var subtitle: String { subtitle(showsAddress: true) }

  /// "Slides · PPTX · 2.3 MB", "Website · lumina.okou.app". A page's address shows only when
  /// the title is not already that address; a page's "HTML" says nothing to a reader.
  func subtitle(showsAddress: Bool) -> String {
    var parts = [kindName]
    if kind == .html {
      if showsAddress, let host = address?.host { parts.append(host) }
    } else if !format.isEmpty, format.uppercased() != kindName {
      parts.append(format.uppercased())
    }
    if let size {
      parts.append(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
    }
    return parts.joined(separator: " · ")
  }

  private var address: URL? {
    switch source {
    case .hostedSite(let url), .published(let url): url
    case .reference, .file: nil
    }
  }
}
