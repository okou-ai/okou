import ChatData
import ChatDomain
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

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

  var body: some View {
    Button {
      viewer.open(attachment)
    } label: {
      VStack(alignment: .leading, spacing: OkouSpace.md) {
        if isMedia {
          ZStack {
            Rectangle().fill(OkouColor.stateHover)
            if let thumbnail {
              Image(uiImage: thumbnail).resizable().scaledToFit()
            } else if thumbnailFailed {
              if !attachment.contentType.hasPrefix("video/") {
                OkouIcon("circle-arrow-down", size: OkouIconSize.mediaOverlay).foregroundStyle(
                  OkouColor.mutedForeground)
              }
            } else {
              ProgressView().accessibilityLabel("Loading thumbnail")
            }
            if attachment.contentType.hasPrefix("video/") {
              OkouIcon("circle-play", size: OkouIconSize.mediaOverlay)
                .foregroundStyle(OkouMediaColor.foreground)
                .background(OkouMediaColor.scrim.opacity(0.5), in: Circle())
            }
            if let thumbnailMessage {
              VStack {
                Spacer()
                Text(thumbnailMessage).font(.okou(.caption)).foregroundStyle(
                  OkouColor.mutedForeground
                )
                .multilineTextAlignment(.center).lineLimit(3).padding(OkouSpace.md)
              }
            }
          }
          .frame(height: OkouControl.cardMediaHeight).clipped().clipShape(
            RoundedRectangle(cornerRadius: OkouRadius.control))
        }
        // The same heading and trailing chevron as a result card: a file in the transcript
        // reads the same whether the user or the agent added it.
        HStack(spacing: OkouSpace.sm) {
          ChatCardHeader(
            title: attachment.filename, icon: isMedia ? "image" : "file", titleLineLimit: 2
          ) {
            Text(metadata).lineLimit(1)
          }
          OkouIcon("chevron-right", size: OkouIconSize.inline)
            .foregroundStyle(OkouColor.mutedForeground)
        }
      }
      .padding(.horizontal, OkouSpace.lg)
      .padding(.vertical, OkouSpace.md)
      .frame(maxWidth: .infinity, alignment: .leading)
      .modifier(ChatCardSurface())
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Preview \(attachment.filename)")
    .accessibilityHint(
      thumbnailMessage ?? metadata
    )
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
            OkouLoadingRow("Downloading attachment…").fixedSize()
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
