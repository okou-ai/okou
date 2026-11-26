import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

struct MessageAttachmentView: View {
  let attachment: ChatMessageAttachment
  let viewer: MessageAttachmentStore
  let loadsThumbnail: Bool

  var body: some View {
    // Transcript cells host the row outside the workspace root, so it provides the session Store
    // that keeps the viewer's current reads.
    StoreProvider(viewer.graph) { MessageAttachmentReads(row: self) }
  }

  fileprivate var isMedia: Bool {
    attachment.contentType.hasPrefix("image/") || attachment.contentType.hasPrefix("video/")
  }
}

/// The row under the viewer's current reads, which leaving the detail replaces.
private struct MessageAttachmentReads: View {
  let row: MessageAttachmentView
  @ResolvedValue private var resolvedReads: MessageAttachmentResources?

  init(row: MessageAttachmentView) {
    self.row = row
    _resolvedReads = ResolvedValue(row.viewer.readsValue, equals: { $0 === $1 })
  }

  var body: some View {
    let reads = resolvedReads ?? row.viewer.reads
    Group {
      if row.loadsThumbnail, row.isMedia {
        MessageAttachmentValue(attachment: row.attachment, viewer: row.viewer, reads: reads)
      } else {
        MessageAttachmentContent(attachment: row.attachment, viewer: row.viewer, value: .loading)
      }
    }
    .id(ObjectIdentifier(reads))
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

  /// The attachment in a result's terms, so a file reads the same whether the user or Okou
  /// added it ("Slides · PPTX · 2 MB").
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

extension View {
  /// Presents the viewer's open attachment preview, kept in the workspace session's Store.
  func messageAttachmentPreview(viewer: MessageAttachmentStore) -> some View {
    modifier(MessageAttachmentPreviewPresentation(viewer: viewer))
  }
}

private struct MessageAttachmentPreviewPresentation: ViewModifier {
  let viewer: MessageAttachmentStore
  @ResolvedValue private var presentation: MessageAttachmentStore.Presentation?

  init(viewer: MessageAttachmentStore) {
    self.viewer = viewer
    _presentation = ResolvedValue(viewer.presentationValue)
  }

  func body(content: Content) -> some View {
    let isPresented = (presentation ?? viewer.presentation).preview != nil
    content.sheet(
      isPresented: Binding(get: { isPresented }, set: { if !$0 { viewer.dismiss() } })
    ) {
      MessageAttachmentPreview(viewer: viewer)
    }
  }
}

struct MessageAttachmentPreview: View {
  let viewer: MessageAttachmentStore

  var body: some View {
    StoreProvider(viewer.graph) { MessageAttachmentPreviewSheet(viewer: viewer) }
  }
}

private struct MessageAttachmentPreviewSheet: View {
  let viewer: MessageAttachmentStore
  @ResolvedValue private var presentation: MessageAttachmentStore.Presentation?

  init(viewer: MessageAttachmentStore) {
    self.viewer = viewer
    _presentation = ResolvedValue(viewer.presentationValue)
  }

  var body: some View {
    if let preview = (presentation ?? viewer.presentation).preview {
      StoreProvider(preview.store) {
        MessageAttachmentPreviewValue(preview: preview, dismiss: viewer.dismiss)
      }
      .id(preview.id)
    }
  }
}

private struct MessageAttachmentPreviewValue: View {
  let preview: MessageAttachmentPreviewResource
  let dismiss: () -> Void
  @LoadableValue private var download: Loadable<ChatAttachmentFile?>

  init(preview: MessageAttachmentPreviewResource, dismiss: @escaping () -> Void) {
    self.preview = preview
    self.dismiss = dismiss
    _download = LoadableValue(task: preview.file)
  }

  var body: some View {
    let artifact = ChatArtifact(
      source: .file(preview.attachment.downloadID), filename: preview.attachment.filename,
      contentType: preview.attachment.contentType, size: preview.attachment.size)
    let file = download.data ?? nil
    let failure = download.error
    MessagePreviewSheet(
      title: artifact.filename, dismiss: dismiss, isImage: artifact.kind == .image
    ) {
      MessageFilePreview(
        kind: artifact.kind, symbol: artifact.symbol, file: file,
        thumbnail: preview.thumbnail, error: failure.map(MessageAttachmentStore.message(for:)),
        canRetry: failure.map(ChatRequestFailure.canRetry) ?? true,
        retry: preview.retry)
    } actions: {
      if let file {
        ShareLink(item: file.url) { OkouToolbarIcon("share") }
          .accessibilityLabel("Share or save to Files")
      }
    }
  }
}
