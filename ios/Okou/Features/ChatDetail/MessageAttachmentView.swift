import ChatData
import ChatDomain
import SwiftUI

struct MessageAttachmentView: View {
  let attachment: ChatMessageAttachment
  let viewer: MessageAttachmentStore
  let loadsThumbnail: Bool
  private struct LoadKey: Hashable {
    let fileID: String
    let owner: ObjectIdentifier
    let enabled: Bool
  }
  private struct Prepared {
    let key: LoadKey
    let image: UIImage?
    let message: String?
  }
  @State private var prepared: Prepared?

  private var loadKey: LoadKey {
    LoadKey(fileID: attachment.downloadID, owner: ObjectIdentifier(viewer), enabled: loadsThumbnail)
  }
  private var thumbnail: UIImage? {
    guard loadsThumbnail else { return nil }
    return viewer.cachedThumbnail(attachment) ?? (prepared?.key == loadKey ? prepared?.image : nil)
  }
  private var thumbnailMessage: String? { prepared?.key == loadKey ? prepared?.message : nil }
  private var thumbnailFailed: Bool { thumbnailMessage != nil }

  private var isMedia: Bool {
    attachment.contentType.hasPrefix("image/") || attachment.contentType.hasPrefix("video/")
  }

  /// The attachment in a result's terms, so a file reads the same whether the user or the
  /// agent added it ("Slides · PPTX · 2 MB").
  private var result: ChatArtifact {
    ChatArtifact(
      source: .file(attachment.downloadID), filename: attachment.filename,
      contentType: attachment.contentType, size: attachment.size)
  }

  private var preview: OkouPreviewState {
    if let thumbnail { return .image(thumbnail) }
    if thumbnailFailed { return .placeholder(icon: "circle-arrow-down") }
    return .loading
  }

  var body: some View {
    // The same shapes as a result in the transcript: a picture is a fixed tile, a file is the
    // result card's header.
    Button {
      viewer.open(attachment)
    } label: {
      if isMedia {
        OkouResultTile(state: preview, isVideo: attachment.contentType.hasPrefix("video/"))
      } else {
        OkouResultCard(title: attachment.filename, detail: result.subtitle, icon: result.symbol)
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Preview \(attachment.filename)")
    .accessibilityHint(thumbnailMessage ?? result.subtitle)
    .accessibilityIdentifier("message-attachment-\(attachment.id)")
    .task(id: loadKey) {
      guard loadsThumbnail, isMedia else { return }
      let key = loadKey
      do {
        let image = try await viewer.thumbnail(attachment)
        guard !Task.isCancelled else { return }
        prepared = Prepared(
          key: key, image: image, message: image == nil ? "Tap to download preview" : nil)
      } catch {
        guard !Task.isCancelled else { return }
        prepared = Prepared(
          key: key, image: nil,
          message: ChatRequestFailure.isTransient(error)
            ? String(localized: "Tap to download preview")
            : MessageAttachmentStore.message(for: error))
      }
    }
  }
}

struct MessageAttachmentPreview: View {
  let viewer: MessageAttachmentStore

  var body: some View {
    if let preview = viewer.preview {
      let artifact = ChatArtifact(
        source: .file(preview.attachment.downloadID), filename: preview.attachment.filename,
        contentType: preview.attachment.contentType, size: preview.attachment.size)
      MessagePreviewSheet(title: artifact.filename, dismiss: viewer.dismiss) {
        MessageFilePreview(
          kind: artifact.kind, symbol: artifact.symbol, file: preview.file,
          thumbnail: preview.thumbnail, error: preview.error, canRetry: preview.canRetry,
          retry: { viewer.open(preview.attachment) })
      } actions: {
        if let file = preview.file {
          ShareLink(item: file.url) { OkouToolbarIcon("share") }
            .accessibilityLabel("Share or save to Files")
        }
      }
    }
  }
}
