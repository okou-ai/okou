import ChatData
import ChatDomain
import QuickLook
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
  @State private var quickLookURL: URL?
  @State private var retainedFile: ChatAttachmentFile?

  var body: some View {
    NavigationStack {
      if let preview = viewer.preview {
        Group {
          if let file = preview.file {
            let size = ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)
            let canPreview = QLPreviewController.canPreview(file.url as NSURL)
            OkouEmptyState(
              verbatim: preview.attachment.filename, icon: "file",
              description: canPreview
                ? Text(verbatim: size)
                : Text(verbatim: size) + Text(verbatim: " · ")
                  + Text(
                    "Preview is unavailable for this file type. Share it or save it to Files to open it in another app."
                  )
            ) {
              if canPreview {
                Button("Open preview") { quickLookURL = file.url }
                  .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
              }
              ShareLink(item: file.url) {
                Label("Share or save file", okouSymbol: "share")
              }
              .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
            }
          } else if let error = preview.error {
            OkouEmptyState(
              verbatim: preview.attachment.filename, icon: "file-warning",
              description: Text(error)
            ) {
              if preview.canRetry {
                Button("Retry download") { viewer.open(preview.attachment) }
                  .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
              }
            }
          } else {
            VStack(spacing: OkouSpace.lg) {
              if let thumbnail = preview.thumbnail {
                Image(uiImage: thumbnail).resizable().scaledToFit()
              }
              OkouLoadingRow("Opening attachment…").fixedSize()
            }
            .padding(OkouSpace.lg)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Attachment").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          OkouCloseToolbarItem { viewer.dismiss() }
        }
        .task(id: preview.file?.url) {
          if let file = preview.file, QLPreviewController.canPreview(file.url as NSURL) {
            retainedFile = file
            quickLookURL = file.url
          }
        }
      }
    }
    .quickLookPreview($quickLookURL)
  }
}
