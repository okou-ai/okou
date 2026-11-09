import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

struct MessageAttachmentView: View {
  let attachment: ChatMessageAttachment
  let viewer: MessageAttachmentStore
  let loadsThumbnail: Bool

  var body: some View {
    let reads = viewer.reads
    StoreProvider(reads.store) {
      if loadsThumbnail, isMedia {
        MessageAttachmentValue(attachment: attachment, viewer: viewer, reads: reads)
      } else {
        MessageAttachmentContent(attachment: attachment, viewer: viewer, value: .loading)
      }
    }
    .id(ObjectIdentifier(reads))
  }

  private var isMedia: Bool {
    attachment.contentType.hasPrefix("image/") || attachment.contentType.hasPrefix("video/")
  }
}

private struct MessageAttachmentValue: View {
  let attachment: ChatMessageAttachment
  let viewer: MessageAttachmentStore
  private let read: MessageAttachmentThumbnailRead
  private let reads: MessageAttachmentResources
  @LoadableValue private var value: Loadable<MessageAttachmentThumbnail>

  init(
    attachment: ChatMessageAttachment, viewer: MessageAttachmentStore,
    reads: MessageAttachmentResources
  ) {
    self.attachment = attachment
    self.viewer = viewer
    self.reads = reads
    let read = reads.thumbnail(attachment)
    self.read = read
    _value = LoadableValue(task: read.value)
  }

  var body: some View {
    MessageAttachmentContent(attachment: attachment, viewer: viewer, value: value)
      .onAppear { reads.retryIfNeeded(read) }
  }
}

private struct MessageAttachmentContent: View {
  let attachment: ChatMessageAttachment
  let viewer: MessageAttachmentStore
  let value: Loadable<MessageAttachmentThumbnail>

  private var thumbnail: UIImage? { value.data?.image }
  private var thumbnailMessage: String? {
    if let error = value.error {
      return ChatRequestFailure.isTransient(error)
        ? String(localized: "Tap to download preview") : MessageAttachmentStore.message(for: error)
    }
    return value.state == .hasData && thumbnail == nil ? "Tap to download preview" : nil
  }
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
