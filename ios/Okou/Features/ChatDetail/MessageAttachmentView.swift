import ChatData
import ChatDomain
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct MessageAttachmentView: View {
  let attachment: ChatMessageAttachment
  let viewer: MessageAttachmentStore
  let loadsThumbnail: Bool
  @State private var thumbnail: UIImage?
  @State private var thumbnailMessage: String?
  private var thumbnailFailed: Bool { thumbnailMessage != nil }

  private var isMedia: Bool {
    attachment.contentType.hasPrefix("image/") || attachment.contentType.hasPrefix("video/")
  }

  var body: some View {
    Button {
      viewer.open(attachment)
    } label: {
      VStack(alignment: .leading, spacing: 8) {
        if isMedia {
          ZStack {
            Rectangle().fill(Color(.tertiarySystemFill))
            if let thumbnail {
              Image(uiImage: thumbnail).resizable().scaledToFit()
            } else if thumbnailFailed {
              if !attachment.contentType.hasPrefix("video/") {
                Image(systemName: "arrow.down.circle").font(.largeTitle).foregroundStyle(.secondary)
              }
            } else {
              ProgressView().accessibilityLabel("Loading thumbnail")
            }
            if attachment.contentType.hasPrefix("video/") {
              Image(systemName: "play.circle.fill").font(.largeTitle)
                .symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.5))
            }
            if let thumbnailMessage {
              VStack {
                Spacer()
                Text(thumbnailMessage).font(.caption).foregroundStyle(.secondary)
                  .multilineTextAlignment(.center).lineLimit(3).padding(12)
              }
            }
          }
          .frame(height: 150).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
        }
        HStack(spacing: 10) {
          if !isMedia { Image(systemName: "doc.fill").font(.title2).foregroundStyle(.secondary) }
          VStack(alignment: .leading, spacing: 3) {
            Text(attachment.filename).font(.subheadline.weight(.medium)).lineLimit(2)
            Text(metadata).font(.caption).foregroundStyle(.secondary).lineLimit(1)
          }
          Spacer(minLength: 0)
          Image(systemName: "arrow.up.forward").font(.caption).foregroundStyle(.secondary)
        }
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Preview \(attachment.filename)")
    .accessibilityHint(
      thumbnailMessage ?? metadata
    )
    .accessibilityIdentifier("message-attachment-\(attachment.id)")
    .task(id: loadsThumbnail ? attachment.downloadID : nil) {
      thumbnail = nil
      thumbnailMessage = nil
      guard loadsThumbnail, isMedia else { return }
      do {
        let data = try await viewer.thumbnail(attachment)
        guard !Task.isCancelled else { return }
        thumbnail = data.flatMap(UIImage.init(data:))
        thumbnailMessage = thumbnail == nil ? "Tap to download preview" : nil
      } catch {
        guard !Task.isCancelled else { return }
        thumbnailMessage = MessageAttachmentStore.message(for: error)
      }
    }
  }

  private var metadata: String {
    let type =
      UTType(mimeType: attachment.contentType)?.localizedDescription ?? attachment.contentType
    if let size = attachment.size {
      return "\(type) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))"
    }
    return type
  }
}

struct MessageAttachmentPreview: View {
  let viewer: MessageAttachmentStore
  @State private var quickLookURL: URL?
  @State private var retainedFile: ChatAttachmentFile?

  var body: some View {
    NavigationStack {
      if let preview = viewer.preview {
        VStack(spacing: 20) {
          if let file = preview.file {
            Image(systemName: "doc.fill").font(.system(size: 48)).foregroundStyle(.secondary)
            Text(preview.attachment.filename).font(.headline)
            Text(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))
              .foregroundStyle(.secondary)
            if QLPreviewController.canPreview(file.url as NSURL) {
              Button("Open preview") { quickLookURL = file.url }
                .buttonStyle(NeutralProminentButtonStyle())
            } else {
              Text(
                "Preview is unavailable for this file type. Share it or save it to Files to open it in another app."
              )
              .multilineTextAlignment(.center).foregroundStyle(.secondary)
            }
            ShareLink(item: file.url) {
              Label("Share or save file", systemImage: "square.and.arrow.up")
            }
            .buttonStyle(.bordered)
          } else if let error = preview.error {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(
              .secondary)
            Text(error).multilineTextAlignment(.center)
            Button("Retry download") { viewer.open(preview.attachment) }
              .buttonStyle(NeutralProminentButtonStyle())
          } else {
            ProgressView("Downloading attachment…")
            Text(preview.attachment.filename).font(.subheadline)
          }
        }
        .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("Attachment").navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { viewer.dismiss() } }
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
